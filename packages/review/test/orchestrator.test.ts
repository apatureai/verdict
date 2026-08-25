import type {
  CalibrationRuntimeBinding,
  Capture,
  CaptureContext,
  CaptureImage,
  CaptureInSandbox,
  GeometryRect,
  Viewport,
} from "@apatureai/verdict-types";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelCallOptions,
  ModelBackend,
  PassModelConfig,
} from "@apatureai/verdict-critique";
import { buildGenomeIndex, type Embedder } from "@apatureai/verdict-context";
import { assertVersionStamped } from "@apatureai/verdict-critique";
import { loadGoldenResult } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  runReview as runReviewRaw,
  type ReviewDeps,
  type ReviewInput,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Stubs: NO real model / sandbox / browser / GPU. All live I/O is injected.
// ---------------------------------------------------------------------------

/**
 * A model whose deep-pass json_object coercion returns a per-route critique.
 *
 * `triageFor` scripts the triage answer from the routes the pass was handed;
 * the default suspects every one of them, which is what the pipeline tests want.
 * A test that cares about a specific triage response (an empty suspect list, a
 * partial one) passes its own.
 */
function scriptedModel(
  critiqueByRoute: (route: string) => unknown,
  triageFor: (routes: string[]) => unknown = (routes) => ({
    needsDeepReview: true,
    suspectRoutes: routes,
    obviousBreakage: [],
  }),
): {
  factory: (config: PassModelConfig) => ModelClient;
  calls: ModelRequest[];
} {
  const calls: ModelRequest[] = [];
  const client: ModelClient = {
    backend: "mock" as ModelBackend,
    async complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse> {
      if (options?.signal?.aborted) throw new Error("aborted");
      calls.push(request);
      let text: string;
      if (request.responseFormat === "json_object" || request.responseFormat === "json_schema") {
        // Triage call OR deep-pass coercion: distinguish by whether the prompt
        // mentions triaging. Triage system msg starts with "You are triaging".
        const system = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.startsWith("You are triaging")) {
          // Triage: answer from the scripted triage function (default: suspect all).
          const userMsg = request.messages.find((m) => m.role === "user")?.content ?? "";
          const routes = userMsg.replace("Routes: ", "").split(", ").filter(Boolean);
          text = JSON.stringify(triageFor(routes));
        } else {
          // Deep-pass coercion: the prior user message is the route's prose, which
          // we encoded as the route id so we can return that route's critique.
          const userMsg = request.messages.find((m) => m.role === "user")?.content ?? "";
          text = JSON.stringify(critiqueByRoute(userMsg));
        }
      } else {
        // Deep-pass thinking step: echo the route id (from "Review route X.") as
        // the prose, so the coercion step can route on it.
        const userMsg = request.messages.find((m) => m.role === "user")?.content ?? "";
        const m = /Review route (\S+?)\./.exec(userMsg);
        text = m ? (m[1] ?? "") : "prose";
      }
      return {
        text,
        thinkingText: request.thinking ? "thinking" : undefined,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  };
  return { factory: () => client, calls };
}

const VIEWPORTS: Viewport[] = ["mobile", "desktop"];

const TEST_CALIBRATION: CalibrationRuntimeBinding = {
  reference: {
    reportId: "calibration_qwen3vl_2026_07",
    reportHash: "sha256:675dcd6a31db1157aa84fce80a00d1dd2a591e15877226697134b79269a9ac08",
    calibrationVersion: "isotonic@1",
    confidenceSource: "post_hoc_isotonic",
  },
  identity: {
    model: "qwen3-vl-plus",
    promptVersion: "system-prompt@v6",
    engineVersion: "0.1.0",
    captureVersion: "stub-capture@1",
    rubricVersion: "design-rubric@1",
  },
  promotionMode: "blocking",
  thresholds: {
    postFilterMinConfidence: 0.55,
    blockingMinConfidence: 0.8,
    unstableCaptureMaxConfidence: 0.6,
  },
  calibrate: (raw) => raw,
};

function runReview(input: ReviewInput, deps: ReviewDeps) {
  return runReviewRaw(input, { calibration: TEST_CALIBRATION, ...deps });
}

function captureImagesFor(routes: string[]): CaptureImage[] {
  return routes.flatMap((route) =>
    VIEWPORTS.map((viewport) => ({
      route,
      viewport,
      objectKey: `cap/${route}/${viewport}.png`,
      width: 1280,
      height: 720,
    })),
  );
}

function geometryFor(routes: string[], selectors: string[]): GeometryRect[] {
  return routes.flatMap((route) =>
    VIEWPORTS.flatMap((viewport) =>
      selectors.map((selector) => ({
        route,
        viewport,
        selector,
        role: null,
        rect: { x: 0, y: 0, width: 100, height: 40 },
      })),
    ),
  );
}

/** Stub capture seam: deterministic, no browser. */
function stubCapture(
  routes: string[],
  selectors: string[],
  opts: { unstable?: boolean; empty?: boolean; consoleErrors?: number; failedRequests?: number } = {},
): CaptureInSandbox {
  return async (_url: string, _ctx: CaptureContext): Promise<Capture> => ({
    images: opts.empty ? [] : captureImagesFor(routes),
    geometry: opts.empty ? [] : geometryFor(routes, selectors),
    pageHealth: {
      consoleErrors: opts.consoleErrors ?? 0,
      failedRequests: opts.failedRequests ?? 0,
      unstable: opts.unstable ?? false,
    },
    captureVersion: "stub-capture@1",
  });
}

/** Deterministic bag-of-tokens embedder, no model. */
function embedVectors(texts: readonly string[]): number[][] {
  return texts.map((t) => {
    const lower = t.toLowerCase();
    return [
      lower.includes("pricing") ? 1 : 0,
      lower.includes("home") ? 1 : 0,
      lower.includes("button") || lower.includes("cta") ? 1 : 0,
      lower.length % 7,
    ];
  });
}

const fakeEmbedder: Embedder = async (texts) => embedVectors(texts);

/** A spy embedder that records each batch it was asked to embed (for call-count asserts). */
function spyEmbedder(): { embedder: Embedder; batches: readonly string[][] } {
  const batches: string[][] = [];
  const embedder: Embedder = async (texts) => {
    batches.push([...texts]);
    return embedVectors(texts);
  };
  return { embedder, batches };
}

function baseInput(routes: string[], over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    url: "https://preview.example.test",
    depth: "deep",
    context: {
      tokens: { "color.accent": "#ff0066" },
      brand: null,
      componentLibraries: [],
      uiDnaVersion: "ui-dna@2026.06.12",
      routes,
    },
    captureContext: {
      installationId: "inst_1",
      viewports: VIEWPORTS,
      darkMode: false,
      isFork: false,
      routes,
    },
    routes: routes.map((route) => ({ route, currentPhash: "abc", facts: [`fact for ${route}`] })),
    wireOptions: { screenshotRetentionSeconds: 2_592_000 },
    ...over,
  };
}

