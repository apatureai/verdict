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
  measuredRoutes,
  measurementGap,
  measurementReportFor,
  toReviewInput,
  type CaptureClient,
  type EngineRuntime,
  type MeasuredCapture,
} from "../src/index.js";

/**
 * The measured half of a review, on the path that is actually deployed.
 *
 * `factsForRoute` and `breakageForRoute` had exactly one call site,
 * `packages/cli/src/local-review.ts`, so everything the engine measures reached
 * the prompt only when a review ran in-process. The service composition builds
 * its routes in `toReviewInput`, which runs before capture and emitted bare
 * `{ route }` objects, and its capture client parsed the fleet's answer with a
 * `.strict()` schema that had no field for a measurement at all. So the
 * deployable engine -- the one behind the HTTP API that Gate calls -- ran every
 * deep prompt with no measured facts and every triage pass with nothing that
 * could overrule a model declining to look.
 *
 * These tests pin the fix at the two ends that matter: the wire contract can
 * carry a measurement, and a measurement that arrives changes what the deployed
 * pipeline does.
 */

const SECRET = "measured-facts-secret";
const VIEWPORT = "desktop" as const;

function reviewRequest(routes: string[] = ["/"]) {
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
      routes: { always: routes, maxPerPr: 5, map: {} },
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

function job(input: unknown = reviewRequest()): JobRecord {
  const now = new Date();
  return {
    id: "job_measured",
    consumer: "gate",
    installationId: "tenant_1",
    intentType: "pr_review",
    idempotencyKey: "gate:tenant_1:pr_review:measured",
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

/** An overflow on "/" at two viewports plus a contrast failure on "/" and "/pricing". */
function measuredCapture(routes: string[] = ["/"]): MeasuredCapture {
  return {
    images: routes.map((route) => ({
      route,
      viewport: VIEWPORT,
      objectKey: `jobs/test/capture${route}.png`,
      width: 1280,
      height: 720,
    })),
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: "capture-http@1",
    deterministicFindings: [
      {
        kind: "overflow",
        route: "/",
        viewport: "mobile",
        selector: "#pricing-table",
        detail: "content width 520px exceeds container 375px (horizontal overflow)",
      },
      {
        kind: "overflow",
        route: "/",
        viewport: "tablet",
        selector: "#pricing-table",
        detail: "content width 520px exceeds container 375px (horizontal overflow)",
      },
      {
        kind: "contrast",
        route: "/",
        viewport: "desktop",
        selector: "#hero-subtitle",
        detail: "text contrast 2.31:1 is below WCAG AA 4.5:1",
      },
      {
        kind: "touch_target",
        route: "/pricing",
        viewport: "mobile",
        selector: "#buy",
        detail: "touch target 30x30px is below 44x44px",
      },
    ],
    pageText: { "/": "Pricing that scales with you" },
  };
}

function captureClientFor(capture: MeasuredCapture): CaptureClient {
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
 * A judge that DECLINES a deep review at triage and names no route, and that
 * emits one finding if a deep pass ever runs. With no measured breakage the run
 * ends at the triage short-circuit with nothing judged; measured breakage is the
 * only thing that can overrule it.
 */
function decliningModelFactory(seen: { triage: string[]; deep: string[] }): ModelClientFactory {
  return () => ({
    backend: "mock",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      const user = request.messages.find((message) => message.role === "user")?.content ?? "";
      if (system.startsWith("You are triaging")) {
        seen.triage.push(user);
        return {
          text: JSON.stringify({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] }),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      }
      // The deep pass is two calls: the grounded critique over the images, then a
      // JSON coercion of its prose. Only the first carries the route's inputs.
      if (!system.startsWith("Convert the review")) seen.deep.push(user);
      return {
        text: JSON.stringify({
          grade: "needs_work",
          overall: "The pricing table overflows its container.",
          findings: [{
            dimension: "responsiveness",
            severity: "major",
            confidence: 0.8,
            route: "/",
            viewport: VIEWPORT,
            elementRef: null,
            title: "Pricing table overflows",
            description: "The pricing table is wider than its container.",
            suggestion: "Constrain the table width.",
            introducedByThisPr: true,
          }],
          notReviewed: [],
        }),
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  });
}

describe("measuredRoutes", () => {
  it("carries facts, deduplicated breakage and page text onto the routes it is given", () => {
    const routes = measuredRoutes(["/", "/pricing"], measuredCapture(["/", "/pricing"]));
    const home = routes[0];
    expect(home?.route).toBe("/");
    // Every measurement for the route, viewport-labelled, in the deep prompt's
    // fact form. The contrast failure is a fact and not breakage.
    expect(home?.facts).toEqual([
      "- [overflow] #pricing-table (mobile): content width 520px exceeds container 375px (horizontal overflow)",
      "- [overflow] #pricing-table (tablet): content width 520px exceeds container 375px (horizontal overflow)",
      "- [contrast] #hero-subtitle (desktop): text contrast 2.31:1 is below WCAG AA 4.5:1",
    ]);
    // One broken element measured at two widths is one reason to look, not two.
    expect(home?.deterministicBreakage).toEqual([
      "[overflow] / #pricing-table: content width 520px exceeds container 375px (horizontal overflow)",
    ]);
    expect(home?.pageText).toBe("Pricing that scales with you");

    const pricing = routes[1];
    expect(pricing?.facts).toEqual([
      "- [touch_target] #buy (mobile): touch target 30x30px is below 44x44px",
    ]);
    // A touch target is a defect on a page that rendered correctly, so it never
    // overrules triage.
    expect(pricing?.deterministicBreakage).toBeUndefined();
    expect(pricing?.pageText).toBeUndefined();
  });

  it("leaves a clean route byte-identical to the bare route it replaced", () => {
    const clean: MeasuredCapture = { ...measuredCapture(), deterministicFindings: [], pageText: {} };
    expect(measuredRoutes(["/"], clean)).toEqual([{ route: "/" }]);
  });

  it("keeps a capture with no measurements from inventing any", () => {
    const unmeasured: MeasuredCapture = {
      images: [],
      geometry: [],
      pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
      captureVersion: "capture-http@1",
    };
    expect(measuredRoutes(["/"], unmeasured)).toEqual([{ route: "/" }]);
  });
});

describe("measurementGap", () => {
  it("says nothing when the capture service reported that it measured nothing", () => {
    // An empty array is a positive statement: the checks ran and the page was
    // clean. Reporting a gap here would call a clean page unmeasured.
    expect(measurementGap({ ...measuredCapture(), deterministicFindings: [] })).toBeNull();
  });

  it("names the consequence when no measurement arrived at all", () => {
    const unmeasured: MeasuredCapture = {
      images: [],
      geometry: [],
      pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
      captureVersion: "capture-http@1",
    };
    const gap = measurementGap(unmeasured);
    expect(gap).toContain("no deterministic measurements");
    expect(gap).toContain("deep prompt");
    expect(gap).toContain("triage");
  });
});

describe("measurementReportFor", () => {
  it("groups a capture's measurements into the report a consumer receives", () => {
    const report = measurementReportFor(measuredCapture(["/", "/pricing"]));

    // One broken element measured at two widths is ONE row a reader fixes once.
    const overflow = report?.violations.filter((violation) => violation.kind === "overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow?.[0]?.element).toBe("#pricing-table");
    expect(overflow?.[0]?.viewports).toEqual(["mobile", "tablet"]);
    // The fixture captures desktop only, and the touch-target check is scoped to
    // touch viewports, so it never ran. Claiming it did told a consumer "touch
    // targets measured, clean" for a check that structurally refused to execute.
    expect(report?.checksRun).toEqual(["contrast", "overflow"]);
  });

  it("reports the touch check as run once a touch viewport was captured", () => {
    const touch = measuredCapture(["/"]);
    const report = measurementReportFor({
      ...touch,
      images: touch.images.map((image) => ({ ...image, viewport: "mobile" as const })),
    });
    expect(report?.checksRun).toEqual(["contrast", "overflow", "touch_target"]);
  });

  it("reports 'measured, clean' as a positive statement", () => {
    const clean: MeasuredCapture = { ...measuredCapture(), deterministicFindings: [], pageText: {} };
    expect(measurementReportFor(clean)).toEqual({
      checksRun: ["contrast", "overflow"],
      violations: [],
    });
  });

  it("stays undefined when the capture service measured nothing at all", () => {
    // This process has no DOM. Synthesizing an empty report from a fleet that
    // never ran a check would publish "measured, nothing found" to Gate and to
    // an agent, which is the exact false claim `measurementGap` exists to stop.
    const unmeasured: MeasuredCapture = {
      images: [],
      geometry: [],
      pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
      captureVersion: "capture-http@1",
    };
    expect(measurementReportFor(unmeasured)).toBeUndefined();
  });

  it("carries a fleet-supplied blockEligible flag through, and reads absence as not gateable", () => {
    const capture = measuredCapture();
    const withFlag: MeasuredCapture = {
      ...capture,
      deterministicFindings: (capture.deterministicFindings ?? []).map((finding) =>
        finding.kind === "contrast" ? { ...finding, blockEligible: true } : finding,
      ),
    };
    const report = measurementReportFor(withFlag);
    const byKind = new Map(report?.violations.map((v) => [v.kind, v.blockEligible]));
    expect(byKind.get("contrast")).toBe(true);
    // The fleet said nothing about these two, and unknown is never gateable.
    expect(byKind.get("overflow")).toBe(false);
    expect(byKind.get("touch_target")).toBe(false);
  });

  it("carries a fleet-supplied severity band through, worst member first", () => {
    // The overflow is measured at mobile and at tablet and is ONE row. The row
    // has to speak for its worst viewport, or a consumer comparing bands across
    // commits would read "unchanged" on a page that got worse at one width.
    const capture = measuredCapture();
    const banded: MeasuredCapture = {
      ...capture,
      deterministicFindings: (capture.deterministicFindings ?? []).map((finding) =>
        finding.kind === "overflow"
          ? { ...finding, severity: finding.viewport === "tablet" ? 3 : 1 }
          : finding,
      ),
    };
    const report = measurementReportFor(banded);
    const overflow = report?.violations.find((violation) => violation.kind === "overflow");
    expect(overflow?.viewports).toEqual(["mobile", "tablet"]);
    expect(overflow?.severity).toBe(3);

    // The fleet said nothing about the contrast row, so it carries no band at
    // all. Not zero: a consumer has to be able to see that there is no answer.
    const contrast = report?.violations.find((violation) => violation.kind === "contrast");
    expect(contrast).toBeDefined();
    expect(contrast).not.toHaveProperty("severity");
  });
});

describe("capture service contract", () => {
  it("accepts a capture response that carries what the service measured", async () => {
    // The schema this parses with is `.strict()`. Before these fields existed, a
    // capture service that measured a page and said so had its entire response
    // rejected, which is why nothing measured ever reached this path.
    const body = measuredCapture();
    const client = new HttpCaptureClient("https://capture.test", "token", async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    const captured = await client.forJob("job_1", new AbortController().signal)(
      "https://preview.example.test",
      { installationId: "tenant_1", viewports: [VIEWPORT], darkMode: false, isFork: true, routes: ["/"] },
    );
    expect(captured.deterministicFindings).toHaveLength(4);
    expect(captured.pageText).toEqual({ "/": "Pricing that scales with you" });
  });

  it("accepts a severity band, and refuses one that is not a band", async () => {
    // `.strict()` again: a fleet that bands its measurements must not have its
    // whole response rejected by an engine that had no field for the band.
    const parse = async (severity: unknown) => {
      const capture = measuredCapture();
      const body = {
        ...capture,
        deterministicFindings: (capture.deterministicFindings ?? []).map((finding) => ({
          ...finding,
          severity,
        })),
      };
      const client = new HttpCaptureClient("https://capture.test", "token", async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
      return client.forJob("job_1", new AbortController().signal)(
        "https://preview.example.test",
        { installationId: "tenant_1", viewports: [VIEWPORT], darkMode: false, isFork: true, routes: ["/"] },
      );
    };

    const captured = await parse(3);
    expect(captured.deterministicFindings?.map((finding) => finding.severity)).toEqual([3, 3, 3, 3]);
    // Zero is a band, and a fleet that measured one has to be able to say so.
    expect((await parse(0)).deterministicFindings?.[0]?.severity).toBe(0);

    // A band is an ordinal. A fraction is a magnitude wearing the field's name,
    // and a magnitude is exactly what this boundary exists to keep out.
    await expect(parse(2.5)).rejects.toThrow();
    await expect(parse(-1)).rejects.toThrow();
    await expect(parse("high")).rejects.toThrow();
  });

  it("rejects a measurement of a kind nothing downstream can classify", async () => {
    const body = {
      ...measuredCapture(),
      deterministicFindings: [{
        kind: "vibes",
        route: "/",
        viewport: VIEWPORT,
        selector: "#hero",
        detail: "looks off",
      }],
    };
    const client = new HttpCaptureClient("https://capture.test", "token", async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.forJob("job_1", new AbortController().signal)(
      "https://preview.example.test",
      { installationId: "tenant_1", viewports: [VIEWPORT], darkMode: false, isFork: true, routes: ["/"] },
    )).rejects.toThrow();
  });
});

describe("the deployed pipeline carries what the capture measured", () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  interface Run {
    result: EngineReviewResult;
    /** Every user message the deep pass was given, in call order. */
    deepPrompts: string[];
    /** Every line the composition logged. */
    logs: string[];
  }

  async function runJob(capture: MeasuredCapture): Promise<Run> {
    const seen = { triage: [] as string[], deep: [] as string[] };
    const logs: string[] = [];
    const db = new PGlite();
    const exec = pgliteExecutor(db);
    await runMigrations(exec);
    runtime = createEngineRuntime({
      store: new JobStore(exec),
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture: captureClientFor(capture),
      modelFactory: decliningModelFactory(seen),
      databaseReady: async () => true,
      workerPollMs: 5,
      logger: { info: (line: string) => logs.push(line), error: (line: string) => logs.push(line) },
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const submitBody = JSON.stringify({
      idempotencyKey: "measured-facts",
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

    for (let attempt = 0; attempt < 200; attempt++) {
      const headers = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
      const polled = await (await fetch(`${base}/jobs/${jobId}`, { headers })).json() as {
        state: string;
        result?: EngineReviewResult;
        error?: string;
      };
      if (polled.state === "completed" && polled.result) {
        return { result: polled.result, deepPrompts: seen.deep, logs };
      }
      if (polled.state === "failed") throw new Error(polled.error ?? "review failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("review did not complete");
  }

  it("lets a measured overflow overrule a triage pass that declined to look", async () => {
    // This is the whole point of measuring. The triage model answers
    // `{"needsDeepReview": false, "suspectRoutes": []}`; without the measurement
    // the run stops there, judges nothing, and reports the route not reviewed
    // for want of a baseline. With it, the route is suspect by measurement and
    // the deep pass runs.
    const { result } = await runJob(measuredCapture());
    expect(result.coverage?.routesReviewed).toEqual(["/"]);
    expect(result.findings.map((finding) => finding.title)).toEqual(["Pricing table overflows"]);
    expect(result.notReviewed).toEqual([]);
    expect(result.gradeUnavailableReason).toBeUndefined();
  });

  it("grounds the deep prompt on every measurement for the route", async () => {
    const { deepPrompts } = await runJob(measuredCapture());
    expect(deepPrompts).toHaveLength(1);
    const prompt = deepPrompts[0] ?? "";
    expect(prompt).toContain("Deterministic facts:");
    expect(prompt).toContain("- [contrast] #hero-subtitle (desktop): text contrast 2.31:1 is below WCAG AA 4.5:1");
    expect(prompt).toContain("- [overflow] #pricing-table (mobile)");
    // #53: the page's own text reaches the prompt as untrusted content, which is
    // the other per-route input the local pipeline populated and this one did not.
    expect(prompt).toContain("Pricing that scales with you");
  });

  it("reports the gap instead of reviewing unmeasured pages in silence", async () => {
    const unmeasured: MeasuredCapture = {
      images: measuredCapture().images,
      geometry: [],
      pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
      captureVersion: "capture-http@1",
    };
    const { result, logs } = await runJob(unmeasured);
    expect(logs.some((line) => line.includes("no deterministic measurements"))).toBe(true);
    // And the run behaves exactly as it did before this change: nothing overrules
    // the declining triage, so nothing is judged and the result says so. The gap
    // is stated, never papered over.
    expect(result.coverage?.routesReviewed).toEqual([]);
    expect(result.gradeUnavailableReason).toBe("nothing_reviewed");
  });

  it("publishes the severity band on the result a consumer polls for", async () => {
    // The band is useless if it stops short of the wire. This is the whole hop
    // it has to survive: a capture response parsed by a `.strict()` schema, the
    // grouping, the wire projection, a JSON round trip through the object store
    // and back out of `GET /jobs/:id`.
    const capture = measuredCapture();
    const banded: MeasuredCapture = {
      ...capture,
      deterministicFindings: (capture.deterministicFindings ?? []).map((finding) =>
        finding.kind === "overflow"
          ? { ...finding, severity: finding.viewport === "tablet" ? 3 : 1 }
          : finding.kind === "contrast"
            ? { ...finding, severity: 2 }
            : finding,
      ),
    };
    const { result } = await runJob(banded);
    const bands = new Map(
      (result.measurements?.violations ?? []).map((violation) => [violation.kind, violation.severity]),
    );
    // One row for the overflow, banded by its WORST viewport.
    expect(bands.get("overflow")).toBe(3);
    expect(bands.get("contrast")).toBe(2);
    // The touch target the fleet never banded arrives with no band, and the
    // field is absent rather than zero after the JSON round trip.
    const touch = result.measurements?.violations.find((v) => v.kind === "touch_target");
    expect(touch).toBeDefined();
    expect(touch).not.toHaveProperty("severity");
  });

  it("says nothing about a gap when the service measured and found nothing", async () => {
    const { logs } = await runJob({ ...measuredCapture(), deterministicFindings: [], pageText: {} });
    expect(logs.some((line) => line.includes("no deterministic measurements"))).toBe(false);
  });
});

describe("toReviewInput leaves the routes for the capture to fill", () => {
  it("still emits bare routes, because nothing has measured anything yet", () => {
    // Pinned so the seam stays visible: `toReviewInput` runs before capture, so
    // the composition root is the only place these can be filled, and a caller
    // that binds `toReviewInput` to a raw `runReview` gets unfacted routes.
    expect(toReviewInput(job()).routes).toEqual([{ route: "/" }]);
  });
});

describe("published retention agrees with the signature that enforces it", () => {
  // A zero here is not "no promise", it is "already expired". Gate computes
  // expiresAt = receivedAt + retention and refuses its own screenshot proxy once
  // that passes, so every review the deployed service published arrived with
  // evidence records born expired. The number a consumer reads has to be the
  // number the signed URL is issued with.
  it("reports the evidence URL TTL as the retention", () => {
    expect(toReviewInput(job(), 900).wireOptions?.screenshotRetentionSeconds).toBe(900);
    expect(toReviewInput(job(), 3_600).wireOptions?.screenshotRetentionSeconds).toBe(3_600);
  });

  it("never publishes a zero, which downstream reads as already expired", () => {
    expect(toReviewInput(job()).wireOptions?.screenshotRetentionSeconds).toBeGreaterThan(0);
  });
});
