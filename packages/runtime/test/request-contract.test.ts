import { signEngineRequest } from "@apatureai/verdict-api";
import type { ModelClientFactory, ModelRequest, ModelResponse } from "@apatureai/verdict-critique";
import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import { JobStore, type JobRecord } from "@apatureai/verdict-jobs";
import { InMemoryObjectStore } from "@apatureai/verdict-storage";
import type { CaptureContext, EngineReviewResult } from "@apatureai/verdict-types";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngineRuntime,
  HttpCaptureClient,
  runtimeReviewRequestSchema,
  stabilityGap,
  toReviewInput,
  type CaptureClient,
  type EngineRuntime,
  type MeasuredCapture,
} from "../src/index.js";

/**
 * The two things a review run through the deployed service could not be told.
 *
 * Both were limits of the REQUEST, not of the engine. The CLI reads the repo's
 * `package.json`, detects shadcn/Radix/MUI/Chakra/Mantine and appends each
 * library's rubric note to the deep prompt; the service holds no checkout, and
 * the contract it parsed had no field for the answer, so `toReviewInput`
 * hardcoded `componentLibraries: []` and every hosted review was grounded on
 * tokens and brand alone without saying so. And `--verify-stability` captured
 * each page twice and compared the bytes, but only ever as a flag on a process:
 * the job request had no field for it and neither did the capture request the
 * service sends to a capture fleet, so a caller could not ask for the
 * determinism check on one review at all.
 *
 * Both fields are additive and optional in both directions, which is the part
 * these tests are really pinning: a newer caller must not break an older
 * engine, and a newer engine must review an older caller's request exactly as
 * it always did.
 */

const SECRET = "request-contract-secret";
const VIEWPORT = "desktop" as const;

interface RequestOverrides {
  componentLibraries?: string[];
  verifyStability?: boolean;
}

function reviewRequest(overrides: RequestOverrides = {}): Record<string, unknown> {
  return {
    installationId: "tenant_1",
    repository: { owner: "apatureai", name: "demo", defaultBranch: "main" },
    pullRequest: {
      number: 7,
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
      ...(overrides.verifyStability !== undefined ? { verifyStability: overrides.verifyStability } : {}),
    },
    publishMode: "advisory" as const,
    depth: "deep" as const,
    ...(overrides.componentLibraries !== undefined
      ? { componentLibraries: overrides.componentLibraries }
      : {}),
  };
}

function job(input: unknown = reviewRequest()): JobRecord {
  const now = new Date();
  return {
    id: "job_contract",
    consumer: "gate",
    installationId: "tenant_1",
    intentType: "pr_review",
    idempotencyKey: "gate:tenant_1:pr_review:contract",
    depth: "deep",
    status: "running",
    input,
    priority: 0,
    resultPointer: null,
    error: null,
    attempts: 1,
    claimGeneration: 1,
    leaseOwner: "w-test",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  } as unknown as JobRecord;
}

