import type {
  CaptureBrowser,
  CapturePage,
  ExtractedPage,
  ScreenshotSink,
} from "@apatureai/verdict-capture";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  PassModelConfig,
} from "@apatureai/verdict-critique";
import type { ContextBlockInput, Embedder, GenomeRule } from "@apatureai/verdict-context";
import { describe, expect, it } from "vitest";
import {
  lexicalEmbedder,
  runLocalReview,
  LEXICAL_EMBEDDER_ID,
  UNGROUNDED_DISCLOSURE_PREFIX,
  type LocalGenome,
  type LocalReviewOutcome,
} from "../src/index.js";

/**
 * The shipped local pipeline (#2): the same function the terminal CLI and the
 * HTTP job server both run, driven against a fake browser and a scripted model.
 *
 * What it pins: the deterministic breakage the capture measures reaches triage,
 * and a triage answer that declines a deep review does NOT get the last word
 * over a measurement. Before this, `deterministicBreakage` was a field the
 * orchestrator threaded, the triage pass honoured, and nothing on either shipped
 * surface ever populated, so the only thing that could force a deep review in
 * production was the cheap model agreeing to one.
 */

function fakePng(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 780);
  view.setUint32(20, 1688);
  return bytes;
}

/**
 * One landmark the model can cite, one paragraph whose content is wider than its
 * box (measured overflow: breakage) and a crowded pair of undersized buttons
 * (measured touch-target: a real defect that is deliberately NOT breakage).
 *
 * The buttons come in a pair 2px apart because that is what WCAG 2.2 SC 2.5.8
 * actually describes. A lone 20x20 control with clear space around it meets the
 * criterion's Spacing exception and is not a failure at all.
 *
 * `undersizedButton: false` grows the buttons past the threshold and
 * `overflowing: false` narrows the paragraph, so the pair produces a page on
 * which every check runs and measures NOTHING. That page is the control for
 * every rule about measurements: an earned `ship` has to survive it.
 */
function extracted(options: { overflowing: boolean; undersizedButton?: boolean }): ExtractedPage {
  const buttonSide = options.undersizedButton === false ? 48 : 20;
  return {
    bodyText: "pricing",
    documentHeight: 1400,
    canvasBackground: "rgb(255, 255, 255)",
    fonts: [],
    elements: [
      {
        tag: "h1",
        id: "hero-title",
        testId: null,
        role: null,
        cssPath: "body > main > h1",
        rect: { x: 32, y: 80, width: 600, height: 44 },
        animated: false,
        interactive: false,
        text: null,
      },
      {
        tag: "button",
        id: "icon-close",
        testId: null,
        role: null,
        cssPath: "body > main > button:nth-of-type(1)",
        rect: { x: 700, y: 80, width: buttonSide, height: buttonSide },
        animated: false,
        interactive: true,
        inlineTarget: false,
        text: null,
      },
      {
        tag: "button",
        id: "icon-menu",
        testId: null,
        role: null,
        cssPath: "body > main > button:nth-of-type(2)",
        rect: { x: 700 + buttonSide + 2, y: 80, width: buttonSide, height: buttonSide },
        animated: false,
        interactive: true,
        inlineTarget: false,
        text: null,
      },
      {
        tag: "p",
        id: "hero-subtitle",
        testId: null,
        role: null,
        cssPath: "body > main > p",
        rect: { x: 32, y: 140, width: 400, height: 24 },
        animated: false,
        interactive: false,
        text: {
          fontSizePx: 17,
          fontWeight: 400,
          color: "rgb(20, 20, 20)",
          backgroundStack: ["rgb(255, 255, 255)"],
          contentWidthPx: options.overflowing ? 900 : 380,
        },
      },
    ],
  };
}

