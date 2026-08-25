import { signEngineRequest } from "@apatureai/verdict-api";
import {
  defaultModelFactory,
  type ModelClientFactory,
  type ModelResponse,
} from "@apatureai/verdict-critique";
import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import {
  calibrationAttestedPayloadHash,
  ModelPromptRegistry,
  type CalibrationReportV1,
} from "@apatureai/verdict-eval";
import { JobStore, type JobRecord } from "@apatureai/verdict-jobs";
import { InMemoryObjectStore } from "@apatureai/verdict-storage";
import type { Capture, CaptureContext, CaptureInSandbox, EngineReviewResult } from "@apatureai/verdict-types";
import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngineRuntime,
  EngineWorker,
  GroundingAuthorityError,
  HttpGenomeResolver,
  runtimeReviewRequestSchema,
  toReviewInput,
  type CaptureClient,
  type EngineRuntime,
  type GenomeResolver,
  type GroundingAuthorityPort,
  type GroundingAuthorityReceipt,
  type NotificationSource,
  type WorkerStore,
} from "../src/index.js";

const SECRET = "runtime-hmac-secret";
const VIEWPORT = "desktop" as const;
const AUTHORITY_HEAD_1 = `sha256:${"a".repeat(64)}` as const;
const AUTHORITY_HEAD_2 = `sha256:${"b".repeat(64)}` as const;

function authorityReceipt(
  sequence: number,
  status: GroundingAuthorityReceipt["status"],
  checkedAt = "2026-07-14T20:00:00.000Z",
): GroundingAuthorityReceipt {
  return {
    contractVersion: "uidna-authority/1",
    status,
    sequence,
    headEventHash: sequence === 1 ? AUTHORITY_HEAD_1 : AUTHORITY_HEAD_2,
    checkedAt,
  };
}
const drill = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/genome-lifecycle-drill.golden.json", import.meta.url)), "utf8"),
) as {
  sourceOfTruth: { snapshotId: string; itemIds: string[] };
  judgmentEngine: { uiDnaVersion: string; ruleCount: number; groundingObserved: boolean };
};
const calibrationFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../eval/fixtures/calibration-report.v1.golden.json", import.meta.url)),
    "utf8",
  ),
) as CalibrationReportV1;

function promotedRuntimeReport(): CalibrationReportV1 {
  const report: CalibrationReportV1 = {
    ...calibrationFixture,
    identity: {
      model: "qwen3-vl-plus",
      promptVersion: "system-prompt@v4",
      engineVersion: "0.1.0",
      captureVersion: "capture-http@1",
      rubricVersion: "design-rubric@1",
    },
    attestation: null,
  };
  report.attestation = {
    algorithm: "ed25519",
    keyId: "runtime-test-release-key",
    signedPayloadHash: calibrationAttestedPayloadHash(report),
    signature: "verified-runtime-fixture",
  };
  return report;
}