describe("component libraries reach the deep prompt's rubric", () => {
  it("resolves the ids the caller detected into this engine's own addenda", () => {
    const input = toReviewInput(job(reviewRequest({ componentLibraries: ["mui", "radix"] })));
    expect(input.context.componentLibraries.map((library) => library.id)).toEqual(["radix", "mui"]);
    // The TEXT is the engine's, never the caller's: the request carries ids and
    // nothing a caller sends is placed in the prompt verbatim.
    expect(input.context.componentLibraries[1]?.rubricAddendum).toContain("8px spacing system");
  });

  it("ignores an id this engine has no rubric for", () => {
    const input = toReviewInput(job(reviewRequest({ componentLibraries: ["mui", "vuetify"] })));
    expect(input.context.componentLibraries.map((library) => library.id)).toEqual(["mui"]);
  });

  it("reviews an OLDER caller's request exactly as before", () => {
    // Old Gate against new verdict: no `componentLibraries` on the wire at all.
    // The field is optional, so the request parses and the review is grounded on
    // tokens and brand, which is what it was grounded on yesterday.
    const input = toReviewInput(job(reviewRequest()));
    expect(input.context.componentLibraries).toEqual([]);
  });

  it("bounds what a caller can send", () => {
    const tooMany = reviewRequest({ componentLibraries: Array.from({ length: 33 }, (_, i) => `lib-${i}`) });
    expect(runtimeReviewRequestSchema.safeParse(tooMany).success).toBe(false);
    const tooLong = reviewRequest({ componentLibraries: ["x".repeat(65)] });
    expect(runtimeReviewRequestSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe("the determinism check can be asked for per review", () => {
  it("puts the ask on the capture context, which is the capture request body", () => {
    const input = toReviewInput(job(reviewRequest({ verifyStability: true })));
    expect(input.captureContext.verifyStability).toBe(true);
  });

  it("omits the field rather than sending false, so an unasked capture is unchanged", () => {
    // A capture fleet that has never heard of the field must see the same
    // request body it has always seen when nobody asked for anything new.
    expect(toReviewInput(job(reviewRequest())).captureContext).not.toHaveProperty("verifyStability");
    expect(
      toReviewInput(job(reviewRequest({ verifyStability: false }))).captureContext,
    ).not.toHaveProperty("verifyStability");
  });
});

describe("neither side hard-fails against a peer that does not know a field", () => {
  it("accepts a request carrying fields this engine has never heard of", () => {
    // New Gate against old verdict, in the only form this repository can pin:
    // the schema is not `.strict()`, so an additive field it does not declare is
    // ignored rather than rejected. `componentLibraries` was exactly such a
    // field one version ago, and this is why the older engine accepted it.
    const future = { ...reviewRequest({ componentLibraries: ["mui"] }), somethingNewer: { a: 1 } };
    const parsed = runtimeReviewRequestSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("somethingNewer");
  });

  it("accepts a config carrying settings this engine has never heard of", () => {
    const request = reviewRequest();
    const config = request.config as Record<string, unknown>;
    const future = { ...request, config: { ...config, someFutureSetting: true } };
    expect(runtimeReviewRequestSchema.safeParse(future).success).toBe(true);
  });
});

describe("the capture wire carries the ask and the answer", () => {
  const context = (over: Partial<CaptureContext> = {}): CaptureContext => ({
    installationId: "tenant_1",
    viewports: [VIEWPORT],
    darkMode: false,
    isFork: true,
    routes: ["/"],
    ...over,
  });

  const capture = {
    images: [{ route: "/", viewport: VIEWPORT, objectKey: "k.png", width: 1280, height: 720 }],
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: "capture-http@1",
  };

  it("sends the request's ask to the capture service", async () => {
    const bodies: string[] = [];
    const client = new HttpCaptureClient("https://capture.test", "token", async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify(capture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await client.forJob("job_1", new AbortController().signal)(
      "https://preview.example.test",
      context({ verifyStability: true }),
    );
    expect(JSON.parse(bodies[0] ?? "{}").context.verifyStability).toBe(true);
  });

  it("accepts the counts a capture service reports back", async () => {
    const body = {
      ...capture,
      pageHealth: { ...capture.pageHealth, stability: { pagesCompared: 3, unstablePages: 0 } },
    };
    const client = new HttpCaptureClient("https://capture.test", "token", async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    const captured = await client.forJob("job_1", new AbortController().signal)(
      "https://preview.example.test",
      context({ verifyStability: true }),
    );
    expect(captured.pageHealth.stability).toEqual({ pagesCompared: 3, unstablePages: 0 });
  });

  it("accepts a capture service that does not implement the check", async () => {
    // The response schema is `.strict()`, so an optional field is the only way a
    // fleet that predates this contract keeps working: it answers without
    // stability counts and the review runs.
    const client = new HttpCaptureClient("https://capture.test", "token", async () =>
      new Response(JSON.stringify(capture), { status: 200, headers: { "content-type": "application/json" } }));
    const captured = await client.forJob("job_1", new AbortController().signal)(
      "https://preview.example.test",
      context({ verifyStability: true }),
    );
    expect(captured.pageHealth.stability).toBeUndefined();
  });
});

describe("stabilityGap", () => {
  const context = (verifyStability?: boolean): CaptureContext => ({
    installationId: "tenant_1",
    viewports: [VIEWPORT],
    darkMode: false,
    isFork: true,
    routes: ["/"],
    ...(verifyStability !== undefined ? { verifyStability } : {}),
  });
  const capture = (stability?: { pagesCompared: number; unstablePages: number }) => ({
    images: [],
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false, ...(stability ? { stability } : {}) },
    captureVersion: "capture-http@1",
  });

  it("says nothing when the review did not ask for the check", () => {
    expect(stabilityGap(context(), capture())).toBeNull();
  });

  it("says nothing when the service answered", () => {
    expect(stabilityGap(context(true), capture({ pagesCompared: 2, unstablePages: 0 }))).toBeNull();
  });

  it("names the gap when the ask went unanswered", () => {
    // A capture fleet that ignores the field is a real state, and a review that
    // asked and got nothing back verified nothing. `unstable: false` cannot say
    // that: it is false both when nothing moved and when nothing looked.
    const gap = stabilityGap(context(true), capture());
    expect(gap).toContain("no stability counts");
    expect(gap).toContain("nothing contradicted this capture");
  });
});

describe("end to end through the deployed runtime", () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  function judgingModelFactory(seen: { systems: string[] }): ModelClientFactory {
    return () => ({
      backend: "mock",
      async complete(request: ModelRequest): Promise<ModelResponse> {
        const system = request.messages.find((message) => message.role === "system")?.content ?? "";
        seen.systems.push(system);
        const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        if (system.startsWith("You are triaging")) {
          return {
            text: JSON.stringify({ needsDeepReview: true, suspectRoutes: ["/"], obviousBreakage: [] }),
            usage,
            finishReason: "stop",
          };
        }
        return {
          text: JSON.stringify({
            grade: "ship",
            overall: "Nothing worth changing.",
            findings: [],
            notReviewed: [],
          }),
          usage,
          finishReason: "stop",
        };
      },
    });
  }

  interface Run {
    result: EngineReviewResult;
    /** Every system prompt the model was given, in call order. */
    systems: string[];
    /** Capture contexts the capture client was called with. */
    contexts: CaptureContext[];
    logs: string[];
  }

  async function runJob(request: Record<string, unknown>, captured: MeasuredCapture): Promise<Run> {
    const seen = { systems: [] as string[] };
    const contexts: CaptureContext[] = [];
    const logs: string[] = [];
    const capture: CaptureClient = {
      forJob: () => async (_url: string, ctx: CaptureContext) => {
        contexts.push(ctx);
        return captured;
      },
      cancel: async () => undefined,
      ready: async () => true,
    };
    const db = new PGlite();
    const exec = pgliteExecutor(db);
    await runMigrations(exec);
    runtime = createEngineRuntime({
      store: new JobStore(exec),
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture,
      modelFactory: judgingModelFactory(seen),
      databaseReady: async () => true,
      workerPollMs: 5,
      logger: { info: (line: string) => logs.push(line), error: (line: string) => logs.push(line) },
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const submitBody = JSON.stringify({ idempotencyKey: "request-contract", depth: "deep", request });
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: signEngineRequest({ body: submitBody, installationId: "tenant_1", secret: SECRET }),
      body: submitBody,
    });
    expect(submit.status).toBe(202);
    const { jobId } = (await submit.json()) as { jobId: string };

    for (let attempt = 0; attempt < 200; attempt++) {
      const headers = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
      const polled = (await (await fetch(`${base}/jobs/${jobId}`, { headers })).json()) as {
        state: string;
        result?: EngineReviewResult;
        error?: string;
      };
      if (polled.state === "completed" && polled.result) {
        return { result: polled.result, systems: seen.systems, contexts, logs };
      }
      if (polled.state === "failed") throw new Error(polled.error ?? "review failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("review did not complete");
  }

  const captured = (stability?: { pagesCompared: number; unstablePages: number }): MeasuredCapture => ({
    images: [{ route: "/", viewport: VIEWPORT, objectKey: "jobs/test/home.png", width: 1280, height: 720 }],
    geometry: [],
    pageHealth: {
      consoleErrors: 0,
      failedRequests: 0,
      unstable: false,
      ...(stability ? { stability } : {}),
    },
    captureVersion: "capture-http@1",
    deterministicFindings: [],
    pageText: {},
  });

  it("grounds the hosted deep prompt on the caller's component library", async () => {
    const { systems } = await runJob(
      reviewRequest({ componentLibraries: ["mui"] }),
      captured(),
    );
    const deep = systems.filter((system) => !system.startsWith("You are triaging"));
    expect(deep.length).toBeGreaterThan(0);
    expect(deep.some((system) => system.includes("COMPONENT-LIBRARY CONTEXT:"))).toBe(true);
    expect(deep.some((system) => system.includes("MUI's 8px spacing system"))).toBe(true);
  });

  it("leaves the hosted deep prompt unchanged for a caller that names none", async () => {
    const { systems } = await runJob(reviewRequest(), captured());
    expect(systems.some((system) => system.includes("COMPONENT-LIBRARY CONTEXT:"))).toBe(false);
  });

  it("asks the capture service for the determinism check and publishes what it answered", async () => {
    const { contexts, result } = await runJob(
      reviewRequest({ verifyStability: true }),
      captured({ pagesCompared: 2, unstablePages: 0 }),
    );
    expect(contexts[0]?.verifyStability).toBe(true);
    // The counts reach the reader, so "verified stable" is distinguishable from
    // "nothing contradicted this" on a published result.
    expect(result.artifacts.pageHealthFootnote).toContain("2 page(s) captured twice, all byte-identical");
  });

  it("reports the gap when the capture service ignored the ask", async () => {
    const { result, logs } = await runJob(reviewRequest({ verifyStability: true }), captured());
    expect(logs.some((line) => line.includes("no stability counts"))).toBe(true);
    // And claims nothing: no footnote invents a check that never happened.
    expect(result.artifacts.pageHealthFootnote).toBeUndefined();
  });

  it("says nothing about stability when nobody asked", async () => {
    const { contexts, logs } = await runJob(reviewRequest(), captured());
    expect(contexts[0]).not.toHaveProperty("verifyStability");
    expect(logs.some((line) => line.includes("no stability counts"))).toBe(false);
  });
});
