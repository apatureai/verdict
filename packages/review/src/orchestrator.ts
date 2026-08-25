import { PIXEL_BUDGETS, pageHealthFootnote } from "@apatureai/verdict-capture";
import type {
  CalibrationRuntimeBinding,
  CaptureContext,
  CaptureImage,
  CaptureInSandbox,
  ConfidenceUnavailableReason,
  GeometryRect,
  MeasurementReport,
  ReviewCoverage,
  WireViewport,
} from "@apatureai/verdict-types";
import {
  buildContextBlock,
  retrieveGenomeRules,
  type ContextBlockInput,
  type Embedder,
  type GenomeIndex,
} from "@apatureai/verdict-context";
import {
  assembleCritique,
  backendUsesGuidedDecoding,
  buildSystemPrompt,
  citableSelectors,
  resolvePassModel,
  runDeepPass,
  runTriage,
  toEngineReviewResult,
  defaultModelFactory,
  type DeepPassRoute,
  type ModelClientFactory,
  type PassModelOverrides,
  type TriageRoute,
  type WireProjectionOptions,
} from "@apatureai/verdict-critique";
import type { ModelImage, FactLedger, GeometryBudget } from "@apatureai/verdict-critique";
import type { Critique, EngineReviewResult, PreviewBuildFact } from "@apatureai/verdict-types";

/**
 * End-to-end review orchestrator (TRD §6, #109): the keystone that composes the
 * engine's individually-built, individually-tested pure pieces into ONE review
 * pipeline. Until this, nothing sequenced them: the async job API shipped the
 * EM0 `defaultProcessor` stub whose comment promised "EM2 replaces this with the
 * real capture + critique pipeline".
 *
 * The flow (each stage's real API verified, see imports):
 *   buildContextBlock (#63) + optional genome index (#104)
 *     -> captureInSandbox (#11/#22 live seam, INJECTED)
 *     -> runTriage (#28): short-circuit to "no design changes" when unchanged
 *     -> else runDeepPass (#29) over the suspect routes, threading deterministic
 *        facts (#19), retrieved genome rules (#104), and build facts (#98)
 *     -> assembleCritique (#106): the global validation tail (gate #32 / ceiling
 *        #70 / post-filter #33 / reconcileGrade / version stamp #68)
 *     -> toEngineReviewResult: the cross-repo wire projection.
 *
 * EVERY live I/O is injected: the model client factory, the capture sandbox seam,
 * and the genome embedder. In tests these are stubs + the mock model, and a real
 * model / sandbox / browser / GPU is NEVER called. Pure + deterministic given
 * deterministic deps; the output is byte-compatible with the Gate golden wire
 * fixture shape.
 */

/** Per-route inputs the orchestrator threads into capture + triage + the deep pass. */
export interface ReviewRoute {
  /** Route path, e.g. "/pricing". */
  route: string;
  /**
   * Cached baseline perceptual hash (#34/#41), if any.
   *
   * NOT POPULATED ON ANY SHIPPED SURFACE. Both front doors onto this
   * orchestrator (`@apatureai/verdict-cli` and `@apatureai/verdict-serve`) run one capture in one
   * process and hold no record of a previous one, so there is no baseline to
   * pass. The field is real and the code behind it is real and tested; what does
   * not exist is a baseline store keyed by (repo, route, viewport) with a
   * retention and invalidation policy. Until that exists, the triage
   * short-circuit below is unreachable in production and every local run pays
   * for a triage model call it could sometimes have skipped.
   */
  baselinePhash?: string;
  /** Current perceptual hash from this capture. */
  currentPhash?: string;
  /**
   * Per-tile change-sensitive scores (#17/#89) used to CONFIRM a pHash match
   * before the triage short-circuit. Absent ⇒ a pHash match alone can't
   * short-circuit (fails open to a deep review).
   *
   * NOT POPULATED ON ANY SHIPPED SURFACE either, and for the same reason: a tile
   * score is a comparison against a baseline image nothing here has kept. See
   * `baselinePhash`.
   */
  tileScores?: TriageRoute["tileScores"];
  /**
   * Deterministic breakage facts (#19); forces a deep review when present, and
   * makes the route suspect so the deep review has somewhere to run.
   *
   * Unlike the two fields above this one needs no baseline: it is measured from
   * THIS capture alone, so both shipped surfaces populate it from the capture's
   * own deterministic findings (`breakageForRoute`).
   */
  deterministicBreakage?: string[];
  /** Deterministic facts (contrast/overflow/touch-target/page-overflow, #19) for the deep prompt's ALREADY-REPORTED block. */
  facts?: string[];
  /**
   * Measurements the checker DECLINED (judge-unlock §3.3/§4.1) for the deep
   * prompt's MEASURED-AND-DECLINED block: the model's territory, where a finding
   * on a WCAG-excused element is net-new. Built by the caller via `declinedForRoute`.
   */
  declinedFacts?: string[];
  /** Untrusted page DOM text (#53), fenced in the deep prompt. */
  pageText?: string;
  /** Per-repo memory digest suffix (#41). */
  feedbackDigest?: string;
}