const calibratedModelFactory: ModelClientFactory = () => ({
  backend: "mock",
  async complete(request): Promise<ModelResponse> {
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
          grade: "blocked",
          overall: "Raw blocker requires calibrated threshold evaluation.",
          findings: [{
            dimension: "spacing",
            severity: "blocker",
            confidence: 0.95,
            route: "/",
            viewport: "desktop",
            // Grounded on a captured geometry selector (see captureClient): this
            // finding drives the grade, so the calibrated-blocking downgrade below
            // is what is under test. A null elementRef would be routed to the
            // ungrounded bucket and held out of the grade (W1-03).
            elementRef: "#spacing",
            title: "Spacing blocker",
            description: "The spacing violates the approved scale.",
            suggestion: "Use the approved spacing token.",
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

function reviewRequest() {
  return {
    installationId: "verified-installation",
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

function captureClient(): CaptureClient {
  const capture: Capture = {
    images: [{ route: "/", viewport: VIEWPORT, objectKey: "jobs/test/capture/home.png", width: 1280, height: 720 }],
    geometry: [
      { route: "/", viewport: VIEWPORT, selector: "#spacing", role: null, rect: { x: 0, y: 0, width: 100, height: 40 } },
    ],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: "capture-http@1",
  };
  return {
    forJob: (_jobId: string, signal: AbortSignal): CaptureInSandbox =>
      async (_url: string, _ctx: CaptureContext) => {
        if (signal.aborted) throw new Error("aborted");
        return capture;
      },
    cancel: async () => undefined,
    ready: async () => true,
  };
}

function job(input: unknown = reviewRequest()): JobRecord {
  const now = new Date();
  return {
    id: "job_1",
    consumer: "gate",
    installationId: "verified-installation",
    intentType: "pr_review",
    idempotencyKey: "gate:verified-installation:pr_review:one",
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
  };
}

describe("runtime request binding", () => {
  it("requires the publication authority port whenever genome grounding is configured", () => {
    const base = {
      store: {} as JobStore,
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture: captureClient(),
      modelFactory: defaultModelFactory,
      databaseReady: async () => true,
    };
    expect(() => createEngineRuntime({
      ...base,
      genomeResolver: { resolve: async () => null },
    })).toThrow(/requires both genomeResolver and groundingAuthority/);
    expect(() => createEngineRuntime({
      ...base,
      groundingAuthority: { statusFor: async () => authorityReceipt(1, "effective") },
    })).toThrow(/requires both genomeResolver and groundingAuthority/);
  });

  it("loads the built production graph under native Node ESM resolution", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "await import('./packages/runtime/dist/index.js')"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("derives tenant scope and depth from the verified durable job", () => {
    const input = toReviewInput(job());
    expect(input.captureContext.installationId).toBe("verified-installation");
    expect(input.depth).toBe("deep");
    expect(input.captureContext.routes).toEqual(["/"]);
    expect(input.url).toBe("https://preview.example.test");
    expect(input.captureContext.isFork).toBe(true);
  });

  it("rejects caller-controlled tenant/depth mismatches but accepts additive fields", () => {
    expect(() => toReviewInput(job({ ...reviewRequest(), installationId: "attacker" }))).toThrow(/tenant/);
    expect(() => toReviewInput(job({ ...reviewRequest(), depth: "triage" }))).toThrow(/depth/);
    expect(runtimeReviewRequestSchema.parse({ ...reviewRequest(), additiveFutureField: true })).toBeDefined();
  });
});

describe("approved genome adapter", () => {
  it("reads Source of Truth by repository and maps the approved snapshot to rules", async () => {
    let requestedUrl = "";
    let requestedInstallation = "";
    const resolver = new HttpGenomeResolver(
      "https://source.apature.test",
      "service-token",
      async (input, init) => {
        requestedUrl = String(input);
        requestedInstallation = new Headers(init?.headers).get("x-apature-installation-id") ?? "";
        return new Response(JSON.stringify({
          snapshot: {
            id: drill.sourceOfTruth.snapshotId,
            dna_version: drill.judgmentEngine.uiDnaVersion,
            approval_state: "approved",
            authority: {
              contract_version: "uidna-authority/1",
              status: "effective",
              sequence: 1,
              head_event_hash: AUTHORITY_HEAD_1,
              checked_at: "2026-07-14T20:00:00.000Z",
            },
          },
          items: [{
            field_id: drill.sourceOfTruth.itemIds[0],
            kind: "token",
            value: { token: "--color-brand", value: "#0a0a0a", group: "color" },
            applicability: {},
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    );

    await expect(resolver.resolve("apatureai/demo", "tenant_1")).resolves.toEqual({
      version: drill.judgmentEngine.uiDnaVersion,
      authority: {
        contractVersion: "uidna-authority/1",
        status: "effective",
        sequence: 1,
        headEventHash: AUTHORITY_HEAD_1,
        checkedAt: "2026-07-14T20:00:00.000Z",
      },
      rules: [{
        id: drill.sourceOfTruth.itemIds[0],
        text: JSON.stringify({
          kind: "token",
          value: { token: "--color-brand", value: "#0a0a0a", group: "color" },
        }),
      }],
    });
    expect(requestedUrl).toBe("https://source.apature.test/v1/repos/apatureai%2Fdemo/ui-dna?max_items=100");
    expect(requestedInstallation).toBe("tenant_1");
  });

  it("revalidates the exact DNA authority key without requesting genome bytes", async () => {
    let requestedUrl = "";
    const resolver = new HttpGenomeResolver(
      "https://source.apature.test",
      "service-token",
      async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({
          dna_version: "dna@1",
          contract_version: "uidna-authority/1",
          status: "revoked",
          sequence: 2,
          head_event_hash: AUTHORITY_HEAD_2,
          checked_at: "2026-07-14T20:00:01.000Z",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    );

    await expect(resolver.statusFor({
      tenantId: "tenant_1",
      repository: "apatureai/demo",
      dnaVersion: "dna@1",
    })).resolves.toMatchObject({ status: "revoked", sequence: 2, headEventHash: AUTHORITY_HEAD_2 });
    expect(requestedUrl).toBe(
      "https://source.apature.test/v1/repos/apatureai%2Fdemo/ui-dna/authority/dna%401",
    );
  });

  it("treats an absent approved snapshot as no genome", async () => {
    const resolver = new HttpGenomeResolver(
      "https://source.apature.test",
      "service-token",
      async () => new Response(null, { status: 404 }),
    );
    await expect(resolver.resolve("apatureai/demo", "tenant_1")).resolves.toBeNull();
  });
});

describe("EngineWorker", () => {
  const idleStore = (overrides: Partial<WorkerStore> = {}): WorkerStore => ({
    claimNext: async () => null,
    renewLease: async () => true,
    retryOrFail: async () => null,
    recoverExpired: async () => [],
    ...overrides,
  });

  it("retries a failed attempt, succeeds on the next claim, and drains", async () => {
    const queued = [job(), { ...job(), attempts: 2, claimGeneration: 2 }];
    const states: Array<string | null> = [];
    const fencedGenerations: number[] = [];
    let calls = 0;
    const worker = new EngineWorker({
      store: idleStore({
        claimNext: async () => queued.shift() ?? null,
        retryOrFail: async (_id, _error, _max, claimGeneration) => {
          states.push("queued");
          fencedGenerations.push(claimGeneration);
          return "queued";
        },
      }),
      processJob: async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
      },
      maxAttempts: 3,
    });
    await worker.drainOnce();
    expect(calls).toBe(2);
    expect(states).toEqual(["queued"]);
    // The failure was finalized under the generation of the claim that ran it.
    expect(fencedGenerations).toEqual([1]);
  });

  it("closes the LISTEN source during graceful shutdown", async () => {
    let closed = false;
    let notify: (() => void) | undefined;
    const source: NotificationSource = {
      start: async (handler) => { notify = handler; },
      close: async () => { closed = true; },
    };
    const worker = new EngineWorker({
      store: idleStore(),
      processJob: async () => undefined,
      notificationSource: source,
      pollIntervalMs: 50,
    });
    await worker.start();
    notify?.();
    await worker.stop();
    expect(closed).toBe(true);
    expect(worker.isReady()).toBe(false);
  });

  it("recovers expired attempts at startup and reports them for capture teardown (#166)", async () => {
    let scans = 0;
    const torndown: string[] = [];
    const worker = new EngineWorker({
      store: idleStore({
        recoverExpired: async () => {
          scans++;
          return scans === 1
            ? [{ id: "job_lost", outcome: "requeued" as const, previousOwner: "w-dead" }]
            : [];
        },
      }),
      processJob: async () => undefined,
      pollIntervalMs: 50,
      onRecovered: (recovered) => torndown.push(recovered.id),
    });
    await worker.start();
    await worker.stop();
    expect(scans).toBeGreaterThanOrEqual(1);
    expect(torndown).toEqual(["job_lost"]);
  });

  it("passes the reaper the hard attempt deadline when configured (#166)", async () => {
    const seen: Array<number | undefined> = [];
    const worker = new EngineWorker({
      store: idleStore({
        recoverExpired: async (options) => {
          seen.push(options.maxAttemptMs);
          return [];
        },
      }),
      processJob: async () => undefined,
      pollIntervalMs: 50,
      maxAttemptMs: 600_000,
    });
    await worker.start();
    await worker.stop();
    expect(seen[0]).toBe(600_000);
  });

  it("heartbeats the lease while a job runs and aborts locally when the lease is lost (#166)", async () => {
    let renewals = 0;
    const lostJobs: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const single = [job()];
    const worker = new EngineWorker({
      store: idleStore({
        claimNext: async () => single.shift() ?? null,
        renewLease: async () => {
          renewals++;
          // First renewal succeeds, second discovers the lease was recovered.
          return renewals < 2;
        },
      }),
      processJob: async () => gate,
      leaseTtlMs: 30, // heartbeat every 10ms
      pollIntervalMs: 5_000,
      onLeaseLost: (jobId) => {
        lostJobs.push(jobId);
        release?.();
      },
    });
    await worker.drainOnce();
    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(lostJobs).toEqual(["job_1"]);
  });
});

describe("production composition integration", () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  async function runAuthorityReview(
    provider: GenomeResolver & GroundingAuthorityPort,
    options: {
      capture?: CaptureClient;
      afterSubmit?: () => Promise<void>;
    } = {},
  ): Promise<EngineReviewResult> {
    const db = new PGlite();
    const exec = pgliteExecutor(db);
    await runMigrations(exec);
    const store = new JobStore(exec);
    const registry = new ModelPromptRegistry(exec, {
      now: () => Date.parse("2026-07-13T00:00:00.000Z"),
      verifyAttestation: async (report) => report.attestation?.signature === "verified-runtime-fixture",
    });
    const report = promotedRuntimeReport();
    const candidate = await registry.registerCandidate(report.identity);
    await registry.recordEval(candidate.id, true);
    await registry.bindCalibrationReport(candidate.id, report);
    await registry.promote(candidate.id, { mode: "blocking" });

    runtime = createEngineRuntime({
      store,
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture: options.capture ?? captureClient(),
      modelFactory: calibratedModelFactory,
      calibrationResolver: registry,
      genomeResolver: provider,
      groundingAuthority: provider,
      authorityNow: () => new Date("2026-07-14T20:00:02.000Z"),
      embedder: async (texts) => texts.map(() => [1, 0]),
      databaseReady: async () => true,
      workerPollMs: 5,
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const request = reviewRequest();
    request.installationId = "tenant_1";
    const submitBody = JSON.stringify({
      idempotencyKey: "authority-review",
      depth: "deep",
      request,
    });
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: signEngineRequest({ body: submitBody, installationId: "tenant_1", secret: SECRET }),
      body: submitBody,
    });
    expect(submit.status).toBe(202);
    const { jobId } = await submit.json() as { jobId: string };
    await options.afterSubmit?.();

    for (let attempt = 0; attempt < 200; attempt++) {
      const headers = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
      const response = await fetch(`${base}/jobs/${jobId}`, { headers });
      const polled = await response.json() as {
        state: string;
        result?: EngineReviewResult;
        error?: string;
      };
      if (polled.state === "completed" && polled.result) return polled.result;
      if (polled.state === "failed") throw new Error(polled.error ?? "review failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("review did not complete");
  }

  function providerFor(
    initial: GroundingAuthorityReceipt | null,
    publication: GroundingAuthorityReceipt | Error,
    calls?: { status: number },
  ): GenomeResolver & GroundingAuthorityPort {
    return {
      resolve: async () => initial === null
        ? null
        : {
            version: "dna@1",
            rules: [{ id: "rule-1", text: "Use the approved spacing scale." }],
            authority: initial,
          },
      statusFor: async () => {
        if (calls) calls.status++;
        if (publication instanceof Error) throw publication;
        return publication;
      },
    };
  }

  it("rechecks after model work and suppresses a version revoked during review", async () => {
    let current = authorityReceipt(1, "effective");
    let enteredCapture: (() => void) | undefined;
    let releaseCapture: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredCapture = resolve; });
    const release = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const baseCapture = captureClient();
    const pausedCapture: CaptureClient = {
      ...baseCapture,
      forJob: (jobId, signal) => {
        const capture = baseCapture.forJob(jobId, signal);
        return async (url, context) => {
          enteredCapture?.();
          await release;
          return capture(url, context);
        };
      },
    };
    const provider: GenomeResolver & GroundingAuthorityPort = {
      resolve: async () => ({
        version: "dna@1",
        rules: [{ id: "rule-1", text: "Use the approved spacing scale." }],
        authority: authorityReceipt(1, "effective"),
      }),
      statusFor: async () => current,
    };

    const result = await runAuthorityReview(provider, {
      capture: pausedCapture,
      afterSubmit: async () => {
        await entered;
        current = authorityReceipt(2, "revoked");
        releaseCapture?.();
      },
    });
    expect(result.blockingEnabled).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.notReviewed.some((note) => note.includes("revoked before publish"))).toBe(true);
    expect(result.metadata.groundingAuthority).toMatchObject({
      status: "revoked",
      sequence: 2,
      headEventHash: AUTHORITY_HEAD_2,
    });
  });

  it.each([
    {
      name: "authority outage",
      initial: authorityReceipt(1, "effective"),
      publication: new Error("timeout"),
      reason: "unavailable",
    },
    {
      name: "missing exact-version evidence",
      initial: authorityReceipt(1, "effective"),
      publication: new GroundingAuthorityError("missing", "not found"),
      reason: "missing",
    },
    {
      name: "malformed publication evidence",
      initial: authorityReceipt(1, "effective"),
      publication: {} as GroundingAuthorityReceipt,
      reason: "malformed",
    },
    {
      name: "stale publication receipt",
      initial: authorityReceipt(1, "effective"),
      publication: authorityReceipt(2, "effective", "2026-07-14T19:58:00.000Z"),
      reason: "stale",
    },
    {
      name: "sequence regression",
      initial: authorityReceipt(2, "effective"),
      publication: authorityReceipt(1, "effective"),
      reason: "sequence_regression",
    },
  ])("fails closed to an advisory result on $name", async ({ initial, publication, reason }) => {
    const result = await runAuthorityReview(providerFor(initial, publication));
    expect(result.blockingEnabled).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.metadata.groundingAuthority).toMatchObject({ status: "unknown", reason });
    if (reason === "sequence_regression") {
      expect(result.metadata.groundingAuthority?.sequence).toBe(2);
      expect(result.metadata.groundingAuthority?.headEventHash).toBe(AUTHORITY_HEAD_2);
    }
    expect(result.notReviewed.some((note) => note.includes("unknown at publish"))).toBe(true);
  });

  it("suppresses a version already revoked when it resolves", async () => {
    const revoked = authorityReceipt(2, "revoked");
    const result = await runAuthorityReview(providerFor(revoked, revoked));
    expect(result.blockingEnabled).toBe(false);
    expect(result.metadata.groundingAuthority?.status).toBe("revoked");
    expect(result.notReviewed.some((note) => note.includes("revoked before publish"))).toBe(true);
  });

  it("preserves the existing ungrounded result path and performs no authority lookup", async () => {
    const calls = { status: 0 };
    const result = await runAuthorityReview(providerFor(null, new Error("must not be called"), calls));
    expect(result.metadata.uiDnaVersion).toBeNull();
    expect(result.metadata.groundingAuthority).toBeUndefined();
    expect(result.blockingEnabled).toBe(true);
    expect(calls.status).toBe(0);
  });

  it("runs submit -> poll/claim -> real orchestrator -> stored wire result", async () => {
    const db = new PGlite();
    const exec = pgliteExecutor(db);
    await runMigrations(exec);
    const store = new JobStore(exec);
    const registry = new ModelPromptRegistry(exec, {
      now: () => Date.parse("2026-07-13T00:00:00.000Z"),
      verifyAttestation: async (report) => report.attestation?.signature === "verified-runtime-fixture",
    });
    const report = promotedRuntimeReport();
    const candidate = await registry.registerCandidate(report.identity);
    await registry.recordEval(candidate.id, true);
    await registry.bindCalibrationReport(candidate.id, report);
    await registry.promote(candidate.id, { mode: "blocking" });
    let resolvedGenome = false;
    const effectiveReceipt = {
      contractVersion: "uidna-authority/1" as const,
      status: "effective" as const,
      sequence: 1,
      headEventHash: AUTHORITY_HEAD_1,
      checkedAt: "2026-07-14T20:00:00.000Z",
    };
    const groundedProvider = {
      resolve: async (repository: string, installationId: string) => {
        resolvedGenome = repository === "apatureai/demo" && installationId === "tenant_1";
        return {
          version: "dna@1",
          rules: [{ id: "rule-1", text: "Use the approved spacing scale." }],
          authority: effectiveReceipt,
        };
      },
      statusFor: async () => effectiveReceipt,
    };
    runtime = createEngineRuntime({
      store,
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture: captureClient(),
      modelFactory: calibratedModelFactory,
      calibrationResolver: registry,
      genomeResolver: groundedProvider,
      groundingAuthority: groundedProvider,
      authorityNow: () => new Date("2026-07-14T20:00:02.000Z"),
      embedder: async (texts) => texts.map(() => [1, 0]),
      databaseReady: async () => true,
      workerPollMs: 5,
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const request = reviewRequest();
    request.installationId = "tenant_1";
    const submitBody = JSON.stringify({ idempotencyKey: "repo#42@sha", depth: "deep", request });
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: signEngineRequest({ body: submitBody, installationId: "tenant_1", secret: SECRET }),
      body: submitBody,
    });
    expect(submit.status).toBe(202);
    const { jobId } = await submit.json() as { jobId: string };

    let final: { state: string; result?: EngineReviewResult } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const headers = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
      const response = await fetch(`${base}/jobs/${jobId}`, { headers });
      final = await response.json() as typeof final;
      if (final?.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(final?.state).toBe("completed");
    expect(final?.result?.metadata.captureVersion).toBe("capture-http@1");
    expect(final?.result?.metadata.promptVersion).not.toBe("stub@0");
    expect(final?.result?.metadata.uiDnaVersion).toBe("dna@1");
    expect(final?.result?.metadata.groundingAuthority).toMatchObject({
      status: "effective",
      sequence: 1,
      headEventHash: AUTHORITY_HEAD_1,
    });
    expect(final?.result?.calibration).toMatchObject({
      reportId: report.reportId,
      calibrationVersion: report.calibrationVersion,
      confidenceSource: report.confidenceSource,
    });
    expect(final?.result?.blockingEnabled).toBe(true);
    expect(final?.result?.findings[0]?.confidence).toBeCloseTo(0.8725, 10);
    expect(final?.result?.findings[0]).not.toHaveProperty("rawConfidence");
    // The calibrated score is below the report's 0.9 blocking threshold.
    expect(final?.result?.findings[0]?.severity).toBe("major");
    expect(final?.result?.grade).toBe("needs_work");
    expect(resolvedGenome).toBe(true);

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ready",
      components: { database: true, capture: true, worker: true },
    });
  });

  it("reports capture capacity separately from liveness", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const store = new JobStore(pgliteExecutor(db));
    const capture = captureClient();
    capture.ready = async () => false;
    runtime = createEngineRuntime({
      store,
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture,
      modelFactory: defaultModelFactory,
      databaseReady: async () => true,
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ components: { database: true, capture: false, worker: true } });
  });

  it("aborts capture, finalizes cancellation, and never publishes a result", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const store = new JobStore(pgliteExecutor(db));
    const objectStore = new InMemoryObjectStore();
    let killed = false;
    const capture: CaptureClient = {
      forJob: (_jobId, signal) => async () => new Promise<Capture>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
      cancel: async () => { killed = true; },
      ready: async () => true,
    };
    runtime = createEngineRuntime({
      store,
      objectStore,
      engineHmacSecret: SECRET,
      capture,
      modelFactory: defaultModelFactory,
      databaseReady: async () => true,
      workerPollMs: 5,
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const request = reviewRequest();
    request.installationId = "tenant_1";
    const submitBody = JSON.stringify({ idempotencyKey: "cancel-me", depth: "deep", request });
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: signEngineRequest({ body: submitBody, installationId: "tenant_1", secret: SECRET }),
      body: submitBody,
    });
    const { jobId } = await submit.json() as { jobId: string };

    for (let attempt = 0; attempt < 100 && (await store.get(jobId))?.status !== "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const cancelHeaders = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
    const cancel = await fetch(`${base}/jobs/${jobId}`, { method: "DELETE", headers: cancelHeaders });
    expect(cancel.status).toBe(200);

    for (let attempt = 0; attempt < 100 && (await store.get(jobId))?.status !== "canceled"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const record = await store.get(jobId);
    expect(record?.status).toBe("canceled");
    expect(record?.resultPointer).toBeNull();
    expect(killed).toBe(true);
    expect(await objectStore.get(`jobs/${jobId}/critique/result.json`)).toBeNull();
  });
});
