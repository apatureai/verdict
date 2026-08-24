import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signEngineRequest, type ApiRequest } from "@apatureai/verdict-api";
import { fixturesDir } from "@apatureai/verdict-cli";
import { NO_MODEL_DISCLOSURE_PREFIX, type EngineReviewResult } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { assertAttested, createLocalEngine, LocalEngineError } from "../src/index.js";

/**
 * The rule this file pins: when the HTTP path cannot do what it claims, it says
 * so with a typed failure. It never answers `state: "completed"` over a
 * well-formed result with an empty `findings` array, which a caller cannot tell
 * apart from a page with nothing wrong with it.
 */

const SECRET = "serve-failure-secret";
const DEMO_ROOT = join(fixturesDir(), "demo-site");

function signed(method: string, path: string, bodyObj?: unknown): ApiRequest {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  return {
    method,
    path,
    headers: signEngineRequest({ body, installationId: "local", secret: SECRET }),
    body,
  };
}

function reviewRequest(): Record<string, unknown> {
  return {
    installationId: "local",
    repository: { owner: "apatureai", name: "demo", defaultBranch: "main" },
    pullRequest: { number: 1, headSha: "abc123", baseSha: "def456", title: "Demo", body: null },
    preview: { url: "http://127.0.0.1:1/", provider: "local", environment: null },
    config: {
      preview: {
        source: "local",
        environment: "preview",
        urlTemplate: null,
        waitSeconds: 0,
        readySelector: null,
        readyPath: null,
        readyStatus: null,
        protectionBypassSecretName: null,
        authStateSecretName: null,
        forkPreview: false,
      },
      routes: { always: ["/"], maxPerPr: 5, map: {} },
      viewports: ["mobile"],
      darkMode: false,
      brand: null,
      rules: { gate: "nits", minSeverityToComment: "nit", suppress: [] },
      tokens: { source: null, values: {} },
    },
    publishMode: "advisory",
    depth: "deep",
  };
}