/** Live I/O seams, all injected so the orchestrator is fully testable with stubs. */
export interface ReviewDeps {
  /**
   * The capture seam (#11/#22). `createBrowserCapture` from `@apatureai/verdict-capture`
   * is the live Chromium implementation; tests inject a stub.
   */
  captureInSandbox: CaptureInSandbox;
  /** Per-pass model client factory (#27). Tests pass the mock model. */
  modelFactory?: ModelClientFactory;
  /** Per-pass model config overrides (model id / backend / thinking). */
  passModels?: PassModelOverrides;
  /**
   * Resolved UI-DNA genome index (#104), prebuilt by the caller via
   * `buildGenomeIndex(version, rules, embedder)`. Absent ⇒ no genome grounding
   * (the deep prompt is byte-identical to the no-genome case).
   */
  genomeIndex?: GenomeIndex;
  /** Embedder for the per-route genome query (#104); required iff `genomeIndex` is set. */
  embedder?: Embedder;
  /** Cooperative-cancellation signal (#66) threaded into every model call. */
  signal?: AbortSignal;
  /** Validated promoted report projection; absent means advisory/no display score. */
  calibration?: CalibrationRuntimeBinding;
  confidenceUnavailableReason?: ConfidenceUnavailableReason;
  /**
   * Observer for the assembled internal `Critique`, called once immediately
   * before the wire projection drops the internal-only fields, so a metrics
   * emitter (or a CLI) can read the full internal form. The drop count itself is
   * no longer confined to this seam: `validation.hallucinationDrops` (#32) is
   * both an SLO input here and a field on the wire result, because a consumer
   * holding only the result must be able to tell a clean page from findings that
   * could not be grounded. Never mutates the result; throwing from it is the
   * caller's problem, not the review's.
   */
  onCritique?: (critique: Critique) => void;
}

