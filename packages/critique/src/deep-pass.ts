import type { GeometryRect, PreviewBuildFact, Viewport } from "@apatureai/verdict-types";
import { cachePrefix } from "./cache.js";
import type { ModelClient, ModelImage, ModelMessage } from "./model.js";
import { wrapUntrustedPageContent } from "./prompt.js";
import {
  critiqueJsonSchema,
  parseCritiqueOutput,
  schemaInstruction,
  type CritiqueOutput,
} from "./schema.js";

/**
 * Deep critique pass (TRD §6.2/§6.5, #29): one request per route, capped at 3
 * concurrent, on the Qwen3-VL Thinking checkpoint. Because thinking and
 * structured output are mutually exclusive on DashScope (confirmed 2026-06-18),
 * each route is a TWO-STEP: (1) a Thinking critique (prose + reasoning), then
 * (2) a non-thinking `json_object` coercion of that prose to the schema (#31).
 * `max_tokens` is never set on the structured step. Self-host (#76) can do this
 * in one guided-decoding call. The pass never returns a partial: a route whose
 * coercion fails Zod contributes no findings rather than malformed output.
 */
export interface DeepPassRoute {
  route: string;
  /** Tiled, labeled, budget-fitted images for this route (#16/#17). */
  images: ModelImage[];
  /** Deterministic facts (contrast/overflow/touch-target, #19) rendered for the prompt. */
  facts?: string[];
  /**
   * The route's DOM geometry map (#18): the {selector, role, rect} entries the
   * model is told to cite as `element_ref` and that the hallucination gate (#32)
   * validates every finding against. Serialized into the prompt by
   * `renderGeometry` so the model's `element_ref` vocabulary is EXACTLY the set
   * the gate accepts, closing the gap where the prompt demanded selectors "from
   * the provided DOM geometry" the request never carried. Absent ⇒ no geometry
   * block (prompt byte-identical to the no-geometry case).
   */
  geometry?: GeometryRect[];
  /** Per-repo memory digest suffix (#41), optional. */
  feedbackDigest?: string;
  /**
   * Top-k UI-DNA genome rules retrieved for THIS route (#104): the resolved
   * design-system rules relevant to the route's components/diff. Trusted grounding
   * (from our resolved genome, not the page). Absent leaves the prompt unchanged.
   */
  genomeRules?: string[];
  /**
   * Untrusted DOM text extracted from the page (#53). Fenced in the
   * `untrusted_page_content` delimiter and governed by the data-not-instructions
   * rule in the system prompt, never treated as instructions.
   */
  pageText?: string;
}

export interface DeepPassDeps {
  client: ModelClient;
  model: string;
  /** The frozen system prompt (#30). */
  systemPrompt: string;
  /** Serialized deterministic context block (#63) placed under the prefix-cache boundary. */
  contextBlock: string;
  maxPixels: number;
  concurrency?: number;
  signal?: AbortSignal;
  /**
   * Serving path (#76). DashScope can't combine thinking + structured output, so
   * it uses the two-step (default). Self-host vLLM does single-call guided
   * decoding (thinking + json_schema in ONE request); set `guidedDecoding: true`.
   */
  guidedDecoding?: boolean;
  /**
   * PR-level build/runtime facts from Gate's preview-command supervisor (gate
   * #70 U1, #98). Rendered into every route's prompt as grounded build signals
   * (capped). Optional; absent leaves the prompt byte-identical.
   */
  buildFacts?: PreviewBuildFact[];
}

/** Cap on build facts rendered into a prompt, so a noisy boot log can't bloat it. */
export const MAX_BUILD_FACTS = 12;

/**
 * Render PR-level build/runtime facts (#98) as a clearly-labeled, capped,
 * deduped block of TRUSTED signals (they come from our own supervisor, not the
 * page, so they are facts, not fenced untrusted content). Returns "" when there
 * are none, keeping the prompt byte-identical to the no-facts case.
 */