// A valid CritiqueOutput row that survives the gate (route captured, elementRef
// in the geometry map, confidence above the 0.55 floor). `dimension`/`elementRef`
// default to a route-unique pair so two routes' findings don't dedupe together
// in the global post-filter (#33, which dedupes by dimension|elementRef).
function critiqueFor(
  route: string,
  severity: "major" | "minor" | "nit",
  grade: string,
  opts: { dimension?: string; elementRef?: string } = {},
): unknown {
  return {
    grade,
    overall: `Review of ${route}.`,
    findings: [
      {
        dimension: opts.dimension ?? "color_contrast",
        severity,
        confidence: 0.9,
        route,
        viewport: "mobile",
        elementRef: opts.elementRef ?? "#cta",
        title: `Issue on ${route}`,
        description: `A ${severity} issue on ${route}.`,
        suggestion: "Fix it.",
        introducedByThisPr: true,
      },
    ],
    notReviewed: [],
  };
}

describe("runReview — end-to-end orchestrator", () => {
  it("composes context→capture→triage→deep-pass→assemble→project into the golden wire shape", async () => {
    const routes = ["/pricing", "/home"];
    const { factory, calls } = scriptedModel((route) =>
      route === "/pricing"
        ? critiqueFor("/pricing", "major", "needs_work", { dimension: "color_contrast", elementRef: "#cta" })
        : critiqueFor("/home", "nit", "ship_with_nits", { dimension: "spacing", elementRef: "#hero" }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    // Worst grade across routes, floored to surviving findings (#106): major -> needs_work.
    expect(result.grade).toBe("needs_work");
    // Both routes' findings survive the gate + filter.
    expect(result.findings.map((f) => f.route).sort()).toEqual(["/home", "/pricing"]);
    // Deterministic wire ids.
    expect(result.findings.map((f) => f.id)).toEqual(["f_001", "f_002"]);
    // Metadata is stamped from the deep pass + capture + context.
    expect(result.metadata.captureVersion).toBe("stub-capture@1");
    expect(result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12");
    expect(result.metadata.model).toBe("qwen3-vl-plus");

    // Golden SHAPE: same top-level keys + finding keys as the cross-repo anchor,
    // minus `provenance`, which the surface stamps after the orchestrator returns
    // (only the surface knows whether a model was actually called).
    const golden = loadGoldenResult();
    const goldenKeys = Object.keys(golden).filter((key) => key !== "provenance");
    // ...plus `hallucinationDrops`, which every result now states and the anchor
    // does not carry yet: additive on schema v1, so the anchor's keys stay a
    // subset of what this producer emits.
    expect(Object.keys(result).sort()).toEqual([...goldenKeys, "hallucinationDrops"].sort());
    for (const key of goldenKeys) expect(result).toHaveProperty(key);
    expect(Object.keys(result.findings[0]!).sort()).toEqual(Object.keys(golden.findings[0]!).sort());
    expect(Object.keys(result.metadata).sort()).toEqual(Object.keys(golden.metadata).sort());

    // Triage ran (1 call) + a deep pass for each route (2 calls each: thinking + coerce).
    const triageCalls = calls.filter((c) =>
      c.messages.some((m) => m.role === "system" && m.content.startsWith("You are triaging")),
    );
    expect(triageCalls).toHaveLength(1);
  });

  it("short-circuits on the triage 'no design changes' path — no deep pass", async () => {
    const routes = ["/pricing"];
    // A model that, if the deep pass ran, would emit findings, so a clean result
    // proves the deep pass never ran.
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    // Triage short-circuits when every route is positively confirmed unchanged:
    // pHash match (baseline == current) AND tile-wise diff below threshold.
    const input = baseInput(routes, {
      routes: [
        {
          route: "/pricing",
          baselinePhash: "ffff",
          currentPhash: "ffff",
          tileScores: [{ ssim: 1, diffRatio: 0 }],
        },
      ],
    });

    const result = await runReview(input, {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    expect(result.overall).toMatch(/no design changes/i);
    // No model call at all (triage short-circuits before the model; deep skipped).
    expect(calls).toHaveLength(0);
  });

  it("propagates engine-side not-reviewed reasons through to the wire result", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "minor", "needs_work"));

    const result = await runReview(
      baseInput(routes, {
        notReviewed: ["route /checkout (no preview deployment matched the head SHA)"],
      }),
      { captureInSandbox: stubCapture(routes, ["#cta"]), modelFactory: factory },
    );

    expect(result.notReviewed).toContain("route /checkout (no preview deployment matched the head SHA)");
  });

  it("does not crash when a route's model output fails coercion (null)", async () => {
    const routes = ["/pricing", "/home"];
    // /home returns malformed JSON -> coercion fails -> null output, recorded as
    // notReviewed; /pricing still produces a finding.
    const { factory } = scriptedModel((route) =>
      route === "/pricing" ? critiqueFor("/pricing", "major", "needs_work") : { broken: true },
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    // /pricing's finding survives; /home is recorded as not reviewed, no crash.
    expect(result.findings.map((f) => f.route)).toEqual(["/pricing"]);
    expect(result.notReviewed.some((r) => r.includes("/home"))).toBe(true);
    expect(result.grade).toBe("needs_work");
  });

  it("returns a clean empty result when the capture produced no images", async () => {
    const routes = ["/pricing"];
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { empty: true }),
      modelFactory: factory,
    });

    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    expect(result.notReviewed).toContain("no captured routes");
    expect(calls).toHaveLength(0); // no model call without images.
  });

  it("threads injected genome rules (#104) into the deep pass without crashing", async () => {
    const routes = ["/pricing"];
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "minor", "needs_work"));
    const genomeIndex = await buildGenomeIndex(
      "ui-dna@2026.06.12",
      [{ id: "r1", text: "Primary CTA must use the accent token", component: "button" }],
      fakeEmbedder,
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
      genomeIndex,
      embedder: fakeEmbedder,
    });

    expect(result.findings).toHaveLength(1);
    // The deep-pass thinking prompt carried the genome rule block.
    const thinking = calls.find((c) => c.thinking);
    expect(thinking?.messages.some((m) => m.content.includes("Primary CTA must use the accent token"))).toBe(true);
  });

  it("caps confidence on an unstable capture but keeps the finding (#70: ceiling 0.6 ≥ floor 0.55)", async () => {
    const routes = ["/pricing"];
    // Finding confidence 0.9; an unstable capture (no explicit ceiling) caps it to
    // the default UNSTABLE_CONFIDENCE_CEILING (0.6), which is ABOVE the post-filter
    // floor (0.55), so a REAL finding still SURFACES with lowered trust. It must
    // NOT be silently dropped (a flaky page with a real blocker would otherwise
    // return ship/[]).
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { unstable: true }),
      modelFactory: factory,
    });

    // Survives the ceiling+filter; grade reflects the surviving major finding.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.route).toBe("/pricing");
    expect(result.grade).toBe("needs_work");
  });

  it("drops findings when the promoted unstable ceiling is below its post-filter floor", async () => {
    const routes = ["/pricing"];
    // A caller may pass a stricter ceiling; 0.5 < the 0.55 floor drops the finding.
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes, { captureUnstable: true }), {
      captureInSandbox: stubCapture(routes, ["#cta"], { unstable: true }),
      modelFactory: factory,
      calibration: {
        ...TEST_CALIBRATION,
        thresholds: { ...TEST_CALIBRATION.thresholds, unstableCaptureMaxConfidence: 0.5 },
      },
    });

    expect(result.findings).toHaveLength(0);
    // Grade floored to ship when no findings survive (#106).
    expect(result.grade).toBe("ship");
  });

  // -------------------------------------------------------------------------
  // #20: page-health footnote surfaced in delivery (artifacts), not findings
  // -------------------------------------------------------------------------

  it("#20: surfaces console-error/failed-request page health as an artifacts footnote, not a finding", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { consoleErrors: 2, failedRequests: 1 }),
      modelFactory: factory,
    });

    expect(result.artifacts.pageHealthFootnote).toBe(
      "Page health: 2 console error(s), 1 failed request(s).",
    );
    // It rode in as a footnote, never as a design finding.
    expect(result.findings.every((f) => !/console error|failed request/i.test(f.description))).toBe(true);
  });

  it("#20: omits the page-health footnote when the page is clean (golden-safe)", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    expect(result.artifacts).not.toHaveProperty("pageHealthFootnote");
  });

  it("#20: an unstable capture footnotes the instability for delivery", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { unstable: true }),
      modelFactory: factory,
    });

    expect(result.artifacts.pageHealthFootnote).toContain("page visually unstable during capture");
  });

  // -------------------------------------------------------------------------
  // #113: quality follow-ups (model attribution, version-stamp routing, batch embed)
  // -------------------------------------------------------------------------

  it("#113: empty-capture result reports the resolved deep-pass model + a valid version stamp", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    // depth: "triage". The OLD emptyResult stamped resolvePassModel("triage") and
    // would have reported the triage model here. It must report the deep-pass model
    // (the model the rest of the pipeline reports), regardless of depth.
    const result = await runReview(baseInput(routes, { depth: "triage" }), {
      captureInSandbox: stubCapture(routes, ["#cta"], { empty: true }),
      modelFactory: factory,
    });

    expect(result.grade).toBe("ship");
    expect(result.notReviewed).toContain("no captured routes");
    // Same model the main deep path reports (see the golden-shape test above).
    expect(result.metadata.model).toBe("qwen3-vl-plus");
    // Routed through buildResultMetadata: a valid, non-empty #68 version stamp.
    expect(() => assertVersionStamped(result.metadata)).not.toThrow();
    expect(result.metadata.captureVersion).toBe("stub-capture@1");
    expect(result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12");
  });

  it("#113: empty-capture model honours passModels overrides (passModels-aware)", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { empty: true }),
      modelFactory: factory,
      passModels: { deep: { model: "custom-deep-model" } },
    });

    expect(result.metadata.model).toBe("custom-deep-model");
    expect(() => assertVersionStamped(result.metadata)).not.toThrow();
  });

  it("#113: short-circuit result routes through the shared builders (golden-shape + valid stamp)", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));
    const input = baseInput(routes, {
      routes: [
        {
          route: "/pricing",
          baselinePhash: "ffff",
          currentPhash: "ffff",
          tileScores: [{ ssim: 1, diffRatio: 0 }],
        },
      ],
    });

    const result = await runReview(input, {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    expect(result.grade).toBe("ship");
    expect(result.overall).toMatch(/no design changes/i);
    // Same top-level + metadata keys as the cross-repo golden anchor, except a
    // clean short-circuit has no raw finding score and therefore no synthetic
    // numeric confidence (#160), `provenance` is stamped by the surface after
    // the orchestrator returns, and `hallucinationDrops` is emitted on every
    // result while the anchor does not carry it yet (additive on schema v1).
    const golden = loadGoldenResult();
    expect(Object.keys(result).sort()).toEqual(
      [
        ...Object.keys(golden).filter((key) => key !== "confidence" && key !== "provenance"),
        "hallucinationDrops",
      ].sort(),
    );
    // Nothing ran a model here, so nothing could be dropped, and the result says
    // so rather than staying silent about it.
    expect(result.hallucinationDrops).toBe(0);
    expect(result).not.toHaveProperty("confidence");
    expect(Object.keys(result.metadata).sort()).toEqual(Object.keys(golden.metadata).sort());
    // Routed through buildResultMetadata: the #68 version stamp is present + valid.
    expect(() => assertVersionStamped(result.metadata)).not.toThrow();
    expect(result.metadata.model).toBe("qwen3-vl-plus");
  });

  it("#113: genome embedding is invoked ONCE (batched) across routes, not per route", async () => {
    const routes = ["/pricing", "/home"];
    const { factory } = scriptedModel((route) =>
      route === "/pricing"
        ? critiqueFor("/pricing", "major", "needs_work", { dimension: "color_contrast", elementRef: "#cta" })
        : critiqueFor("/home", "nit", "ship_with_nits", { dimension: "spacing", elementRef: "#hero" }),
    );
    const { embedder, batches } = spyEmbedder();
    const genomeIndex = await buildGenomeIndex(
      "ui-dna@2026.06.12",
      [{ id: "r1", text: "Primary CTA must use the accent token", component: "button" }],
      embedder,
    );
    // buildGenomeIndex embeds the rules once; reset so we measure only the review.
    const buildCalls = batches.length;

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
      genomeIndex,
      embedder,
    });

    // Both routes reviewed (the batched retrieval did not change results).
    expect(result.findings.map((f) => f.route).sort()).toEqual(["/home", "/pricing"]);
    // Exactly ONE embedder call for the two routes' queries, not N serial calls.
    const reviewBatches = batches.slice(buildCalls);
    expect(reviewBatches).toHaveLength(1);
    expect(reviewBatches[0]).toEqual(["/pricing", "/home"]);
  });

  it("#113: batched genome retrieval yields identical rules to per-route selection", async () => {
    const routes = ["/pricing"];
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "minor", "needs_work"));
    const genomeIndex = await buildGenomeIndex(
      "ui-dna@2026.06.12",
      [{ id: "r1", text: "Primary CTA must use the accent token", component: "button" }],
      fakeEmbedder,
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
      genomeIndex,
      embedder: fakeEmbedder,
    });

    expect(result.findings).toHaveLength(1);
    // The genome rule still reaches the deep-pass thinking prompt (unchanged behaviour).
    const thinking = calls.find((c) => c.thinking);
    expect(thinking?.messages.some((m) => m.content.includes("Primary CTA must use the accent token"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #165: coverage, the structural answer to "what did this run actually look at"
// ---------------------------------------------------------------------------
describe("runReview coverage (#165)", () => {
  it("reports full coverage when every requested route and viewport was judged", async () => {
    const routes = ["/pricing", "/home"];
    const { factory } = scriptedModel((route) =>
      route === "/pricing"
        ? critiqueFor("/pricing", "minor", "needs_work", { dimension: "color_contrast", elementRef: "#cta" })
        : critiqueFor("/home", "nit", "ship_with_nits", { dimension: "spacing", elementRef: "#hero" }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    expect(result.coverage).toEqual({
      routesRequested: ["/pricing", "/home"],
      routesReviewed: ["/pricing", "/home"],
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: ["mobile", "desktop"],
    });
  });

  it("reports partial coverage for a requested route the capture never produced", async () => {
    // Two routes asked for, only /pricing captured. A clean partial review is
    // still a real review: coverage says which half of the ask it covered.
    const captured = ["/pricing"];
    const requested = ["/pricing", "/checkout"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "minor", "needs_work"));

    const input = baseInput(requested);
    const result = await runReview(input, {
      captureInSandbox: stubCapture(captured, ["#cta"]),
      modelFactory: factory,
    });

    expect(result.coverage).toEqual({
      routesRequested: ["/pricing", "/checkout"],
      routesReviewed: ["/pricing"],
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: ["mobile", "desktop"],
    });
    expect(result.notReviewed.some((line) => line.includes("/checkout"))).toBe(true);
  });

  it("reports NOTHING reviewed when the capture produced no images", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { empty: true }),
      modelFactory: factory,
    });

    // The grade is still `ship` and findings are still empty: field for field
    // this is a clean review, and coverage is the only thing that says otherwise.
    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    expect(result.coverage).toEqual({
      routesRequested: ["/pricing"],
      routesReviewed: [],
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: [],
    });
  });

  it("reports NOTHING reviewed when every route's critique fails coercion", async () => {
    const routes = ["/pricing", "/home"];
    // Deep-pass coercion returns a payload that is not a CritiqueOutput, so
    // every route comes back `output: null` and contributes no judgment.
    const { factory } = scriptedModel(() => ({ not: "a critique" }));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    expect(result.notReviewed).toContain("/pricing: no valid critique");
    expect(result.notReviewed).toContain("/home: no valid critique");
    expect(result.coverage?.routesReviewed).toEqual([]);
    expect(result.coverage?.viewportsReviewed).toEqual([]);
  });

  it("counts a route as reviewed only when its own critique came back valid", async () => {
    const routes = ["/pricing", "/home"];
    // /pricing coerces; /home does not.
    const { factory } = scriptedModel((route) =>
      route === "/pricing" ? critiqueFor("/pricing", "minor", "needs_work") : { not: "a critique" },
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    expect(result.coverage?.routesRequested).toEqual(["/pricing", "/home"]);
    expect(result.coverage?.routesReviewed).toEqual(["/pricing"]);
  });

  it("reviews NOTHING when triage asks for a deep review and then names no route", async () => {
    // The producer that needs no adversary: a model having an off day answers
    // {"needsDeepReview": true, "suspectRoutes": []}. No deep pass runs, so no
    // route reaches a judgment, so nothing may be counted as reviewed.
    const routes = ["/pricing", "/home"];
    const { factory, calls } = scriptedModel(
      () => critiqueFor("/pricing", "major", "blocked"),
      () => ({ needsDeepReview: true, suspectRoutes: [], obviousBreakage: [] }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    // Field for field this is the clean result it always was...
    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    // ...and exactly one deep-pass-shaped call was never made: only triage ran.
    expect(calls).toHaveLength(1);
    // Coverage is the field that refuses to call it a review.
    expect(result.coverage).toEqual({
      routesRequested: ["/pricing", "/home"],
      routesReviewed: [],
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: [],
    });
    // And the reason is stated in words, per route, naming what happened.
    expect(result.notReviewed).toContain(
      "/pricing: triage concluded a deep review was needed but named no routes to review, so no pass judged this page",
    );
    expect(result.notReviewed).toContain(
      "/home: triage concluded a deep review was needed but named no routes to review, so no pass judged this page",
    );
  });

  it("treats suspects that match nothing captured the same as naming none", async () => {
    // The shape that survived the first fix. Triage says a deep review IS needed
    // and then names a route that does not exist in the capture, which a model
    // does by answering "/home" for "/" or by adding a stray space. No deep pass
    // runs, so nothing judges the page, but keying on "did triage name anything"
    // marked every captured route as cleared and published a green check with
    // full coverage over a page nothing looked at.
    const routes = ["/pricing"];
    const { factory, calls } = scriptedModel(
      () => critiqueFor("/pricing", "minor", "needs_work"),
      () => ({ needsDeepReview: true, suspectRoutes: ["/does-not-exist"], obviousBreakage: [] }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    // Triage ran; no deep pass did.
    expect(calls.length).toBe(1);
    expect(result.coverage?.routesReviewed).toEqual([]);
    expect(result.notReviewed).toContain(
      "/pricing: triage concluded a deep review was needed but named no routes to review, so no pass judged this page",
    );
  });

  it("keeps a route triage explicitly did not suspect as reviewed: that IS a judgment", async () => {
    // The near-identical response that means the opposite: triage looked at both
    // routes and named one. /home was considered and cleared, /pricing was
    // deep-reviewed; both are reviewed, and the two cases stay distinguishable.
    const routes = ["/pricing", "/home"];
    const { factory } = scriptedModel(
      () => critiqueFor("/pricing", "minor", "needs_work"),
      () => ({ needsDeepReview: true, suspectRoutes: ["/pricing"], obviousBreakage: [] }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    expect(result.coverage?.routesReviewed).toEqual(["/pricing", "/home"]);
    expect(result.notReviewed.some((line) => line.includes("named no routes"))).toBe(false);
  });

  it("counts the triage short-circuit as reviewed: unchanged-since-baseline is a conclusion", async () => {
    const routes = ["/pricing"];
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));
    const input = baseInput(routes, {
      routes: [
        {
          route: "/pricing",
          baselinePhash: "ffff",
          currentPhash: "ffff",
          tileScores: [{ ssim: 1, diffRatio: 0 }],
        },
      ],
    });

    const result = await runReview(input, {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    expect(calls).toHaveLength(0);
    expect(result.coverage).toEqual({
      routesRequested: ["/pricing"],
      routesReviewed: ["/pricing"],
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: ["mobile", "desktop"],
    });
    // Nothing to explain: a real baseline confirmed the page unchanged.
    expect(result.notReviewed).toEqual([]);
  });

  it("reviews NOTHING when triage declines a deep review with no baseline to decline it against", async () => {
    // The other half of the pair above, and the one that shipped a lie. The
    // route carries NO baselinePhash and NO tileScores, which is every CLI and
    // server run: `runTriage` cannot confirm anything, falls through to the
    // model, and the model answers {"needsDeepReview": false}. One model call,
    // no deep pass, no comparison against anything. Before this branch existed
    // the run published `grade: ship`, `findings: 0`, `notReviewed: []` and
    // coverage claiming the route reviewed.
    const routes = ["/pricing"];
    const { factory, calls } = scriptedModel(
      () => critiqueFor("/pricing", "major", "blocked"),
      () => ({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    // Field for field the clean result it always was: the grade did not change.
    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    // Triage ran; the deep pass did not.
    expect(calls).toHaveLength(1);
    // Coverage is what refuses to call it a review.
    expect(result.coverage).toEqual({
      routesRequested: ["/pricing"],
      routesReviewed: [],
      viewportsRequested: ["mobile", "desktop"],
      viewportsReviewed: [],
    });
    // And the reason names the missing input, not just the outcome.
    expect(result.notReviewed).toHaveLength(1);
    expect(result.notReviewed[0]).toContain("/pricing: triage answered that no deep review was needed");
    expect(result.notReviewed[0]).toContain("no baseline");
    expect(result.notReviewed[0]).toContain("Record a baseline");
  });

  it("names every captured route when triage declines a deep review with no baseline", async () => {
    // Per route, not one summary line: a reader has to be able to see WHICH
    // pages nothing judged, the same way the cap and the coercion paths name
    // theirs.
    const routes = ["/pricing", "/home"];
    const { factory } = scriptedModel(
      () => critiqueFor("/pricing", "major", "blocked"),
      () => ({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    expect(result.coverage?.routesReviewed).toEqual([]);
    expect(result.notReviewed).toHaveLength(2);
    expect(result.notReviewed.some((line) => line.startsWith("/pricing:"))).toBe(true);
    expect(result.notReviewed.some((line) => line.startsWith("/home:"))).toBe(true);
  });

  it("keeps the pre-decided not-reviewed reasons alongside the unbaselined-triage ones", async () => {
    // The truncated tail (#cap) and the unjudged route are different facts and
    // both have to survive this exit path.
    const captured = ["/pricing"];
    const { factory } = scriptedModel(
      () => critiqueFor("/pricing", "major", "blocked"),
      () => ({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] }),
    );

    const result = await runReview(
      baseInput(captured, {
        requestedRoutes: ["/pricing", "/legal"],
        notReviewed: ["route /legal (over the routes.max_per_pr limit of 1)"],
      }),
      { captureInSandbox: stubCapture(captured, ["#cta"]), modelFactory: factory },
    );

    expect(result.coverage?.routesRequested).toEqual(["/pricing", "/legal"]);
    expect(result.coverage?.routesReviewed).toEqual([]);
    expect(result.notReviewed).toContain("route /legal (over the routes.max_per_pr limit of 1)");
    expect(result.notReviewed.some((line) => line.startsWith("/pricing:"))).toBe(true);
  });

  it("still reviews a baseline-confirmed route when triage never reaches the model", async () => {
    // The guard must key on the baseline confirmation, not on "was a model
    // called": here no model call happens at all and the route IS reviewed,
    // while in the unbaselined test above a model call DOES happen and the
    // route is not. Call count and judgment are independent.
    const routes = ["/pricing", "/home"];
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));
    const input = baseInput(routes, {
      routes: routes.map((route) => ({
        route,
        baselinePhash: "ffff",
        currentPhash: "ffff",
        tileScores: [{ ssim: 1, diffRatio: 0 }],
      })),
    });

    const result = await runReview(input, {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    expect(calls).toHaveLength(0);
    expect(result.coverage?.routesReviewed).toEqual(["/pricing", "/home"]);
    expect(result.notReviewed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The route cap: a narrowed ask is still the full ask, on the wire
// ---------------------------------------------------------------------------
describe("runReview when the caller narrowed the ask before capture", () => {
  /**
   * `routes.max_per_pr` caps what is captured, and `requestedRoutes` is how the
   * runtime says what was asked for anyway. Without it the capped list was BOTH
   * the ask and the answer, so a truncated run reported full coverage: the one
   * shape coverage exists to make impossible.
   */
  it("reports the untruncated ask against what it actually reviewed", async () => {
    const captured = ["/pricing", "/home"];
    const configured = ["/pricing", "/home", "/checkout", "/legal"];
    const { factory } = scriptedModel((route) =>
      route === "/pricing"
        ? critiqueFor("/pricing", "minor", "needs_work", { dimension: "color_contrast", elementRef: "#cta" })
        : critiqueFor("/home", "nit", "ship_with_nits", { dimension: "spacing", elementRef: "#hero" }),
    );

    const input = baseInput(captured, {
      requestedRoutes: configured,
      notReviewed: [
        "route /checkout (over the routes.max_per_pr limit of 2)",
        "route /legal (over the routes.max_per_pr limit of 2)",
      ],
    });

    const result = await runReview(input, {
      captureInSandbox: stubCapture(captured, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    expect(result.coverage?.routesRequested).toEqual(configured);
    expect(result.coverage?.routesReviewed).toEqual(captured);
    // Named, not counted: a reader has to be able to see WHICH routes.
    expect(result.notReviewed).toContain("route /checkout (over the routes.max_per_pr limit of 2)");
    expect(result.notReviewed).toContain("route /legal (over the routes.max_per_pr limit of 2)");
  });

  it("carries the truncated tail through the triage short-circuit too", async () => {
    // The short-circuit is a separate exit path, and an unchanged-since-baseline
    // run over a truncated route list is exactly as partial as a deep one.
    const captured = ["/pricing"];
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));
    const input = baseInput(captured, {
      requestedRoutes: ["/pricing", "/legal"],
      notReviewed: ["route /legal (over the routes.max_per_pr limit of 1)"],
      routes: [
        {
          route: "/pricing",
          baselinePhash: "ffff",
          currentPhash: "ffff",
          tileScores: [{ ssim: 1, diffRatio: 0 }],
        },
      ],
    });

    const result = await runReview(input, {
      captureInSandbox: stubCapture(captured, ["#cta"]),
      modelFactory: factory,
    });

    expect(calls).toHaveLength(0);
    expect(result.coverage?.routesRequested).toEqual(["/pricing", "/legal"]);
    expect(result.coverage?.routesReviewed).toEqual(["/pricing"]);
    expect(result.notReviewed).toContain("route /legal (over the routes.max_per_pr limit of 1)");
  });

  it("leaves every caller that narrows nothing exactly where it was", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "minor", "needs_work"));
    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });
    expect(result.coverage?.routesRequested).toEqual(routes);
  });
});

// ---------------------------------------------------------------------------
// #32 on the wire: how many findings the grounding gate deleted
// ---------------------------------------------------------------------------
describe("runReview reports the grounding gate's drop count", () => {
  /** A critique whose single finding cites an element the capture never produced. */
  function ungroundedCritique(route: string): unknown {
    return {
      grade: "needs_work",
      overall: `The ${route} hero overlaps the nav on mobile.`,
      findings: [
        {
          dimension: "spacing",
          severity: "major",
          confidence: 0.9,
          route,
          viewport: "mobile",
          elementRef: "#ghost", // never in the geometry map
          title: "Hero overlaps the nav",
          description: "The hero block sits on top of the navigation bar.",
          suggestion: "Add top margin.",
          introducedByThisPr: true,
        },
      ],
      notReviewed: [],
    };
  }

  it("states the count when every finding was deleted for citing something uncaptured", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => ungroundedCritique("/pricing"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    // Zero findings and a `ship` grade, the same payload a genuinely clean page
    // produces. The drop count is what separates the two.
    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    expect(result.hallucinationDrops).toBe(1);
    // This used to be a documented limitation: the narrative is written before
    // the gate runs, so a result with zero findings and a `ship` grade still
    // read "the hero overlaps the nav". It no longer does. `overall` states what
    // happened, and the model's paragraph is kept verbatim where it cannot be
    // mistaken for a conclusion about the page.
    expect(result.overall).not.toContain("overlaps the nav");
    expect(result.overall).toContain("No finding in this review survived validation");
    expect(result.overall).toContain("1 for citing a route or element that was never captured");
    expect(result.ungroundedNarrative).toBe("The /pricing hero overlaps the nav on mobile.");
  });

  it("states zero when nothing was dropped, so absent can only mean an older producer", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "minor", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.hallucinationDrops).toBe(0);
  });

  it("matches the internal count the SLO reads, so the wire and the metric cannot disagree", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => ungroundedCritique("/pricing"));
    let observed: number | null = null;

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
      onCritique: (critique) => {
        observed = critique.validation.hallucinationDrops;
      },
    });

    expect(observed).toBe(1);
    expect(result.hallucinationDrops).toBe(observed);
  });
});

describe("runReview delivers the geometry map the gate validates against (#W1-02)", () => {
  /** The `element_ref` selectors each route's deep-pass prompt actually carried. */
  function geometryByRouteFrom(calls: ModelRequest[]): Map<string, Set<string>> {
    const byRoute = new Map<string, Set<string>>();
    for (const call of calls) {
      if (!call.thinking) continue; // only the deep-pass thinking step carries the map
      const user = call.messages.find((m) => m.role === "user")?.content ?? "";
      const route = /Review route (\S+?)\./.exec(user)?.[1];
      if (!route || !user.includes("DOM geometry")) continue;
      const selectors = new Set<string>();
      for (const line of user.split("\n")) {
        const m = /^- (.+?) \([^)]*\) box /.exec(line);
        if (m?.[1]) selectors.add(m[1]);
      }
      byRoute.set(route, selectors);
    }
    return byRoute;
  }

  it("INVARIANT: geometry_in_prompt ⊇ gate_accept_set — every selector the gate accepts was shown to the model", async () => {
    const routes = ["/pricing", "/home"];
    // A mix of a landmark-shaped id and inferred/measured selectors — exactly the
    // kind the model could name from pixels and the gate would delete if it had
    // never been shown them.
    const selectors = ["#cta", ".hero p.sub", "body > main > section:nth-of-type(3) > p:nth-of-type(2)"];
    const { factory, calls } = scriptedModel((route) =>
      critiqueFor(route, "minor", "needs_work", { elementRef: ".hero p.sub" }),
    );

    const capture = stubCapture(routes, selectors);
    // The gate's accept set is the selector set of the SAME capture geometry the
    // orchestrator threads into both the gate and the prompt.
    const captured = await capture("https://x", baseInput(routes).captureContext);
    const gateAccepts = new Set(captured.geometry.map((g) => g.selector));

    await runReview(baseInput(routes), { captureInSandbox: capture, modelFactory: factory });

    const byRoute = geometryByRouteFrom(calls);
    // Per route: the block carries every selector the gate would accept for it.
    for (const route of routes) {
      const block = byRoute.get(route);
      expect(block).toBeDefined();
      for (const selector of selectors) expect(block?.has(selector)).toBe(true);
    }
    // Whole review: the union of what the model was shown ⊇ the gate's accept set.
    const shown = new Set<string>();
    for (const set of byRoute.values()) for (const s of set) shown.add(s);
    for (const selector of gateAccepts) expect(shown.has(selector)).toBe(true);
  });

  it("a finding citing a real inferred geometry selector now SURVIVES the gate", async () => {
    // The regression this pins: before the fix the model only ever saw the
    // selectors in the deterministic-fact lines, so a genuine inferred selector
    // like `.hero p.sub` read as hallucination to the gate and was deleted. It is
    // now in the delivered map, so a finding grounded on it is kept.
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() =>
      critiqueFor("/pricing", "major", "needs_work", { elementRef: ".hero p.sub" }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", ".hero p.sub"]),
      modelFactory: factory,
    });

    expect(result.hallucinationDrops).toBe(0);
    // The wire finding exposes the selector as `element` (same vocabulary as the
    // geometry map's `element_ref`).
    expect(result.findings.map((f) => f.element)).toContain(".hero p.sub");
  });
});