export interface ReviewInput {
  /** The preview URL to capture. */
  url: string;
  /** Review depth (triage vs deep budget/model). */
  depth: "triage" | "deep";
  /** Context-block inputs (#63): tokens, brand, component libs, uiDnaVersion, routes. */
  context: ContextBlockInput;
  /** Capture context (#4): viewports, dark mode, auth/fork flags, routes. */
  captureContext: CaptureContext;
  /** Per-route triage/deep inputs (baseline hashes, facts, page text). */
  routes: ReviewRoute[];
  /**
   * What the capture MEASURED, grouped for the wire (`toMeasurementReport`).
   *
   * Supplied by the caller and never derived here: the deterministic checks run
   * during capture, and this stage holds only their output. Absent means this
   * caller does not report measurements, which is why it is threaded rather than
   * defaulted to an empty report; an empty report is the positive claim that the
   * checks ran and found nothing.
   *
   * It never touches the grade. It is published on the result, and it is one
   * input to `gradeUnavailableReason`, which WITHHOLDS a grade rather than
   * computing one.
   */
  measurements?: MeasurementReport;
  /** PR-level build/runtime facts from Gate's preview supervisor (#98). */
  previewBuildFacts?: PreviewBuildFact[];
  /**
   * Engine-side not-reviewed reasons to carry through (fork skip, off-domain,
   * routes with no preview deployment). Surfaced in the wire result verbatim.
   */
  notReviewed?: string[];
  /**
   * The routes the CONFIG asked for, when that differs from the routes capture
   * was handed. Defaults to `captureContext.routes`.
   *
   * The two diverge wherever the runtime narrows the ask before capture, and the
   * only such place today is the `routes.max_per_pr` cap. Reporting the narrowed
   * list as the ask made a truncated run read as complete: eight configured
   * routes, five captured, and a result that stated "5 of 5 routes reviewed".
   * Coverage exists to say what the pipeline did against what was asked of it,
   * so the ask has to be the ask.
   */
  requestedRoutes?: string[];
  /** Explicit instability supplied by an upstream capture adapter. */
  captureUnstable?: boolean;
  /** Wire-projection seams: screenshot-id/artifact-URL resolution + retention (#51). */
  wireOptions: WireProjectionOptions;
  /** Self-host single-call guided decoding (#76) instead of the DashScope two-step. */
  guidedDecoding?: boolean;
  /** Max concurrent deep-pass routes (#29, default 3). */
  concurrency?: number;
  /**
   * The deep-pass endpoint's advertised context window in tokens (C2). When set,
   * every route runs the context-window preflight: the deep prompt's geometry map
   * is degraded deterministically (or the run fails loudly) rather than letting the
   * endpoint silently context-shift and evict part of the map mid-generation. The
   * grounding gate's accept set is then derived at whatever budget the preflight
   * chose, so a degraded prompt is never stricter than the gate. Absent ⇒ no
   * preflight (the prompt is byte-identical), for callers whose window comfortably
   * fits the prompt or who have not configured it.
   */
  contextWindow?: number;
  /** Tokens reserved for the (large, Thinking) completion in the preflight; default per endpoint. */
  completionReserveTokens?: number;
  /**
   * The deterministic fact ledger (judge-unlock §4.1), built ONCE by the caller
   * from the same deterministic + declined findings that produced the route
   * facts. Threaded to `assembleCritique` to run the duplicate-of-measurement
   * gate. Absent ⇒ the gate is a no-op (byte-identical to before), which is what
   * a caller that has not adopted the ledger gets.
   */
  factLedger?: FactLedger;
}

/**
 * Build the frozen system prompt for this review from the resolved repo context.
 *
 * The rubric, the grounding rules and the instruction-hierarchy defense against
 * prompt injection all live in `buildSystemPrompt` (`@apatureai/verdict-critique`); the
 * orchestrator's job is only to derive its two inputs from the context block, so
 * both stay in lockstep: the brand dimension is scored exactly when a brand block
 * was extracted, and every detected component library contributes its rubric
 * addendum. Deterministic: the same context yields the same prompt bytes, which
 * is what keeps the prefix cache warm.
 */
export function reviewSystemPrompt(context: ContextBlockInput): string {
  const componentAddenda = context.componentLibraries
    .map((library) => library.rubricAddendum)
    .filter((addendum) => addendum.trim().length > 0);
  return buildSystemPrompt({
    brandPresent: context.brand !== null,
    ...(componentAddenda.length > 0 ? { componentAddenda } : {}),
  });
}

/**
 * The grounding gate's `element_ref` accept set (#18/#32). Derived from
 * `citableSelectors` — the SAME per-route plan the deep prompt renders — not from
 * the raw `capture.geometry`. A budget-omitted selector (one no route's prompt
 * could show) is therefore NOT accepted, so the prompt is never silently stricter
 * than the gate (C3). Grouped by route so each route's citable set matches exactly
 * what that route's prompt rendered (each deep route renders `geometryForRoute`).
 */
function citableAcceptSet(geometry: GeometryRect[], budgetByRoute?: Map<string, GeometryBudget>): Set<string> {
  const byRoute = new Map<string, GeometryRect[]>();
  for (const g of geometry) {
    let bucket = byRoute.get(g.route);
    if (!bucket) {
      bucket = [];
      byRoute.set(g.route, bucket);
    }
    bucket.push(g);
  }
  const out = new Set<string>();
  for (const [route, group] of byRoute) {
    // Each route's citable set is computed at the SAME budget the preflight (C2)
    // rendered that route's prompt at, so the gate never accepts a selector the
    // degraded prompt could not show.
    const budget = budgetByRoute?.get(route);
    for (const selector of citableSelectors(group, budget)) out.add(selector);
  }
  return out;
}