export function renderBuildFacts(facts: PreviewBuildFact[] | undefined): string {
  if (!facts || facts.length === 0) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of facts) {
    const line = `- [${f.kind}] ${f.message}${f.source ? ` (${f.source})` : ""}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= MAX_BUILD_FACTS) break;
  }
  return `\nBuild/runtime signals (from the preview build; trusted facts):\n${lines.join("\n")}`;
}

/**
 * Render the route's retrieved UI-DNA genome rules (#104) as a labeled block of
 * TRUSTED design-system grounding (from the resolved genome, not the page).
 * Returns "" when there are none, keeping the prompt byte-identical.
 */
export function renderGenomeRules(rules: string[] | undefined): string {
  if (!rules || rules.length === 0) return "";
  return `\nDesign-system rules (UI-DNA; trusted):\n${rules.map((r) => `- ${r}`).join("\n")}`;
}

/**
 * Cap on geometry entries rendered into one route's prompt, a guard against a
 * pathological page. The curated map is landmarks + measured elements only
 * (`serializeGeometry` in `@apatureai/verdict-capture`), which is bounded in
 * practice (tens of entries per viewport), so this ceiling is not reached on any
 * real capture; it exists so an adversarial or degenerate DOM cannot bloat the
 * request. See `renderGeometry` for the truncation rule when it is reached.
 */
export const MAX_GEOMETRY_ENTRIES = 600;

/** Round a rect coordinate to a whole pixel; the gate keys on the selector, not the rect. */
function px(n: number): number {
  return Math.round(n);
}

/**
 * Render the route's DOM geometry map (#18) as a labeled block of TRUSTED
 * grounding: the `element_ref` selectors the model may cite, each with its ARIA
 * role and pixel rect, grouped by captured segment (viewport).
 *
 * This is the block whose absence was the bug: the system prompt instructs the
 * model to cite "the element_ref from the provided DOM geometry" and the
 * hallucination gate (#32) does an exact match against the same geometry map,
 * yet the request never carried the map — so the model's only selector
 * vocabulary was whatever appeared in the deterministic-fact lines, and any real
 * inferred selector it named was deleted by the gate. Serializing the map here
 * gives the model the exact selector set the gate accepts.
 *
 * SELECTION RULE (deterministic, lossless over selectors):
 *   - Every entry's selector is emitted. The gate accepts exactly these
 *     selectors, so dropping one would reintroduce the bug (the prompt would ask
 *     for a selector the gate rejects). The invariant the tests pin is therefore
 *     `selectors(renderGeometry(g)) ⊇ selectors(g)` — the rendered block is a
 *     superset of the gate-acceptable set for the route.
 *   - Entries are grouped by viewport in first-seen order and, within a viewport,
 *     kept in capture order (capture emits landmarks first, then measured
 *     elements), both deterministic given a deterministic capture.
 *   - The only bound is `MAX_GEOMETRY_ENTRIES`: if a map exceeds it, the input
 *     order is kept and the tail is dropped — documented degradation for a
 *     pathological page, never the default path.
 *
 * Returns "" for an empty/absent map, keeping the prompt byte-identical to the
 * no-geometry case.
 */
export function renderGeometry(geometry: GeometryRect[] | undefined): string {
  if (!geometry || geometry.length === 0) return "";
  const entries = geometry.length > MAX_GEOMETRY_ENTRIES ? geometry.slice(0, MAX_GEOMETRY_ENTRIES) : geometry;

  const order: Viewport[] = [];
  const byViewport = new Map<Viewport, GeometryRect[]>();
  for (const g of entries) {
    let bucket = byViewport.get(g.viewport);
    if (!bucket) {
      bucket = [];
      byViewport.set(g.viewport, bucket);
      order.push(g.viewport);
    }
    bucket.push(g);
  }

  const lines: string[] = [];
  for (const viewport of order) {
    lines.push(`[${viewport}]`);
    for (const g of byViewport.get(viewport) ?? []) {
      const role = g.role ?? "generic";
      const { x, y, width, height } = g.rect;
      lines.push(`- ${g.selector} (${role}) box ${px(x)},${px(y)} ${px(width)}x${px(height)}`);
    }
  }
  return (
    "\nDOM geometry (cite element_ref EXACTLY as written; segment = the [viewport] it appears under):\n" +
    lines.join("\n")
  );
}

export interface DeepPassRouteResult {
  route: string;
  /** Validated output, or null if the coercion failed (no partial emitted). */
  output: CritiqueOutput | null;
}

function thinkingMessages(deps: DeepPassDeps, route: DeepPassRoute): ModelMessage[] {
  const geometry = renderGeometry(route.geometry);
  const factLines = route.facts && route.facts.length > 0 ? `\nDeterministic facts:\n${route.facts.join("\n")}` : "";
  const buildFacts = renderBuildFacts(deps.buildFacts);
  const genomeRules = renderGenomeRules(route.genomeRules);
  const digest = route.feedbackDigest ? `\nRepo memory:\n${route.feedbackDigest}` : "";
  // Untrusted DOM text is fenced so the model can read it as page content but
  // never as instructions (#53); trusted facts stay outside the fence.
  const pageText = route.pageText ? `\nPage text (untrusted):\n${wrapUntrustedPageContent(route.pageText)}` : "";
  return [
    // Stable prefix first (context block) so prefix caching reuses it (#34).
    { role: "system", content: cachePrefix(deps.systemPrompt, deps.contextBlock) },
    {
      role: "user",
      content: `Review route ${route.route}. Cite segment labels + element_ref.${geometry}${factLines}${genomeRules}${buildFacts}${digest}${pageText}`,
      images: route.images,
    },
  ];
}

function coercionMessages(prose: string): ModelMessage[] {
  return [
    { role: "system", content: `Convert the review below into JSON.\n${schemaInstruction()}` },
    { role: "user", content: prose },
  ];
}

/** Two-step critique for a single route: Thinking prose -> json_object coercion -> Zod. */
export async function critiqueRouteTwoStep(
  deps: DeepPassDeps,
  route: DeepPassRoute,
): Promise<DeepPassRouteResult> {
  const opts = deps.signal ? { signal: deps.signal } : undefined;

  // Step 1: Thinking critique (prose + reasoning); no response_format.
  const thinking = await deps.client.complete(
    { model: deps.model, thinking: true, maxPixels: deps.maxPixels, messages: thinkingMessages(deps, route) },
    opts,
  );

  // Step 2: non-thinking json_object coercion of the prose (max_tokens never set).
  const coerced = await deps.client.complete(
    { model: deps.model, thinking: false, responseFormat: "json_object", messages: coercionMessages(thinking.text) },
    opts,
  );

  const parsed = parseCritiqueOutput(coerced.text);
  return { route: route.route, output: parsed.ok ? parsed.value : null };
}

/**
 * Single-call critique for one route on the self-host vLLM path (#76): ONE
 * request that combines the Thinking checkpoint with json_schema guided decoding,
 * so the output is schema-valid without the DashScope two-step. Same no-partial
 * contract: an output that fails Zod yields no findings rather than malformed JSON.
 */
export async function critiqueRouteSingleCall(
  deps: DeepPassDeps,
  route: DeepPassRoute,
): Promise<DeepPassRouteResult> {
  const opts = deps.signal ? { signal: deps.signal } : undefined;
  const res = await deps.client.complete(
    {
      model: deps.model,
      thinking: true,
      maxPixels: deps.maxPixels,
      responseFormat: "json_schema",
      jsonSchema: critiqueJsonSchema(),
      messages: thinkingMessages(deps, route),
    },
    opts,
  );
  const parsed = parseCritiqueOutput(res.text);
  return { route: route.route, output: parsed.ok ? parsed.value : null };
}

/** Dispatch one route to the configured serving path (two-step vs guided decoding). */
function critiqueRoute(deps: DeepPassDeps, route: DeepPassRoute): Promise<DeepPassRouteResult> {
  return deps.guidedDecoding ? critiqueRouteSingleCall(deps, route) : critiqueRouteTwoStep(deps, route);
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Deep pass over all routes: one request per route (two-step or guided), <=3 concurrent. */
export function runDeepPass(deps: DeepPassDeps, routes: DeepPassRoute[]): Promise<DeepPassRouteResult[]> {
  return mapWithConcurrency(routes, deps.concurrency ?? 3, (route) => critiqueRoute(deps, route));
}