describe("a deployment that cannot capture", () => {
  it("fails the job with capture_unavailable rather than returning a review of nothing", async () => {
    const engine = await createLocalEngine({
      secret: SECRET,
      outRoot: await mkdtemp(join(tmpdir(), "je-serve-nobrowser-")),
      contextDir: DEMO_ROOT,
      model: "canned",
      env: {},
      workerPollMs: 600_000,
      launchBrowser: async () => {
        throw new Error("Executable doesn't exist at /nonexistent/chromium");
      },
    });
    try {
      const post = await engine.handle(
        signed("POST", "/jobs", {
          idempotencyKey: "no-browser",
          depth: "deep",
          request: reviewRequest(),
        }),
      );
      expect(post.status).toBe(202);
      const jobId = (post.body as { jobId: string }).jobId;
      await engine.drainOnce();

      const got = await engine.handle(signed("GET", `/jobs/${jobId}`));
      const body = got.body as { state: string; error?: string; result?: EngineReviewResult };
      expect(body.state).toBe("failed");
      expect(body.error).toContain("capture_unavailable");
      // The operator gets the real reason, not a generic one.
      expect(body.error).toContain("Executable doesn't exist");
      expect(body.result).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it("reports itself not ready, because readiness here means it can capture", async () => {
    const engine = await createLocalEngine({
      secret: SECRET,
      outRoot: await mkdtemp(join(tmpdir(), "je-serve-notready-")),
      model: "canned",
      env: {},
      workerPollMs: 600_000,
      launchBrowser: async () => {
        throw new Error("no chromium");
      },
    });
    try {
      const port = await engine.listen(0);
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({
        status: "not_ready",
        components: { database: true, capture: false, worker: true },
      });
    } finally {
      await engine.close();
    }
  });
});

describe("the publication guard", () => {
  const base: EngineReviewResult = {
    grade: "ship",
    overall: "nothing to report",
    blockingEnabled: false,
    confidenceUnavailableReason: "missing_calibration_report",
    findings: [],
    notReviewed: [],
    artifacts: { annotatedScreenshots: [] },
    screenshotRetentionSeconds: 0,
    metadata: {
      engineVersion: "test",
      model: "test-model",
      promptVersion: "test",
      captureVersion: "test",
      rubricVersion: "design-rubric@1",
      uiDnaVersion: null,
    },
    coverage: {
      routesRequested: ["/"],
      routesReviewed: ["/"],
      viewportsRequested: ["mobile"],
      viewportsReviewed: ["mobile"],
    },
  };

  it("refuses a result carrying no judgment provenance at all", () => {
    expect(() => assertAttested(base)).toThrow(LocalEngineError);
    expect(() => assertAttested(base)).toThrow(/unattested_result/);
  });

  it("refuses an unjudged result whose prose does not disclose it", () => {
    expect(() =>
      assertAttested({
        ...base,
        provenance: {
          model_backed: false,
          source: "canned",
          engine: "verdict-http",
          model: null,
          detail: "a stand-in produced this",
        },
      }),
    ).toThrow(/without its notReviewed disclosure/);
  });

  it("passes an unjudged result that discloses it, and a model-backed one", () => {
    const disclosed: EngineReviewResult = {
      ...base,
      notReviewed: [`${NO_MODEL_DISCLOSURE_PREFIX}: a stand-in produced this.`],
      provenance: {
        model_backed: false,
        source: "canned",
        engine: "verdict-http",
        model: null,
        detail: "a stand-in produced this",
      },
    };
    expect(assertAttested(disclosed)).toBe(disclosed);

    const judged: EngineReviewResult = {
      ...base,
      provenance: {
        model_backed: true,
        source: "model",
        engine: "verdict-http",
        model: "test-model",
        detail: "a vision model judged the capture",
      },
    };
    expect(assertAttested(judged)).toBe(judged);
  });

  it("refuses a result that states no coverage, however well attested (#165)", () => {
    const { coverage: _dropped, ...withoutCoverage } = base;
    expect(() =>
      assertAttested({
        ...(withoutCoverage as EngineReviewResult),
        provenance: {
          model_backed: true,
          source: "model",
          engine: "verdict-http",
          model: "test-model",
          detail: "a vision model judged the capture",
        },
      }),
    ).toThrow(/without stating what it reviewed/);
  });

  it("refuses a well-attested result that judged no route and gave no reason", () => {
    // The half of the question provenance cannot answer. A live model WAS
    // called, so `model_backed: true` is truthful, and the run still judged
    // nothing: provenance says a model was called, coverage says what it was
    // called ON. An empty reviewed set with an empty `notReviewed` is a green
    // grade with nothing behind it and no way for a reader to tell.
    expect(() =>
      assertAttested({
        ...base,
        coverage: { routesRequested: ["/"], routesReviewed: [], viewportsRequested: ["mobile"], viewportsReviewed: [] },
        provenance: {
          model_backed: true,
          source: "model",
          engine: "verdict-http",
          model: "test-model",
          detail: "a vision model judged the capture",
        },
      }),
    ).toThrow(/judged no route/);
  });

  it("serves a result that judged no route when it says why", () => {
    // An empty capture, a triage that named nothing, a route with no baseline
    // to confirm against: all real, honest results, and all still servable. The
    // guard is on the missing REASON, never on the empty reviewed set itself.
    const explained: EngineReviewResult = {
      ...base,
      coverage: { routesRequested: ["/"], routesReviewed: [], viewportsRequested: ["mobile"], viewportsReviewed: [] },
      notReviewed: ["/: triage answered that no deep review was needed, but this run carried no baseline"],
      gradeUnavailableReason: "nothing_reviewed",
      provenance: {
        model_backed: true,
        source: "model",
        engine: "verdict-http",
        model: "test-model",
        detail: "a vision model judged the capture",
      },
    };
    expect(assertAttested(explained)).toBe(explained);
  });

  it("refuses a result that judged no route and still asserts its grade", () => {
    // The reason above is prose, and a caller is under no obligation to read
    // prose. `gradeUnavailableReason` is the same statement in the field a
    // program branches on, and every result this server produces carries it, so
    // a missing one is a code path that forgot rather than an old payload.
    expect(() =>
      assertAttested({
        ...base,
        coverage: { routesRequested: ["/"], routesReviewed: [], viewportsRequested: ["mobile"], viewportsReviewed: [] },
        notReviewed: ["/: nothing was captured"],
        provenance: {
          model_backed: true,
          source: "model",
          engine: "verdict-http",
          model: "test-model",
          detail: "a vision model judged the capture",
        },
      }),
    ).toThrow(/still asserting its grade/);
  });

  it("does not demand a retraction from a review that actually reviewed something", () => {
    const real: EngineReviewResult = {
      ...base,
      provenance: {
        model_backed: true,
        source: "model",
        engine: "verdict-http",
        model: "test-model",
        detail: "a vision model judged the capture",
      },
    };
    expect(real.gradeUnavailableReason).toBeUndefined();
    expect(assertAttested(real)).toBe(real);
  });
  // The run that assessed nothing while reporting full coverage: the route was
  // reviewed, the model produced findings, and the grounding gate deleted every
  // one of them. Both guards above pass it, because both are keyed on coverage
  // and coverage here is honest.
  const modelBacked = {
    model_backed: true,
    source: "model",
    engine: "verdict-http",
    model: "test-model",
    detail: "a vision model judged the capture",
  } as const;

  it("refuses a result whose every finding was deleted and still asserts its grade", () => {
    expect(() =>
      assertAttested({
        ...base,
        findings: [],
        hallucinationDrops: 2,
        notReviewed: [],
        provenance: modelBacked,
      }),
    ).toThrow(/every finding was deleted/);
  });

  it("serves that result once it retracts the grade", () => {
    const retracted: EngineReviewResult = {
      ...base,
      findings: [],
      hallucinationDrops: 2,
      gradeUnavailableReason: "nothing_survived_validation",
      provenance: modelBacked,
    };
    expect(assertAttested(retracted)).toBe(retracted);
  });

  it("does not demand a retraction from a clean page", () => {
    // Zero findings and zero drops: nothing entered validation, so nothing was
    // deleted, and the `ship` grade beside it is one the review earned. This is
    // the guard's blast radius, and it has to stay empty.
    const clean: EngineReviewResult = {
      ...base,
      findings: [],
      hallucinationDrops: 0,
      provenance: modelBacked,
    };
    expect(clean.gradeUnavailableReason).toBeUndefined();
    expect(assertAttested(clean)).toBe(clean);
  });

  it("does not demand a retraction from a review that only lost some findings", () => {
    const partial: EngineReviewResult = {
      ...base,
      grade: "needs_work",
      findings: [
        {
          id: "f_001",
          severity: "major",
          title: "Uneven gap",
          description: "uneven gap above the CTA",
          route: "/",
          viewport: "mobile",
          element: "#cta",
          screenshotId: null,
          suggestion: null,
        },
      ],
      hallucinationDrops: 2,
      provenance: modelBacked,
    };
    expect(partial.gradeUnavailableReason).toBeUndefined();
    expect(assertAttested(partial)).toBe(partial);
  });
});