/**
 * The geometry entries captured for one route (#18), rendered into that route's
 * deep prompt as the citable `element_ref` map. Passing the SAME `capture.geometry`
 * that builds the hallucination gate's accept set (below) is what keeps the
 * prompt and the gate in lockstep: every selector the gate will accept for this
 * route is a selector the model was shown, so it cites real selectors instead of
 * pixel-inferred ones the gate then deletes (#W1-02).
 */
function geometryForRoute(route: string, geometry: GeometryRect[]): GeometryRect[] {
  return geometry.filter((g) => g.route === route);
}

/** All captured route ids; the hallucination gate (#32) drops findings off these. */
function capturedRoutes(images: CaptureImage[]): string[] {
  return [...new Set(images.map((i) => i.route))];
}

/**
 * The routes the run was ASKED for, which is `requestedRoutes` when the caller
 * narrowed the ask before capture and `captureContext.routes` otherwise.
 *
 * Every caller that does not narrow anything gets the previous behaviour
 * unchanged, so a coverage claim can only ever widen here, never shrink.
 */
function requestedRoutesOf(input: ReviewInput): string[] {
  return input.requestedRoutes ?? input.captureContext.routes;
}

/**
 * State what this run actually looked at (#165).
 *
 * Built from observations, never from configuration: `routesRequested` and
 * `viewportsRequested` are the ask, and everything else is what happened to it.
 * A route counts as REVIEWED when this run reached a judgment about it, which is
 * true on exactly two paths:
 *
 *   - the triage short-circuit, where every captured route was positively
 *     confirmed unchanged against a reviewed baseline (pHash match confirmed by
 *     a tile-wise sensitive diff): that is a conclusion about the route, so the
 *     captured routes are reviewed; and
 *   - the deep path, where a route was captured and its critique either came
 *     back valid or was never needed because triage cleared it. A suspect route
 *     whose deep-pass output failed coercion (`output: null`) is NOT reviewed:
 *     nothing survived to judge it with, and `assembleCritique` already records
 *     it in `notReviewed` as "<route>: no valid critique".
 *
 * "Triage cleared it" is a real judgment ONLY when triage named the routes it
 * did suspect. A triage response that asks for a deep review and then names no
 * route at all clears nothing: no deep pass runs, no page is looked at, and
 * counting those routes as reviewed reported full coverage over zero judgments
 * (`success / Ship`, empty narrative, "2 of 2 routes reviewed"). That takes no
 * adversary, only a model having an off day, so the reviewed set is built from
 * the deep passes that actually returned plus the routes triage explicitly did
 * not suspect, and the routes left over are named in `notReviewed` with the
 * reason.
 *
 * A route with no captured image is never reviewed, so an empty capture yields
 * an empty `routesReviewed`, which is the honest statement that this run judged
 * nothing at all.
 *
 * Viewports are reported per reviewed route: a viewport is only ever looked at
 * as part of a route, so viewports of a route that was not reviewed are not
 * reviewed either.
 */
function buildCoverage(args: {
  requestedRoutes: string[];
  requestedViewports: WireViewport[];
  reviewedRoutes: string[];
  images: CaptureImage[];
}): ReviewCoverage {
  const reviewed = new Set(args.reviewedRoutes);
  return {
    routesRequested: [...new Set(args.requestedRoutes)],
    routesReviewed: [...new Set(args.reviewedRoutes)],
    viewportsRequested: [...new Set(args.requestedViewports)],
    viewportsReviewed: [
      ...new Set(args.images.filter((i) => reviewed.has(i.route)).map((i) => i.viewport)),
    ],
  };
}

/** Project captured images for one route into the model-image shape (#16/#17 seam). */
function modelImagesFor(route: string, images: CaptureImage[]): ModelImage[] {
  return images
    .filter((i) => i.route === route)
    .map((i) => ({ objectKey: i.objectKey, route: i.route, viewport: i.viewport }));
}