function fakeBrowser(options: { overflowing: boolean; undersizedButton?: boolean }): CaptureBrowser {
  const page: CapturePage = {
    clock: { async install() {}, async pauseAt() {} },
    async goto() {},
    async waitForSelector() {},
    async addStyleTag() {},
    async emulateReducedMotion() {},
    async freezeAnimations() {},
    async evaluate<R>(expression: string): Promise<R> {
      if (expression.startsWith("Math.max")) return 1400 as R;
      if (expression.startsWith("(window.scrollTo")) return null as R;
      return extracted(options) as unknown as R;
    },
    async waitForFontsReady() {},
    async waitForLayoutStable() {},
    async wait() {},
    async screenshot() {
      return fakePng();
    },
    consoleEvents: () => [],
    failedRequests: () => [],
    async close() {},
  };
  return {
    async newContext() {
      return {
        async newPage() {
          return page;
        },
        async close() {},
      };
    },
    async close() {},
  };
}

const memorySink = (): ScreenshotSink => ({
  async put(key: string) {
    return key;
  },
});

const CONTEXT: ContextBlockInput = {
  tokens: {},
  brand: null,
  componentLibraries: [],
  uiDnaVersion: null,
  routes: ["/pricing"],
};

/**
 * A triage pass that always answers "no deep review needed, no suspects", and a
 * deep pass that reports one grounded finding if it is ever reached. That is the
 * exact shape the fix is about: the measurement, not the model, has to be what
 * decides here.
 */
function decliningModel(): {
  factory: (config: PassModelConfig) => ModelClient;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    backend: "mock",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      let text = "prose";
      if (system.startsWith("You are triaging")) {
        text = JSON.stringify({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] });
      } else if (request.responseFormat === "json_object" || request.responseFormat === "json_schema") {
        text = JSON.stringify({
          grade: "needs_work",
          overall: "The subtitle overflows its container.",
          findings: [
            {
              dimension: "responsiveness",
              severity: "major",
              confidence: 0.9,
              route: "/pricing",
              viewport: "desktop",
              elementRef: "#hero-title",
              title: "Subtitle overflows",
              description: "The subtitle text runs past the edge of its container.",
              suggestion: "Wrap the text.",
              introducedByThisPr: true,
            },
          ],
          notReviewed: [],
        });
      }
      return {
        text,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  };
  return { factory: () => client, requests };
}

async function review(overflowing: boolean): Promise<{
  outcome: LocalReviewOutcome;
  requests: ModelRequest[];
}> {
  const { factory, requests } = decliningModel();
  const outcome = await runLocalReview(
    {
      url: "http://127.0.0.1:5000",
      routes: ["/pricing"],
      // Both, because a target-size criterion is only measured where a finger
      // is the pointer, and the model findings below cite the desktop capture.
      viewports: ["mobile", "desktop"],
      installationId: "test",
      depth: "deep",
      context: CONTEXT,
    },
    { browser: fakeBrowser({ overflowing }), sink: memorySink(), modelFactory: factory },
  );
  return { outcome, requests };
}

describe("runLocalReview threads the measured breakage into triage", () => {
  it("forces a deep review over a triage pass that declined one", async () => {
    const { outcome, requests } = await review(true);

    // The capture measured it, with no model involved.
    expect(outcome.capture.deterministicFindings.map((f) => f.kind)).toContain("overflow");
    // The triage model said no. A deep pass ran anyway, and judged the route.
    const deepCalls = requests.filter(
      (r) => !(r.messages.find((m) => m.role === "system")?.content ?? "").startsWith("You are triaging"),
    );
    expect(deepCalls.length).toBeGreaterThan(0);
    expect(outcome.result.coverage?.routesReviewed).toEqual(["/pricing"]);
    expect(outcome.result.findings).toHaveLength(1);
    expect(outcome.result.grade).toBe("needs_work");
  });

  it("still takes the triage pass at its word when nothing was measured as broken", async () => {
    const { outcome, requests } = await review(false);

    expect(outcome.capture.deterministicFindings.map((f) => f.kind)).not.toContain("overflow");
    const deepCalls = requests.filter(
      (r) => !(r.messages.find((m) => m.role === "system")?.content ?? "").startsWith("You are triaging"),
    );
    expect(deepCalls).toHaveLength(0);
    // And the run says so rather than grading the page: triage had no baseline
    // to decline against, so nothing judged this page.
    expect(outcome.result.coverage?.routesReviewed).toEqual([]);
    expect(outcome.result.gradeUnavailableReason).toBe("nothing_reviewed");
    expect(outcome.result.overall).toContain("Nothing was reviewed");
  });

  it("does not treat contrast or an undersized touch target as breakage", async () => {
    // The same page always carries an undersized button. On the non-overflowing
    // run above that measurement exists and did NOT force a deep review, which
    // is the classification `BREAKAGE_KINDS` makes and this pins from the
    // shipped surface rather than from the helper.
    const { outcome } = await review(false);
    expect(outcome.capture.deterministicFindings.map((f) => f.kind)).toContain("touch_target");
    expect(outcome.result.coverage?.routesReviewed).toEqual([]);
  });
});

