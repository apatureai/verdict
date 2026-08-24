import { signEngineRequest } from "@apatureai/verdict-api";
import type { ModelClientFactory, ModelRequest, ModelResponse } from "@apatureai/verdict-critique";
import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import { JobStore } from "@apatureai/verdict-jobs";
import { InMemoryObjectStore, type ObjectStore } from "@apatureai/verdict-storage";
import {
  NO_MODEL_DISCLOSURE_PREFIX,
  type Capture,
  type CaptureContext,
  type EngineReviewResult,
  type Finding,
} from "@apatureai/verdict-types";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAttested,
  assertEvidenceResolvable,
  createEngineRuntime,
  screenshotIdForCapture,
  signEvidenceUrls,
  stampJudgmentProvenance,
  witnessModelCalls,
  type CaptureClient,
  type EngineRuntime,
} from "../src/index.js";

/**
 * What the deployable composition publishes about itself.
 *
 * Two things were missing from every result the production service produced,
 * and both are things a caller of the HTTP job API has no other way to learn.
 * It stamped no judgment provenance, so a polled result asserted a grade with no
 * in-band statement of what produced it. And it bound neither wire-projection
 * evidence seam, so every finding carried `screenshotId: null` and
 * `artifacts.annotatedScreenshots` was empty whatever the capture fleet had
 * rendered, which is exactly the pair of fields Gate renders evidence links
 * from.
 *
 * These tests drive the real HTTP server: a signed job in, a polled result out.
 * Nothing here asserts on an in-process return value that a served payload could
 * disagree with.
 */

const SECRET = "publication-secret";
const VIEWPORT = "desktop" as const;
const HOME_SHOT = "jobs/capture/home-desktop.png";

