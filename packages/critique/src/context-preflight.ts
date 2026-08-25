import type { GeometryBudget } from "./deep-pass.js";

/**
 * Context-window preflight (C2). A prompt that, together with the model's expected
 * completion, exceeds the endpoint's context window is NOT a hard error at the
 * transport — ollama silently context-SHIFTS, evicting the oldest tokens (here,
 * part of the geometry map) mid-generation. The judge then reviews a page whose
 * map it can no longer see, and the run looks like a bad judge instead of a blown
 * budget. That confound wasted a full measurement: the unlock grew the prompt to
 * ~10,075 tokens against a 12,288-token window, and a 21,398-token call (prompt
 * 9,456 + completion 11,942, 1.74x the window) shifted the map out.
 *
 * So before a call, we ESTIMATE prompt + expected completion against the window
 * (advertised by the endpoint where queryable, else explicitly configured) and
 * either DEGRADE deterministically — shrinking the geometry budget through
 * documented tiers, then dropping the map — or FAIL LOUDLY when even a map-free
 * prompt cannot fit. Never silently truncate. All pure and deterministic; the
 * estimators bias toward OVER-counting so the safe direction is the default.
 */

/** Thrown when prompt + expected completion cannot fit the window even without the map (C2). */
export class ContextBudgetError extends Error {
  constructor(
    message: string,
    readonly detail: { promptTokensMapFree: number; completionReserveTokens: number; contextWindow: number },
  ) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

/**
 * ~4 chars per token: a coarse, model-agnostic upper-ish estimate for prose/JSON.
 * Deliberately simple and slightly generous — the preflight must err toward
 * degrading, never toward a false "it fits".
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Qwen3-VL image-token estimate for a budget-fitted tile: ~one token per 28x28px
 * block, so a per-tile `max_pixels` budget is ~`max_pixels / 784` tokens. Summed
 * over the route's tiles. This mirrors `estimateQwenImageTokens` but works from the
 * pixel BUDGET (known before the image is resolved), not the resolved PNG.
 */
export function estimateImageTokens(imageCount: number, maxPixels: number): number {
  if (imageCount <= 0 || maxPixels <= 0) return 0;
  return imageCount * Math.ceil(maxPixels / (28 * 28));
}

/**
 * The documented geometry-shrink tiers, in chars-per-viewport, from the module
 * default down. The preflight walks these in order and picks the first whose
 * rendered prompt fits; the per-request cap keeps its 3x ratio to the per-viewport
 * cap (the module default is 18000/6000).
 */
export const GEOMETRY_DEGRADE_TIERS: readonly number[] = [6_000, 4_000, 2_500, 1_500];

/** Default tokens reserved for the (large, Thinking) completion; override per endpoint. */
export const DEFAULT_COMPLETION_RESERVE_TOKENS = 8_192;

function budgetForTier(charsPerViewport: number): GeometryBudget {
  return { maxCharsPerViewport: charsPerViewport, maxCharsPerRequest: charsPerViewport * 3 };
}

/** The documented "drop the map" degrade: a whole, absent geometry block. */
const DROP_GEOMETRY_BUDGET: GeometryBudget = { maxCharsPerViewport: 0, maxEntriesPerViewport: 0 };

export interface ResolveGeometryBudgetInput {
  /** The endpoint's advertised context window in tokens (queried or configured). */
  contextWindow: number;
  /** Tokens to reserve for the completion (expected, not observed). */
  completionReserveTokens: number;
  /** Estimated image tokens in the prompt (from the pixel budget). */
  imageTokens: number;
  /** Render the FULL prompt text (system + user, geometry + census + facts …) for a budget. */
  renderPromptText: (budget: GeometryBudget | undefined) => string;
}

export interface GeometryBudgetDecision {
  /** The resolved budget, or `undefined` when the full prompt fits (no degrade). */
  budget: GeometryBudget | undefined;
  /** How the decision was reached, for the run log. */
  mode: "fits" | "degraded" | "map_dropped";
  /** The chosen tier's chars-per-viewport, when degraded (not map-dropped). */
  charsPerViewport?: number;
  /** Estimated total tokens (prompt + reserve) at the chosen budget. */
  estimatedTotalTokens: number;
}

/**
 * Resolve the largest geometry budget whose prompt + reserved completion fits the
 * window (C2). Order: the full prompt, then each `GEOMETRY_DEGRADE_TIERS` step,
 * then the map dropped entirely. Throws `ContextBudgetError` when even the map-free
 * prompt overflows — the loud failure that says "this endpoint's window is too
 * small for this review; use a larger-context variant (e.g. qwen3vl-32k)".
 */
export function resolveGeometryBudgetDecision(input: ResolveGeometryBudgetInput): GeometryBudgetDecision {
  const { contextWindow, completionReserveTokens, imageTokens, renderPromptText } = input;
  const totalFor = (budget: GeometryBudget | undefined): number =>
    estimateTextTokens(renderPromptText(budget)) + imageTokens + completionReserveTokens;

  const full = totalFor(undefined);
  if (full <= contextWindow) return { budget: undefined, mode: "fits", estimatedTotalTokens: full };

  for (const tier of GEOMETRY_DEGRADE_TIERS) {
    const budget = budgetForTier(tier);
    const total = totalFor(budget);
    if (total <= contextWindow) {
      return { budget, mode: "degraded", charsPerViewport: tier, estimatedTotalTokens: total };
    }
  }

  const dropped = totalFor(DROP_GEOMETRY_BUDGET);
  if (dropped <= contextWindow) {
    return { budget: DROP_GEOMETRY_BUDGET, mode: "map_dropped", estimatedTotalTokens: dropped };
  }

  throw new ContextBudgetError(
    `Deep-pass prompt does not fit the endpoint context window even with the DOM geometry map dropped: ` +
      `~${dropped} tokens (image + text + ${completionReserveTokens} reserved for the completion) > ${contextWindow}. ` +
      `Silently sending it would context-shift and evict part of the prompt mid-generation. ` +
      `Use a larger-context endpoint (e.g. qwen3vl-32k) or lower the image budget / completion reserve.`,
    { promptTokensMapFree: dropped - completionReserveTokens, completionReserveTokens, contextWindow },
  );
}

/** Convenience: just the resolved budget (or undefined). Throws `ContextBudgetError` (fail loud). */
export function resolveGeometryBudget(input: ResolveGeometryBudgetInput): GeometryBudget | undefined {
  return resolveGeometryBudgetDecision(input).budget;
}