/** A deep pass that emits exactly the findings given, over a page triage cannot decline. */
function deepModel(findings: unknown[]): (config: PassModelConfig) => ModelClient {
  const client: ModelClient = {
    backend: "mock",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      const text = system.startsWith("You are triaging")
        ? JSON.stringify({ needsDeepReview: true, suspectRoutes: ["/pricing"], obviousBreakage: [] })
        : JSON.stringify({
            grade: "needs_work",
            overall: "The hero block is misaligned and the CTA is off-grid.",
            findings,
            notReviewed: [],
          });
      return {
        text,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  };
  return () => client;
}

function modelFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimension: "spacing",
    severity: "major",
    confidence: 0.9,
    route: "/pricing",
    viewport: "desktop",
    elementRef: "#hero-title",
    title: "Uneven gap",
    description: "The gap above the CTA is off the spacing scale.",
    suggestion: "Snap to the scale.",
    introducedByThisPr: true,
    ...over,
  };
}

async function reviewWith(
  findings: unknown[],
  capture: { overflowing: boolean; undersizedButton?: boolean } = { overflowing: true },
): Promise<LocalReviewOutcome> {
  return runLocalReview(
    {
      url: "http://127.0.0.1:5000",
      routes: ["/pricing"],
      // Both, because a target-size criterion is only measured where a finger
      // is the pointer, and the model findings below cite the desktop capture.
      viewports: ["mobile", "desktop"],
      installationId: "test",
      depth: "deep",
      context: CONTEXT,
    },
    {
      browser: fakeBrowser(capture),
      sink: memorySink(),
      modelFactory: deepModel(findings),
    },
  );
}

/**
 * The shipped pipeline, end to end, on a run that reviewed a route and then
 * deleted everything it found there. This is the run whose `review.json` read
 * `grade: "ship"`, `findings: []`, `hallucinationDrops: 2` and an `overall`
 * saying the review reported nothing about the page.
 */