function reviewRequest() {
  return {
    installationId: "tenant_1",
    repository: { owner: "apatureai", name: "demo", defaultBranch: "main" },
    pullRequest: {
      number: 42,
      headSha: "head-sha",
      baseSha: "base-sha",
      title: "Demo PR",
      body: null,
    },
    preview: { url: "https://preview.example.test", provider: "vercel" as const, environment: "Preview" },
    config: {
      preview: {
        source: "vercel" as const,
        environment: "Preview",
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
      viewports: [VIEWPORT],
      darkMode: false,
      brand: null,
      rules: { gate: "none" as const, minSeverityToComment: "nit" as const, suppress: [] },
      tokens: { source: null, values: {} },
    },
    publishMode: "advisory" as const,
    depth: "deep" as const,
  };
}

function capturedHome(): Capture {
  return {
    images: [{ route: "/", viewport: VIEWPORT, objectKey: HOME_SHOT, width: 1280, height: 720 }],
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: "capture-http@1",
  };
}

function capturedNothing(): Capture {
  return {
    images: [],
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: "capture-http@1",
  };
}

function captureClientFor(capture: Capture): CaptureClient {
  return {
    forJob: (_jobId: string, signal: AbortSignal) => async (_url: string, _ctx: CaptureContext) => {
      if (signal.aborted) throw new Error("aborted");
      return capture;
    },
    cancel: async () => undefined,
    ready: async () => true,
  };
}

/**
 * A judge that asks for a deep review and returns one finding on the captured
 * route. The deep pass is two calls: the grounded critique over the images, then
 * a text-only JSON coercion of its prose. That split is deliberate here, because
 * only the first of the two ever saw a pixel.
 */
function judgingModelFactory(findingViewport: string = VIEWPORT): ModelClientFactory {
  return () => ({
    backend: "mock",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.startsWith("You are triaging")) {
        return {
          text: JSON.stringify({ needsDeepReview: true, suspectRoutes: ["/"], obviousBreakage: [] }),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      }
      if (request.responseFormat === "json_object") {
        return {
          text: JSON.stringify({
            grade: "needs_work",
            overall: "The hero subtitle is unreadable.",
            findings: [{
              dimension: "typography",
              severity: "major",
              confidence: 0.8,
              route: "/",
              viewport: findingViewport,
              elementRef: null,
              title: "Hero subtitle is unreadable",
              description: "The hero subtitle sits at 2.3:1 against its background.",
              suggestion: "Darken the subtitle.",
              introducedByThisPr: true,
            }],
            notReviewed: [],
          }),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      }
      return {
        text: "structured critique",
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  });
}

interface ServedJob {
  /** The payload the server answered `GET /jobs/:id` with, parsed. */
  payload: { jobId: string; state: string; result?: EngineReviewResult; error?: string };
  /** The same payload's bytes, exactly as they crossed the socket. */
  body: string;
}

describe("what the deployable composition publishes", () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  async function serveJob(options: {
    capture: Capture;
    modelFactory?: ModelClientFactory;
    objectStore?: ObjectStore;
    evidenceUrlTtlSeconds?: number;
  }): Promise<ServedJob> {
    const db = new PGlite();
    const exec = pgliteExecutor(db);
    await runMigrations(exec);
    runtime = createEngineRuntime({
      store: new JobStore(exec),
      objectStore: options.objectStore ?? new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture: captureClientFor(options.capture),
      modelFactory: options.modelFactory ?? judgingModelFactory(),
      databaseReady: async () => true,
      workerPollMs: 5,
      workerMaxAttempts: 1,
      ...(options.evidenceUrlTtlSeconds !== undefined
        ? { evidenceUrlTtlSeconds: options.evidenceUrlTtlSeconds }
        : {}),
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const submitBody = JSON.stringify({
      idempotencyKey: "publication",
      depth: "deep",
      request: reviewRequest(),
    });
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: signEngineRequest({ body: submitBody, installationId: "tenant_1", secret: SECRET }),
      body: submitBody,
    });
    expect(submit.status).toBe(202);
    const { jobId } = await submit.json() as { jobId: string };

    for (let attempt = 0; attempt < 400; attempt++) {
      const headers = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
      const response = await fetch(`${base}/jobs/${jobId}`, { headers });
      const body = await response.text();
      const payload = JSON.parse(body) as ServedJob["payload"];
      if (payload.state === "completed" || payload.state === "failed") return { payload, body };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("review did not settle");
  }

  it("states in the payload that a model judged the page, and which one", async () => {
    const { payload } = await serveJob({ capture: capturedHome() });
    expect(payload.state).toBe("completed");
    const result = payload.result as EngineReviewResult;
    expect(result.provenance).toBeDefined();
    expect(result.provenance).toMatchObject({
      model_backed: true,
      source: "model",
      engine: "verdict-http",
      // Observed, not configured: the id of the last call that was handed a
      // capture of the target, which is the deep pass rather than the text-only
      // coercion that followed it.
      model: "qwen3-vl-plus",
    });
    expect(result.provenance?.detail).toContain("qwen3-vl-plus");
    // And it is the payload that says so, not a terminal an HTTP caller cannot see.
    expect(result.notReviewed.some((line) => line.startsWith(NO_MODEL_DISCLOSURE_PREFIX))).toBe(false);
  });

  it("gives every finding a screenshot and an artifact link a reader can open", async () => {
    const { payload } = await serveJob({ capture: capturedHome() });
    const result = payload.result as EngineReviewResult;
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    // The durable object key of the shot of this finding's own route + viewport.
    expect(finding?.screenshotId).toBe(HOME_SHOT);
    expect(result.artifacts.annotatedScreenshots).toHaveLength(1);
    const evidence = result.artifacts.annotatedScreenshots[0];
    expect(evidence?.findingId).toBe(finding?.id);
    // A URL, not the object key the projection wrote there.
    expect(evidence?.url).not.toBe(HOME_SHOT);
    expect(URL.canParse(evidence?.url ?? "")).toBe(true);
    expect(evidence?.url).toContain(HOME_SHOT);
  });

  it("mints the evidence link at publication with the configured lifetime", async () => {
    const store = new InMemoryObjectStore();
    const before = Date.now();
    const { payload } = await serveJob({
      capture: capturedHome(),
      objectStore: store,
      evidenceUrlTtlSeconds: 120,
    });
    const url = new URL((payload.result as EngineReviewResult).artifacts.annotatedScreenshots[0]?.url ?? "");
    // `InMemoryObjectStore` signs the expiry into the URL, so the TTL that
    // reaches the object store is observable from the served payload.
    const expires = Number(url.searchParams.get("expires"));
    expect(expires).toBeGreaterThanOrEqual(before + 120_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("leaves a finding with no captured shot pointing at nothing rather than at the wrong shot", async () => {
    // The capture covers desktop only; the model reports the finding on mobile.
    // There is no annotated screenshot of that, and the neighbouring desktop
    // shot is a picture of something else.
    const { payload } = await serveJob({
      capture: capturedHome(),
      modelFactory: judgingModelFactory("mobile"),
    });
    const result = payload.result as EngineReviewResult;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.screenshotId).toBeNull();
    expect(result.artifacts.annotatedScreenshots).toEqual([]);
  });

  it("says nothing judged the page when nothing was captured, and keeps the reason it already gave", async () => {
    const { payload } = await serveJob({ capture: capturedNothing() });
    const result = payload.result as EngineReviewResult;
    expect(result.provenance).toMatchObject({
      model_backed: false,
      source: "canned",
      engine: "verdict-http",
      model: null,
    });
    expect(result.notReviewed[0]?.startsWith(NO_MODEL_DISCLOSURE_PREFIX)).toBe(true);
    // The projection had already retracted the grade and said why in `overall`.
    // The stamp adds to that statement; it does not overwrite it with a vaguer one.
    expect(result.gradeUnavailableReason).toBe("nothing_reviewed");
    expect(result.overall).toContain("Nothing was reviewed");
  });

  it("counts a model that looked at the page even when nothing reached a judgment", async () => {
    // Triage is handed the capture and answers that no deep review is needed.
    // A model WAS called on a capture of the target, so provenance says so; what
    // it was called on and what reached a judgment is coverage's question, and
    // coverage answers it separately.
    const declining: ModelClientFactory = () => ({
      backend: "mock",
      async complete(): Promise<ModelResponse> {
        return {
          text: JSON.stringify({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] }),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      },
    });
    const { payload } = await serveJob({ capture: capturedHome(), modelFactory: declining });
    const result = payload.result as EngineReviewResult;
    expect(result.provenance).toMatchObject({ model_backed: true, model: "qwen3-vl-flash" });
    expect(result.coverage?.routesReviewed).toEqual([]);
    expect(result.gradeUnavailableReason).toBe("nothing_reviewed");
  });

  it("fails the attempt rather than publishing evidence that opens nothing", async () => {
    // The object store cannot mint the link. Publishing the durable object key in
    // a `url` field would look like evidence and resolve to nothing, so the
    // attempt fails and no result is published at all.
    const unsignable = new InMemoryObjectStore();
    unsignable.signedGetUrl = async () => {
      throw new Error("presigner unavailable");
    };
    const { payload } = await serveJob({ capture: capturedHome(), objectStore: unsignable });
    expect(payload.state).toBe("failed");
    expect(payload.error).toContain("presigner unavailable");
    expect(payload.result).toBeUndefined();
  });
});

describe("witnessModelCalls", () => {
  const factory: ModelClientFactory = (config) => ({
    backend: "mock",
    async complete(): Promise<ModelResponse> {
      return {
        text: `answer from ${config.model}`,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  });

  const request = (model: string, withImages: boolean): ModelRequest => ({
    model,
    messages: [{
      role: "user",
      content: "critique this",
      ...(withImages ? { images: [{ objectKey: HOME_SHOT, route: "/", viewport: VIEWPORT }] } : {}),
    }],
    thinking: false,
  });

  it("attests nothing before anything has been asked of the model", () => {
    const witness = witnessModelCalls(factory);
    witness.factory({ model: "qwen3-vl-plus", backend: "dashscope", thinking: true });
    // Constructing a client is configuration. Provenance is about what ran.
    expect(witness.provenance()).toMatchObject({ model_backed: false, model: null });
  });

  it("does not count a text-only call as a judgment of the page", async () => {
    const witness = witnessModelCalls(factory);
    const client = witness.factory({ model: "qwen3-vl-plus", backend: "dashscope", thinking: false });
    await client.complete(request("qwen3-vl-plus", false));
    const provenance = witness.provenance();
    expect(provenance.model_backed).toBe(false);
    expect(provenance.detail).toContain("text-only");
  });

  it("does not count a call that threw", async () => {
    const throwing: ModelClientFactory = () => ({
      backend: "mock",
      complete: async () => {
        throw new Error("upstream refused");
      },
    });
    const witness = witnessModelCalls(throwing);
    const client = witness.factory({ model: "qwen3-vl-plus", backend: "dashscope", thinking: false });
    await expect(client.complete(request("qwen3-vl-plus", true))).rejects.toThrow("upstream refused");
    expect(witness.provenance().model_backed).toBe(false);
  });

  it("reports the last model that was handed a capture, and passes the answer through", async () => {
    const witness = witnessModelCalls(factory);
    const triage = witness.factory({ model: "qwen3-vl-flash", backend: "dashscope", thinking: false });
    const deep = witness.factory({ model: "qwen3-vl-plus", backend: "dashscope", thinking: true });
    expect((await triage.complete(request("qwen3-vl-flash", true))).text).toBe("answer from qwen3-vl-flash");
    await deep.complete(request("qwen3-vl-plus", true));
    await deep.complete(request("qwen3-vl-plus", false));
    expect(witness.provenance()).toMatchObject({
      model_backed: true,
      source: "model",
      model: "qwen3-vl-plus",
    });
    // Counted per model, not as one running total. Triage and the deep pass are
    // different models here: flash saw one capture and plus saw one. Attributing
    // both to plus was an overclaim inside the field whose whole job is to stop
    // the engine overclaiming.
    const detail = witness.provenance().detail;
    expect(detail).toContain("qwen3-vl-plus judged 1 capture of it");
    expect(detail).toContain("after 1 earlier triage capture");
    expect(detail).not.toContain("2 captures");
  });

  it("says nothing about other models when only one saw a capture", async () => {
    const witness = witnessModelCalls(factory);
    const deep = witness.factory({ model: "qwen3-vl-plus", backend: "dashscope", thinking: true });
    await deep.complete(request("qwen3-vl-plus", true));
    await deep.complete(request("qwen3-vl-plus", true));
    const detail = witness.provenance().detail;
    expect(detail).toContain("qwen3-vl-plus judged 2 captures of it");
    expect(detail).not.toContain("earlier triage");
  });
});

describe("screenshotIdForCapture", () => {
  const capture: Capture = {
    images: [
      { route: "/", viewport: "desktop", objectKey: "shot/home-desktop.png", width: 1280, height: 720 },
      { route: "/", viewport: "mobile", objectKey: "shot/home-mobile.png", width: 390, height: 844 },
    ],
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: "capture-http@1",
  };
  const finding = (route: string, viewport: Finding["viewport"]): Finding => ({
    dimension: "typography",
    severity: "major",
    confidence: 0.8,
    route,
    viewport,
    elementRef: null,
    title: "t",
    description: "d",
    suggestion: null,
    introducedByThisPr: true,
  });

  it("matches the shot of the finding's own route and viewport", () => {
    const resolve = screenshotIdForCapture(capture);
    expect(resolve(finding("/", "desktop"))).toBe("shot/home-desktop.png");
    expect(resolve(finding("/", "mobile"))).toBe("shot/home-mobile.png");
  });

  it("answers null rather than offering a picture of something else", () => {
    const resolve = screenshotIdForCapture(capture);
    expect(resolve(finding("/", "tablet"))).toBeNull();
    expect(resolve(finding("/pricing", "desktop"))).toBeNull();
  });
});

describe("signEvidenceUrls", () => {
  const result = (findings: Array<{ id: string; screenshotId: string | null }>): EngineReviewResult => ({
    grade: "needs_work",
    overall: "o",
    blockingEnabled: false,
    findings: findings.map((finding) => ({
      id: finding.id,
      severity: "major",
      title: "t",
      description: "d",
      route: "/",
      viewport: VIEWPORT,
      element: null,
      screenshotId: finding.screenshotId,
      suggestion: null,
    })),
    notReviewed: [],
    artifacts: {
      annotatedScreenshots: findings
        .filter((finding) => finding.screenshotId !== null)
        .map((finding) => ({ findingId: finding.id, url: finding.screenshotId as string })),
    },
    screenshotRetentionSeconds: 0,
    metadata: {
      engineVersion: "0.1.0",
      model: "qwen3-vl-plus",
      promptVersion: "system-prompt@v4",
      captureVersion: "capture-http@1",
      rubricVersion: "design-rubric@1",
      uiDnaVersion: null,
    },
  });

  it("signs each distinct object key once, however many findings cite it", async () => {
    const signed: string[] = [];
    const out = await signEvidenceUrls(
      result([
        { id: "f_001", screenshotId: "shot/a.png" },
        { id: "f_002", screenshotId: "shot/a.png" },
        { id: "f_003", screenshotId: "shot/b.png" },
      ]),
      async (key) => {
        signed.push(key);
        return `https://cdn.test/${key}?sig=1`;
      },
    );
    expect(signed).toEqual(["shot/a.png", "shot/b.png"]);
    expect(out.artifacts.annotatedScreenshots).toEqual([
      { findingId: "f_001", url: "https://cdn.test/shot/a.png?sig=1" },
      { findingId: "f_002", url: "https://cdn.test/shot/a.png?sig=1" },
      { findingId: "f_003", url: "https://cdn.test/shot/b.png?sig=1" },
    ]);
  });

  it("propagates a signing failure instead of leaving an object key in a url", async () => {
    await expect(signEvidenceUrls(result([{ id: "f_001", screenshotId: "shot/a.png" }]), async () => {
      throw new Error("presigner unavailable");
    })).rejects.toThrow("presigner unavailable");
  });

  it("touches nothing when the run produced no evidence", async () => {
    const empty = result([{ id: "f_001", screenshotId: null }]);
    await expect(signEvidenceUrls(empty, async () => {
      throw new Error("must not sign");
    })).resolves.toBe(empty);
  });
});

describe("publication guards", () => {
  const base: EngineReviewResult = {
    grade: "ship",
    overall: "o",
    blockingEnabled: false,
    findings: [],
    notReviewed: [],
    artifacts: { annotatedScreenshots: [] },
    screenshotRetentionSeconds: 0,
    metadata: {
      engineVersion: "0.1.0",
      model: "qwen3-vl-plus",
      promptVersion: "system-prompt@v4",
      captureVersion: "capture-http@1",
      rubricVersion: "design-rubric@1",
      uiDnaVersion: null,
    },
  };

  it("refuses a result that cannot say what produced it", () => {
    expect(() => assertAttested(base)).toThrow(/no judgment provenance/);
  });

  it("refuses an unjudged result that does not disclose it in prose", () => {
    const unattested: EngineReviewResult = {
      ...base,
      provenance: {
        model_backed: false,
        source: "canned",
        engine: "verdict-http",
        model: null,
        detail: "nothing ran",
      },
    };
    expect(() => assertAttested(unattested)).toThrow(/without its notReviewed disclosure/);
    expect(assertAttested(stampJudgmentProvenance(base, unattested.provenance!))).toBeDefined();
  });

  it("accepts a judged result untouched", () => {
    const judged = stampJudgmentProvenance(base, {
      model_backed: true,
      source: "model",
      engine: "verdict-http",
      model: "qwen3-vl-plus",
      detail: "a model judged it",
    });
    expect(assertAttested(judged)).toBe(judged);
    expect(judged.overall).toBe("o");
    expect(judged.notReviewed).toEqual([]);
  });

  it("writes the disclosure into overall only when the result has not already retracted its grade", () => {
    const provenance = {
      model_backed: false as const,
      source: "canned" as const,
      engine: "verdict-http",
      model: null,
      detail: "nothing ran",
    };
    expect(stampJudgmentProvenance(base, provenance).overall).toMatch(NO_MODEL_DISCLOSURE_PREFIX);
    const retracted: EngineReviewResult = {
      ...base,
      overall: "Nothing was reviewed: 0 of 1 requested route(s) reached a judgment in this run.",
      gradeUnavailableReason: "nothing_reviewed",
    };
    expect(stampJudgmentProvenance(retracted, provenance).overall).toBe(retracted.overall);
  });

  it("refuses a finding whose screenshot has no artifact reference", () => {
    const orphaned: EngineReviewResult = {
      ...base,
      findings: [{
        id: "f_001",
        severity: "major",
        title: "t",
        description: "d",
        route: "/",
        viewport: VIEWPORT,
        element: null,
        screenshotId: HOME_SHOT,
        suggestion: null,
      }],
    };
    expect(() => assertEvidenceResolvable(orphaned)).toThrow(/no artifact reference/);
  });

  it("refuses an artifact reference that is still an object key", () => {
    const unsigned: EngineReviewResult = {
      ...base,
      findings: [{
        id: "f_001",
        severity: "major",
        title: "t",
        description: "d",
        route: "/",
        viewport: VIEWPORT,
        element: null,
        screenshotId: HOME_SHOT,
        suggestion: null,
      }],
      artifacts: { annotatedScreenshots: [{ findingId: "f_001", url: HOME_SHOT }] },
    };
    expect(() => assertEvidenceResolvable(unsigned)).toThrow(/cannot open an object key/);
  });

  it("leaves a result with no evidence to resolve alone", () => {
    expect(assertEvidenceResolvable(base)).toBe(base);
  });
});