/**
 * Run one end-to-end review. Pure given deterministic deps. Sequences context →
 * capture → triage → (deep pass | short-circuit) → assemble → wire projection.
 */
export async function runReview(input: ReviewInput, deps: ReviewDeps): Promise<EngineReviewResult> {
  const modelFactory = deps.modelFactory ?? defaultModelFactory;
  const maxPixels = PIXEL_BUDGETS[input.depth];

  // 1. Resolve the deterministic, content-hashed context block (#63). It's the
  //    prefix-cache anchor placed first in the deep prompt; the genome index
  //    (#104) is resolved by the caller and injected.
  const contextBlock = buildContextBlock(input.context);

  // 2. Capture (#11, injected). Chromium in `@apatureai/verdict-capture` is the live
  //    implementation; tests inject a stub so this composes without a browser.
  const capture = await deps.captureInSandbox(input.url, input.captureContext);

  // A capture that produced no images can't ground any finding, so short out to a
  // clean "nothing reviewed" result rather than running the model on nothing.
  if (capture.images.length === 0) {
    return emptyFindingsResult(input, deps, capture.captureVersion, {
      extraNotReviewed: ["no captured routes"],
      // Nothing was captured, so no check ran on anything. A caller that
      // reports measurements at all still says so, with the empty `checksRun`
      // that means "nothing measured" rather than "measured, clean". A caller
      // that reports none keeps saying nothing.
      ...(input.measurements ? { measurements: { checksRun: [], violations: [] } } : {}),
      // Nothing was captured, so nothing was reviewed. The grade this result
      // still carries is `ship` by construction, and coverage is what tells a
      // consumer not to publish it as one.
      coverage: buildCoverage({
        requestedRoutes: requestedRoutesOf(input),
        requestedViewports: input.captureContext.viewports,
        reviewedRoutes: [],
        images: [],
      }),
    });
  }

  // 3. Triage (#28). Short-circuits (no deep model call) when every captured
  //    route is positively confirmed unchanged (pHash match + tile-wise diff).
  const triageRoutes: TriageRoute[] = input.routes.map((r) => ({
    route: r.route,
    ...(r.baselinePhash !== undefined ? { baselinePhash: r.baselinePhash } : {}),
    currentPhash: r.currentPhash ?? "",
    ...(r.tileScores !== undefined ? { tileScores: r.tileScores } : {}),
    aboveFoldImages: modelImagesFor(r.route, capture.images),
    ...(r.deterministicBreakage !== undefined ? { deterministicBreakage: r.deterministicBreakage } : {}),
  }));

  const triageConfig = resolvePassModel("triage", deps.passModels);
  const triage = await runTriage(
    {
      client: modelFactory(triageConfig),
      model: triageConfig.model,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    triageRoutes,
  );

  const deepConfig = resolvePassModel("deep", deps.passModels);

  // 3a. Short-circuit: no deep pass. Two different runs exit here and only one
  //     of them judged anything, so the exit branches on the FACT triage
  //     reports (`shortCircuited`) rather than on the inference "it declined a
  //     deep review, so the page must be fine".
  //
  //     `shortCircuited: true` is the baseline path: every captured route had a
  //     recorded baseline, its pHash matched, and a tile-wise sensitive diff
  //     confirmed the match. Unchanged-since-a-real-baseline is a conclusion
  //     ABOUT the route, so those routes are reviewed.
  //
  //     `shortCircuited: false` is the model path: triage had no baseline to
  //     compare against (the CLI and the server never populate one) and the
  //     model simply answered `{"needsDeepReview": false}`. Nothing was compared
  //     to anything and no pass looked at the page, so no captured route is
  //     reviewed, and each one says why in `notReviewed`. Without this the run
  //     published `grade: ship`, `findings: 0` and FULL coverage over zero
  //     reviews, which is the one shape coverage exists to make impossible.
  if (!triage.needsDeepReview) {
    const judgedByTriage = triage.shortCircuited;
    return emptyFindingsResult(input, deps, capture.captureVersion, {
      overall: triage.summary,
      ...(judgedByTriage
        ? {}
        : {
            extraNotReviewed: capturedRoutes(capture.images).map(
              (route) =>
                `${route}: triage answered that no deep review was needed, but this run carried no ` +
                `baseline for the route, so nothing was compared against anything and no pass judged ` +
                `this page. Record a baseline for this route so an unchanged answer is a real ` +
                `comparison, or re-run the review.`,
            ),
          }),
      coverage: buildCoverage({
        requestedRoutes: requestedRoutesOf(input),
        requestedViewports: input.captureContext.viewports,
        reviewedRoutes: judgedByTriage ? capturedRoutes(capture.images) : [],
        images: capture.images,
      }),
      // Unlike the empty-capture branch above, the pages here WERE captured and
      // the checks did run on them, so what they measured is reported as it is.
      // A short-circuit skips the deep model, not the DOM.
      ...(input.measurements ? { measurements: input.measurements } : {}),
    });
  }

  // 4. Deep pass (#29) over the SUSPECT routes only. Thread the route's
  //    deterministic facts (#19), retrieved genome rules (#104), build facts
  //    (#98), page text (#53), and feedback digest (#41).
  const suspect = new Set(triage.suspectRoutes);
  const routesToReview = input.routes.filter((r) => suspect.has(r.route));
  const byRoute = new Map(input.routes.map((r) => [r.route, r]));

  // Routes we'll actually deep-review (have a captured image), in deterministic order.
  const reviewable = routesToReview.filter((r) => modelImagesFor(r.route, capture.images).length > 0);

  // Batch the genome retrieval: embed every route's query in ONE embedder call
  // (the Embedder takes a batch), then rank per route against the prebuilt index.
  // Identical result to embedding each query separately, just one round-trip on
  // the critical path instead of N serial ones (#113). Determinism preserved.
  const genomeRulesByRoute = await selectGenomeRulesBatched(reviewable, deps);

  const deepRoutes: DeepPassRoute[] = [];
  for (const r of reviewable) {
    const images = modelImagesFor(r.route, capture.images);
    const cfg = byRoute.get(r.route);
    const genomeRules = genomeRulesByRoute.get(r.route) ?? [];
    const geometry = geometryForRoute(r.route, capture.geometry);
    deepRoutes.push({
      route: r.route,
      images,
      ...(geometry.length > 0 ? { geometry } : {}),
      ...(cfg?.facts && cfg.facts.length > 0 ? { facts: cfg.facts } : {}),
      ...(cfg?.declinedFacts && cfg.declinedFacts.length > 0 ? { declinedFacts: cfg.declinedFacts } : {}),
      ...(genomeRules.length > 0 ? { genomeRules } : {}),
      ...(cfg?.pageText ? { pageText: cfg.pageText } : {}),
      ...(cfg?.feedbackDigest ? { feedbackDigest: cfg.feedbackDigest } : {}),
    });
  }

  const deepResults = await runDeepPass(
    {
      client: modelFactory(deepConfig),
      model: deepConfig.model,
      systemPrompt: reviewSystemPrompt(input.context),
      contextBlock: contextBlock.serialized,
      maxPixels,
      concurrency: input.concurrency ?? 3,
      // The deep-pass path (single guided call vs the DashScope two-step) follows
      // the resolved deep backend's capability profile unless the caller forces
      // it. This is what makes MODEL_BACKEND control the path on EVERY surface:
      // the backend is resolved here, on the one code path all surfaces share, so
      // a self-host/vLLM/ollama endpoint gets single-call guided decoding without
      // each front door (CLI, local server, worker) having to wire it.
      guidedDecoding: input.guidedDecoding ?? backendUsesGuidedDecoding(deepConfig.backend),
      ...(input.previewBuildFacts ? { buildFacts: input.previewBuildFacts } : {}),
      // C2: the context-window preflight runs per route when a window is configured.
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      ...(input.completionReserveTokens !== undefined ? { completionReserveTokens: input.completionReserveTokens } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    deepRoutes,
  );

  // The grounding gate's accept set, derived AFTER the deep pass at the SAME
  // geometry budget the preflight (C2) rendered each route at — so a degraded
  // prompt is never stricter than the gate (C3 invariant, preserved under C2).
  const budgetByRoute = new Map<string, GeometryBudget>();
  for (const r of deepResults) if (r.geometryBudget) budgetByRoute.set(r.route, r.geometryBudget);
  const selectors = citableAcceptSet(capture.geometry, budgetByRoute);

  // Routes triage suspected but that had no captured image are recorded as
  // not-reviewed so the wire result is honest about coverage.
  const attemptedRoutes = new Set(deepRoutes.map((r) => r.route));
  const uncapturedNotReviewed = routesToReview
    .filter((r) => !attemptedRoutes.has(r.route))
    .map((r) => `route ${r.route} (no captured image)`);

  // Triage concluded a deep review was needed and then named no route to run it
  // on. No page was cleared and no page was looked at, so every captured route is
  // unjudged and has to say so in words as well as in coverage. Naming the cause
  // matters: the run is not partial because a route was skipped or a capture
  // failed, it is empty because the triage answer contradicted itself, and
  // re-running the review is the action.
  // Keyed on what triage actually produced, not on whether it said anything. A
  // suspect list naming routes that match nothing captured (a model answering
  // "/home" for "/", or a stray space) is the same outcome as naming none: no
  // deep pass runs. Keying on `suspect.size` let a non-empty but useless list
  // mark every captured route as cleared by triage, which published a green
  // check claiming full coverage over a page nothing judged.
  const triageNamedNothing = routesToReview.length === 0;
  const unnamedByTriage = triageNamedNothing
    ? capturedRoutes(capture.images).map(
        (route) =>
          `${route}: triage concluded a deep review was needed but named no routes to review, so no pass judged this page`,
      )
    : [];

  // The routes this run actually formed a judgment about: a route whose deep pass
  // returned a valid critique, or a route triage looked at and cleared. This is
  // EXACTLY what coverage reports below, and it is the set the grounding gate
  // validates findings against, so the two cannot drift: a finding can only
  // survive on a `(route, viewport)` shot this run reviewed, which is the same set
  // coverage publishes. That is what keeps every published finding inside its own
  // coverage claim (∀f: f.route ∈ routesReviewed ∧ f.viewport ∈ viewportsReviewed).
  const deepJudged = new Set(
    deepResults.filter((r) => r.output !== null).map((r) => r.route),
  );
  const reviewedRoutes = capturedRoutes(capture.images).filter(
    (route) => deepJudged.has(route) || (!triageNamedNothing && !suspect.has(route)),
  );
  const reviewedRouteSet = new Set(reviewedRoutes);
  const reviewedShots = capture.images
    .filter((i) => reviewedRouteSet.has(i.route))
    .map((i) => ({ route: i.route, viewport: i.viewport }));

  // 5. Assemble (#106): the global validation tail (gate #32 / ceiling #70 /
  //    post-filter #33 / reconcileGrade / stamp #68) over ALL merged findings.
  const critique = assembleCritique(deepResults, {
    capturedShots: reviewedShots,
    geometrySelectors: selectors,
    // #160: the capture contributes only the instability fact; the validated
    // promoted report owns the numeric ceiling and post-filter threshold.
    captureUnstable: input.captureUnstable === true || capture.pageHealth.unstable,
    // Judge-unlock §4.3: the duplicate-of-measurement gate runs inside the tail
    // when the caller supplied a ledger, built once from the same findings.
    ...(input.factLedger ? { factLedger: input.factLedger } : {}),
    ...(deps.calibration ? { calibration: deps.calibration } : {}),
    ...(deps.confidenceUnavailableReason
      ? { confidenceUnavailableReason: deps.confidenceUnavailableReason }
      : {}),
    notReviewed: [...(input.notReviewed ?? []), ...uncapturedNotReviewed, ...unnamedByTriage],
    model: deepConfig.model,
    captureVersion: capture.captureVersion,
    uiDnaVersion: input.context.uiDnaVersion,
  });

  // 6. Project to the cross-repo wire result Gate consumes (golden-shape). The
  //    page-health footnote (#20), console errors / failed requests / blocked
  //    fonts gathered during capture, is surfaced in `artifacts`, never mixed
  //    into findings; a clean page yields null and omits the field (golden-safe).
  // Coverage (#165) from what the deep path actually did. A captured route is
  // reviewed on exactly two grounds: its own deep pass returned a valid critique,
  // or triage looked at the route set, named its suspects, and did not name this
  // one. Everything else is unreviewed, which covers a deep pass whose output
  // failed coercion (`output: null`) and a triage that named nothing at all. When
  // every route lands there the reviewed set is empty, which is how a run that
  // judged nothing is told apart from a clean page that graded `ship`. Computed
  // above as `reviewedRoutes` because the grounding gate is validated against the
  // same set; coverage and the gate must report the identical reviewed set.
  const coverage = buildCoverage({
    requestedRoutes: requestedRoutesOf(input),
    requestedViewports: input.captureContext.viewports,
    reviewedRoutes,
    images: capture.images,
  });

  deps.onCritique?.(critique);
  return toEngineReviewResult(critique, {
    ...input.wireOptions,
    pageHealthFootnote: input.wireOptions.pageHealthFootnote ?? pageHealthFootnote(capture.pageHealth),
    coverage,
    // What this capture measured, published beside the judgment rather than
    // stopping at the prompt. Omitted when the caller measured nothing.
    ...(input.measurements ? { measurements: input.measurements } : {}),
  });
}

/**
 * Batch the per-route genome retrieval (#104, #113). The `Embedder` accepts a
 * batch, so all route queries are embedded in ONE call, then each route is ranked
 * against the prebuilt index. This is identical to calling `selectGenomeRules`
 * per route (same query, same index, same deterministic ranking) but collapses N
 * serial embedding round-trips on the critical path into one. Returns an empty map
 * when no genome index + embedder are injected (the no-genome path).
 */
async function selectGenomeRulesBatched(
  routes: ReviewRoute[],
  deps: ReviewDeps,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const { genomeIndex, embedder } = deps;
  if (!genomeIndex || !embedder || genomeIndex.rules.length === 0 || routes.length === 0) {
    return out;
  }
  // Query = the route itself (components/diff would extend this; route alone is a
  // sound, deterministic query for the retrieval seam). One batched embed call.
  const queries = routes.map((r) => r.route);
  const vectors = await embedder(queries);
  routes.forEach((r, i) => {
    const queryVector = vectors[i];
    if (!queryVector) return;
    out.set(r.route, retrieveGenomeRules(genomeIndex, queryVector).map((g) => g.rule.text));
  });
  return out;
}

/**
 * A clean wire result for a review that produced no findings, covering both the empty
 * capture and the triage short-circuit. Routed through the SAME builders as the
 * main path (`assembleCritique` with no routes -> `toEngineReviewResult`) so it
 * inherits the #68 non-empty version-stamp assertion and can't drift from the
 * contract. The model is the resolved DEEP-pass model (passModels-aware), matching
 * what the main path reports (#113).
 */
function emptyFindingsResult(
  input: ReviewInput,
  deps: ReviewDeps,
  captureVersion: string,
  options: {
    overall?: string;
    extraNotReviewed?: string[];
    coverage: ReviewCoverage;
    /** What was measured on this path; see the two call sites for why they differ. */
    measurements?: MeasurementReport;
  },
): EngineReviewResult {
  const deepConfig = resolvePassModel("deep", deps.passModels);
  const critique = assembleCritique([], {
    capturedShots: [],
    notReviewed: [...(input.notReviewed ?? []), ...(options.extraNotReviewed ?? [])],
    model: deepConfig.model,
    captureVersion,
    uiDnaVersion: input.context.uiDnaVersion,
    ...(deps.calibration ? { calibration: deps.calibration } : {}),
    ...(deps.confidenceUnavailableReason
      ? { confidenceUnavailableReason: deps.confidenceUnavailableReason }
      : {}),
  });
  // assembleCritique derives `overall` from route outputs (empty here); for the
  // short-circuit we carry the triage summary through verbatim.
  const stamped = options.overall !== undefined ? { ...critique, overall: options.overall } : critique;
  deps.onCritique?.(stamped);
  return toEngineReviewResult(stamped, {
    ...input.wireOptions,
    coverage: options.coverage,
    ...(options.measurements ? { measurements: options.measurements } : {}),
  });
}