describe("runLocalReview on a run whose findings were all deleted", () => {
  it("reports what the model produced and refuses to grade the page", async () => {
    // Both findings cite an element that is not in the geometry map, so the
    // grounding gate deletes both. The route was still reviewed.
    const outcome = await reviewWith([
      modelFinding({ elementRef: "#ghost" }),
      modelFinding({ elementRef: "#phantom", dimension: "typography" }),
    ]);

    expect(outcome.result.coverage?.routesReviewed).toEqual(["/pricing"]);
    expect(outcome.result.findings).toEqual([]);
    expect(outcome.result.hallucinationDrops).toBe(2);
    expect(outcome.modelFindingsSeen).toBe(2);
    // The grade in the file is what an empty findings list floors to, and the
    // file now says so in the field a program reads.
    expect(outcome.result.grade).toBe("ship");
    expect(outcome.result.gradeUnavailableReason).toBe("nothing_survived_validation");
    expect(outcome.result.overall).toContain("No finding in this review survived validation");
  });

  it("counts what the model produced, not what survived, when the cap did the deleting", async () => {
    // Two grounded blockers on different elements: the grounding gate drops
    // nothing and the trust-budget cap (1 blocker) deletes one. The old count,
    // survivors plus grounding-gate drops, reported 1 finding parsed for a model
    // that emitted 2, which understated the model on every capped run.
    const outcome = await reviewWith([
      modelFinding({ severity: "blocker", elementRef: "#hero-title" }),
      modelFinding({ severity: "blocker", elementRef: "#icon-close", dimension: "accessibility" }),
    ]);

    expect(outcome.hallucinationDrops).toBe(0);
    expect(outcome.result.findings).toHaveLength(1);
    expect(outcome.modelFindingsSeen).toBe(2);
    // REGRESSION GUARD: one finding survived, so this is a real verdict.
    expect(outcome.result).not.toHaveProperty("gradeUnavailableReason");
  });

  it("REGRESSION GUARD: a page the model found nothing wrong with keeps its grade", async () => {
    // Nothing measured AND nothing found. This is the earned `ship`, and it is
    // the one every retraction has to stay away from: retracting it would turn
    // every genuinely passing review into a run that says it assessed nothing.
    const outcome = await reviewWith([], { overflowing: false, undersizedButton: false });

    expect(outcome.capture.deterministicFindings).toEqual([]);
    expect(outcome.result.coverage?.routesReviewed).toEqual(["/pricing"]);
    expect(outcome.modelFindingsSeen).toBe(0);
    expect(outcome.result.findings).toEqual([]);
    expect(outcome.result.grade).toBe("ship");
    expect(outcome.result).not.toHaveProperty("gradeUnavailableReason");
    // Measured, and clean: the positive statement, never an absent field.
    expect(outcome.result.measurements).toEqual({
      checksRun: ["contrast", "overflow", "touch_target"],
      violations: [],
    });
  });
});

/**
 * The design-system half of the claim, on the path a reader actually runs.
 *
 * `runLocalReview` passed neither a genome index nor an embedder, so the deep
 * prompt's "Design-system rules (UI-DNA; trusted)" block was empty on every
 * review the CLI and the local HTTP server ever produced, while the deployed
 * composition filled it. The two compositions therefore disagreed about the one
 * thing the product is for. These pin both halves of the fix: the rules reach
 * the model when there is a design system, and the run says so in the result
 * when there is not.
 */
const GENOME_RULES: GenomeRule[] = [
  { id: "spacing.scale", text: JSON.stringify({ kind: "spacing", value: { scale: [4, 8, 12, 16] } }) },
  { id: "radius.card", text: JSON.stringify({ kind: "radius", value: { card: "12px" } }), component: "card" },
  { id: "color.cta", text: JSON.stringify({ kind: "color", value: { cta: "#4f46e5" } }), component: "button" },
];

const RESOLVED_GENOME: LocalGenome = {
  available: true,
  version: "ui-dna@2026.06.12",
  rules: GENOME_RULES,
  source: "/repo/ui-dna.json",
};

/** Every deep-pass user message this run sent, which is where the rules land. */
function deepPrompts(requests: ModelRequest[]): string[] {
  return requests
    .filter(
      (r) => !(r.messages.find((m) => m.role === "system")?.content ?? "").startsWith("You are triaging"),
    )
    .flatMap((r) => r.messages.filter((m) => m.role === "user").map((m) => m.content));
}

