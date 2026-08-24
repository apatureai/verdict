import { allRoutesConfirmedUnchanged, hashesWithin } from "@apatureai/verdict-capture";
import type { BaselineChangeOptions, TileChangeScore } from "@apatureai/verdict-capture";
import { z } from "zod";
import type { ModelClient, ModelImage } from "./model.js";

/**
 * Triage pass (TRD §6.2, #28). A cheap `qwen3-vl-flash` look over above-the-fold
 * crops + palette + diff summary that decides whether a deep review is warranted,
 * and short-circuits when every captured route's perceptual hash matches the
 * cached baseline (#15/#34), posting a one-line "no design changes" result
 * without spending the deep pass. Emits `needsDeepReview`, `suspectRoutes`, and
 * `obviousBreakage` (overlap, unstyled HTML, broken images, overflow), folding
 * in the deterministic overflow/breakage facts (#19).
 */
export const TriageOutputSchema = z.object({
  needsDeepReview: z.boolean(),
  suspectRoutes: z.array(z.string()).default([]),
  obviousBreakage: z.array(z.string()).default([]),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export interface TriageRoute {
  route: string;
  /** Cached baseline perceptual hash (#34/#41), if any. */
  baselinePhash?: string;
  currentPhash: string;
  /**
   * Per-tile change-sensitive scores (#17 tiling, #89) used to CONFIRM a pHash
   * match before short-circuiting. A pHash match WITHOUT these (or with an
   * ambiguous score) fails open to a deep review. The worker computes them
   * (SSIM/pixel-diff); absent here in tests that don't exercise the confirm path.
   */
  tileScores?: readonly TileChangeScore[] | null;
  /** Above-the-fold crops for the triage look. */
  aboveFoldImages: ModelImage[];
  /** Deterministic breakage facts from #19 (e.g. overflow), if any. */
  deterministicBreakage?: string[];
}

export interface TriageDeps {
  client: ModelClient;
  model: string;
  /** Max phash hamming distance counted as a candidate match (default 5, matches #15). */
  phashThreshold?: number;
  /** Min per-tile SSIM to confirm a pHash match as unchanged (default ~0.99, #89). */
  ssimThreshold?: number;
  /** Max per-tile AA-aware pixel-diff ratio to confirm unchanged (default ~0.1%, #89). */
  diffRatioThreshold?: number;
  maxPixels?: number;
  /**
   * Request multimodal `json_object` on the triage call (default true). Set false
   * on generations whose multimodal structured-output support is unconfirmed
   * (e.g. qwen3.5, #87); the output is still defensively JSON-parsed and the pass
   * fails open, so disabling the hint never weakens correctness.
   */
  structuredOutput?: boolean;
  signal?: AbortSignal;
}

export interface TriageResult {
  needsDeepReview: boolean;
  suspectRoutes: string[];
  obviousBreakage: string[];
  /** True when the phash-vs-baseline short-circuit fired. */
  shortCircuited: boolean;
  summary: string;
}

const triageInstruction =
  "You are triaging a UI diff. Decide if a deep design review is warranted. " +
  'Respond with ONLY JSON: {"needsDeepReview": boolean, "suspectRoutes": string[], ' +
  '"obviousBreakage": string[]} where obviousBreakage lists overlap, unstyled HTML, ' +
  "broken images, or overflow you can see.";

/**
 * Cheap pHash PRE-FILTER only: whether every route has a baseline whose pHash
 * matches within threshold. A match here is NOT sufficient to short-circuit:
 * pHash is blind to small/localized changes (#89), so the triage gate confirms a
 * match with a tile-wise sensitive diff (`allRoutesConfirmedUnchanged`) before
 * concluding "unchanged". Retained for callers that want the raw pre-filter.
 */
export function allUnchanged(routes: TriageRoute[], threshold: number): boolean {
  return (
    routes.length > 0 &&
    routes.every((r) => r.baselinePhash !== undefined && hashesWithin(r.baselinePhash, r.currentPhash, threshold))
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Run the triage pass, short-circuiting only when every route is positively
 * confirmed unchanged: pHash match (cheap pre-filter) AND a tile-wise
 * change-sensitive diff below threshold (#89). A pHash match alone, which is
 * blind to small color/text/spacing changes, never short-circuits; missing or
 * ambiguous sensitive-diff input fails open to a deep review.
 */
export async function runTriage(deps: TriageDeps, routes: TriageRoute[]): Promise<TriageResult> {
  const changeOptions: BaselineChangeOptions = {
    phashThreshold: deps.phashThreshold ?? 5,
    ...(deps.ssimThreshold !== undefined ? { ssimThreshold: deps.ssimThreshold } : {}),
    ...(deps.diffRatioThreshold !== undefined ? { diffRatioThreshold: deps.diffRatioThreshold } : {}),
  };

  if (allRoutesConfirmedUnchanged(routes, changeOptions)) {
    return {
      needsDeepReview: false,
      suspectRoutes: [],
      obviousBreakage: [],
      shortCircuited: true,
      summary: "No design changes detected (perceptual hash + tile-wise diff confirm the baseline).",
    };
  }

  const deterministic = dedupe(routes.flatMap((r) => r.deterministicBreakage ?? []));
  const images = routes.flatMap((r) => r.aboveFoldImages);
  const response = await deps.client.complete(
    {
      model: deps.model,
      thinking: false,
      responseFormat: deps.structuredOutput === false ? undefined : "json_object",
      maxPixels: deps.maxPixels,
      messages: [
        { role: "system", content: triageInstruction },
        { role: "user", content: `Routes: ${routes.map((r) => r.route).join(", ")}`, images },
      ],
    },
    deps.signal ? { signal: deps.signal } : undefined,
  );

  let parsed: TriageOutput | null;
  try {
    parsed = TriageOutputSchema.parse(JSON.parse(response.text));
  } catch {
    parsed = null;
  }

  // Deterministic breakage (#19) always counts, even if the model missed it.
  const obviousBreakage = dedupe([...(parsed?.obviousBreakage ?? []), ...deterministic]);
  const needsDeepReview = parsed?.needsDeepReview ?? true; // fail open: review when unsure
  // A route with measured breakage is suspect by definition, so it is added to
  // whatever the model named. Overruling `needsDeepReview` alone was not enough:
  // a model answering `{"needsDeepReview": false, "suspectRoutes": []}` over a
  // page with a measured overflow produced a run that demanded a deep review and
  // then had no route to run it on, which the orchestrator correctly reports as
  // "triage named no routes" and nothing gets judged. The measurement names the
  // route; that is the whole point of having measured it.
  const breakageRoutes = routes.filter((r) => (r.deterministicBreakage ?? []).length > 0).map((r) => r.route);
  const suspectRoutes = dedupe([...(parsed?.suspectRoutes ?? routes.map((r) => r.route)), ...breakageRoutes]);

  return {
    needsDeepReview: needsDeepReview || obviousBreakage.length > 0,
    suspectRoutes,
    obviousBreakage,
    shortCircuited: false,
    summary: needsDeepReview
      ? "Deep review warranted."
      : obviousBreakage.length > 0
        ? "Deep review warranted: breakage measured on the captured page."
        : "Triage found no issues warranting a deep review.",
  };
}