async function groundedReview(options: {
  genome?: LocalGenome;
  embedder?: Embedder | null;
}): Promise<{ outcome: LocalReviewOutcome; requests: ModelRequest[] }> {
  const requests: ModelRequest[] = [];
  const inner = deepModel([modelFinding()]);
  const factory = (config: PassModelConfig): ModelClient => {
    const client = inner(config);
    return {
      backend: client.backend,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request);
        return client.complete(request);
      },
    };
  };
  const outcome = await runLocalReview(
    {
      url: "http://127.0.0.1:5000",
      routes: ["/pricing"],
      viewports: ["desktop"],
      installationId: "test",
      depth: "deep",
      context: CONTEXT,
      ...(options.genome ? { genome: options.genome } : {}),
    },
    {
      browser: fakeBrowser({ overflowing: true }),
      sink: memorySink(),
      modelFactory: factory,
      ...(options.embedder === null
        ? {}
        : { embedder: options.embedder ?? lexicalEmbedder, embedderId: LEXICAL_EMBEDDER_ID }),
    },
  );
  return { outcome, requests };
}

describe("runLocalReview grounds the critique on the repository's design system", () => {
  it("puts the resolved genome's rules in the deep prompt and stamps the version", async () => {
    const { outcome, requests } = await groundedReview({ genome: RESOLVED_GENOME });

    const prompt = deepPrompts(requests).join("\n");
    expect(prompt).toContain("Design-system rules (UI-DNA; trusted):");
    for (const rule of GENOME_RULES) expect(prompt).toContain(rule.text);

    // The version travels on the context, so it reaches the wire result AND the
    // context block, which is the prefix-cache key: a review grounded on this
    // genome must not share a cache entry with one grounded on nothing.
    expect(outcome.result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12");
    expect(outcome.grounding).toMatchObject({
      grounded: true,
      uiDnaVersion: "ui-dna@2026.06.12",
      ruleCount: 3,
      embedder: LEXICAL_EMBEDDER_ID,
      authorityChecked: false,
    });
    // A grounded review is still a real review.
    expect(outcome.result.findings).toHaveLength(1);
  });

  it("treats its own grounding as unverifiable, because no authority service is reachable", async () => {
    const { outcome } = await groundedReview({ genome: RESOLVED_GENOME });

    // The engine's own vocabulary, not a second one invented for local runs: the
    // exact note `enforceGroundingAuthority` writes for unknown authority.
    expect(outcome.result.notReviewed.join("\n")).toContain(
      "grounding withheld: authority for UI-DNA version ui-dna@2026.06.12 was unknown at publish",
    );
    expect(outcome.result.blockingEnabled).toBe(false);
  });

  it("says so, in the result, when there was no design system to ground against", async () => {
    const { outcome, requests } = await groundedReview({});

    // The prompt is byte-identical to a run that never had a genome, which is
    // exactly why the result has to carry the statement.
    expect(deepPrompts(requests).join("\n")).not.toContain("Design-system rules");
    expect(outcome.result.metadata.uiDnaVersion).toBeNull();
    expect(outcome.grounding).toMatchObject({ grounded: false, reason: "no_genome_resolved" });

    const disclosure = outcome.result.notReviewed.find((line) =>
      line.startsWith(UNGROUNDED_DISCLOSURE_PREFIX),
    );
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain("no_genome_resolved");
    // And it does not overstate the loss: this run had no tokens and no brand
    // either, so it says the critique was rubric-only rather than implying some
    // other grounding carried it.
    expect(disclosure).toContain("built-in rubric alone");
  });

  it("carries the caller's own reason through, so a reader knows which file to add", async () => {
    const { outcome } = await groundedReview({
      genome: {
        available: false,
        reason: "no_genome_file",
        detail: "no UI-DNA snapshot was found at /repo/ui-dna.json",
      },
    });

    const disclosure = outcome.result.notReviewed.join("\n");
    expect(disclosure).toContain(UNGROUNDED_DISCLOSURE_PREFIX);
    expect(disclosure).toContain("no_genome_file");
    expect(disclosure).toContain("/repo/ui-dna.json");
  });

  it("refuses to report a genome with no rules as grounding", async () => {
    // A version string is not grounding. Stamping `uiDnaVersion` from a snapshot
    // that retrieves nothing is precisely the silent overclaim being removed.
    const { outcome, requests } = await groundedReview({
      genome: { available: true, version: "ui-dna@empty", rules: [], source: "/repo/ui-dna.json" },
    });

    expect(deepPrompts(requests).join("\n")).not.toContain("Design-system rules");
    expect(outcome.result.metadata.uiDnaVersion).toBeNull();
    expect(outcome.grounding).toMatchObject({ grounded: false, reason: "genome_has_no_rules" });
  });

  it("fails loudly rather than reviewing without the design system it was given", async () => {
    // The deployed composition throws on this exact pairing. A local run that
    // quietly dropped the genome would reintroduce the defect one layer down.
    await expect(
      groundedReview({ genome: RESOLVED_GENOME, embedder: null }),
    ).rejects.toThrow(/no embedder is configured/);
  });

  it("embeds the rules once and the route query once, and never calls out per rule", async () => {
    const batches: string[][] = [];
    const counting: Embedder = async (texts) => {
      batches.push([...texts]);
      return lexicalEmbedder(texts);
    };
    await groundedReview({ genome: RESOLVED_GENOME, embedder: counting });

    // One call to index the genome, one to embed the route queries. The seam is
    // the same one the deployed path uses, so a metered embedding service is
    // charged the same way from here.
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(GENOME_RULES.map((rule) => rule.text));
    expect(batches[1]).toEqual(["/pricing"]);
  });
});

/**
 * The audit's run, end to end on the shipped local pipeline: a page the engine
 * itself measured violations on, and a judge that answered with nothing at all.
 *
 * This is the shape the injected demo page produces against a weak model. It
 * used to publish `grade: "ship"`, `findings: []`, `hallucinationDrops: 0` and
 * nowhere in the payload a reader could see the three violations the engine had
 * just computed. Both halves of that are closed here: the measurements are on
 * the result, and the grade is retracted.
 */
describe("runLocalReview on a page it measured and nothing judged", () => {
  it("retracts the grade and publishes what it measured", async () => {
    const outcome = await reviewWith([]);

    // The grade field itself is BYTE-UNCHANGED. Nothing floors it, nothing
    // computes it from a measurement; the retraction sits beside it.
    expect(outcome.result.grade).toBe("ship");
    expect(outcome.result.gradeUnavailableReason).toBe("measured_facts_unjudged");
    expect(outcome.result.coverage?.routesReviewed).toEqual(["/pricing"]);
    expect(outcome.modelFindingsSeen).toBe(0);
    expect(outcome.result.findings).toEqual([]);
    expect(outcome.result.hallucinationDrops).toBe(0);

    const kinds = (outcome.result.measurements?.violations ?? []).map((v) => v.kind);
    expect(kinds).toContain("overflow");
    expect(kinds).toContain("touch_target");
    expect(outcome.result.overall).toContain("do not meet threshold");
    // No measurement is ever a finding.
    expect(outcome.result.findings).toHaveLength(0);
  });

  it("a single surviving finding suppresses the retraction entirely", async () => {
    // The finding cites `#hero-title`, which no measurement names. The rule is
    // not "did the model cover what was measured", it is "did the model speak".
    const outcome = await reviewWith([modelFinding({ elementRef: "#hero-title" })]);

    expect(outcome.result.findings).toHaveLength(1);
    expect(outcome.result).not.toHaveProperty("gradeUnavailableReason");
    expect(outcome.result.grade).toBe("needs_work");
    // And the measurements are published under that grade all the same.
    expect((outcome.result.measurements?.violations ?? []).length).toBeGreaterThan(0);
  });

  it("a model that spoke and was deleted still reports nothing_survived_validation", async () => {
    // Precedence, pinned: `modelFindingsSeen > 0` is the older and more specific
    // statement, and a measured page must not steal it.
    const outcome = await reviewWith([modelFinding({ elementRef: "#ghost" })]);

    expect(outcome.modelFindingsSeen).toBe(1);
    expect(outcome.result.findings).toEqual([]);
    expect(outcome.result.gradeUnavailableReason).toBe("nothing_survived_validation");
  });
});
