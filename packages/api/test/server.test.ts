import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import { CancellationCoordinator, JobStore } from "@apatureai/verdict-jobs";
import { InMemoryObjectStore } from "@apatureai/verdict-storage";
import { PGlite } from "@electric-sql/pglite";
import type { EngineReviewResult } from "@apatureai/verdict-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJobApi,
  modelForDepth,
  signEngineRequest,
  type ApiRequest,
  type JobApiOptions,
} from "../src/index.js";

const SECRET = "engine-hmac-secret";
let db: PGlite;
let store: JobStore;
let objectStore: InMemoryObjectStore;
let api: ReturnType<typeof createJobApi>;

/**
 * The transport tests care about routing, auth, idempotency and fencing, not
 * about what a review says, so they bind a processor that says so out loud. It
 * lives HERE, in the test, rather than as a library default: a canned result
 * that ships inside `createJobApi` is indistinguishable from a clean review at
 * a deployment that was never wired up.
 */
const testProcessor = async (job: { depth: "triage" | "deep" }): Promise<EngineReviewResult> => ({
  grade: "ship",
  overall: "transport test double: nothing captured or judged anything",
  blockingEnabled: false,
  confidenceUnavailableReason: "missing_calibration_report",
  findings: [],
  notReviewed: ["transport test double: no capture and no critique ran"],
  artifacts: { annotatedScreenshots: [] },
  screenshotRetentionSeconds: 0,
  provenance: {
    model_backed: false,
    source: "fixture",
    engine: "api-transport-test",
    model: null,
    detail: "a transport test double produced this result; nothing captured or judged a page",
  },
  metadata: {
    engineVersion: "test",
    // The depth-to-model table is the API's, so the double applies it: what these
    // tests pin is that the submitted depth reaches the processor and selects the
    // model reported on the wire.
    model: modelForDepth(job.depth),
    promptVersion: "test",
    captureVersion: "test",
    rubricVersion: "design-rubric@1",
    uiDnaVersion: null,
  },
});

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  store = new JobStore(pgliteExecutor(db));
  objectStore = new InMemoryObjectStore();
  api = createJobApi({ store, objectStore, secret: SECRET, processor: testProcessor });
});

afterEach(async () => {
  await db.close();
});

it("refuses to build a Job API with no review processor bound", () => {
  const unbound = { store, objectStore, secret: SECRET } as unknown as JobApiOptions;
  expect(() => createJobApi(unbound)).toThrow(/requires an explicit review processor/);
});

it("applies the final beforePublish policy before storing or returning any processor result", async () => {
  api = createJobApi({
    store,
    objectStore,
    secret: SECRET,
    processor: testProcessor,
    beforePublish: async (_job, result) => ({
      ...result,
      grade: "needs_work",
      blockingEnabled: false,
      notReviewed: [...result.notReviewed, "publication policy applied"],
    }),
  });
  const post = await api.handle(signed("POST", "/jobs", "1", submission("publication-policy")));
  const jobId = (post.body as { jobId: string }).jobId;
  const claimed = await store.claimNext("w1", 60_000);
  const published = await api.processJob(jobId, claimed?.claimGeneration ?? 1);

  expect(published).toMatchObject({
    grade: "needs_work",
    blockingEnabled: false,
    notReviewed: [
      "transport test double: no capture and no critique ran",
      "publication policy applied",
    ],
  });
  const stored = await objectStore.get(`jobs/${jobId}/critique/result.json`);
  expect(JSON.parse(new TextDecoder().decode(stored ?? new Uint8Array()))).toEqual(published);
});

function signed(
  method: string,
  path: string,
  installationId: string,
  bodyObj?: unknown,
): ApiRequest {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const headers = signEngineRequest({ body, installationId, secret: SECRET });
  return { method, path, headers, body };
}

const submission = (idempotencyKey: string, depth: "triage" | "deep" = "deep") => ({
  idempotencyKey,
  depth,
  request: { prNumber: 42 },
});

describe("POST /jobs", () => {
  it("enqueues a signed job (202) and dedups a duplicate key (409)", async () => {
    const first = await api.handle(signed("POST", "/jobs", "1", submission("pr-42-sha")));
    expect(first.status).toBe(202);
    const jobId = (first.body as { jobId: string }).jobId;

    const dup = await api.handle(signed("POST", "/jobs", "1", submission("pr-42-sha")));
    expect(dup.status).toBe(409);
    expect((dup.body as { jobId: string }).jobId).toBe(jobId);
  });

  it("returns a non-enumerating conflict when one key is reused for another request", async () => {
    const first = await api.handle(signed("POST", "/jobs", "1", {
      ...submission("same-key"),
      request: { repository: "acme/a", prNumber: 42 },
    }));
    expect(first.status).toBe(202);

    const mismatch = await api.handle(signed("POST", "/jobs", "1", {
      ...submission("same-key"),
      request: { repository: "acme/b", prNumber: 42 },
    }));
    expect(mismatch).toEqual({
      status: 409,
      headers: { "content-type": "application/json" },
      body: { error: "idempotency_conflict" },
    });
    expect(mismatch.body).not.toHaveProperty("jobId");
  });

  it("treats canonical request key order as an exact retry", async () => {
    const first = await api.handle(signed("POST", "/jobs", "1", {
      idempotencyKey: "canonical",
      depth: "deep",
      request: { repository: { owner: "acme", name: "web" }, pullRequest: { number: 42, sha: "abc" } },
    }));
    const retry = await api.handle(signed("POST", "/jobs", "1", {
      request: { pullRequest: { sha: "abc", number: 42 }, repository: { name: "web", owner: "acme" } },
      depth: "deep",
      idempotencyKey: "canonical",
    }));
    expect(retry.status).toBe(409);
    expect((retry.body as { jobId: string }).jobId).toBe((first.body as { jobId: string }).jobId);
  });

  it("scopes the same caller key and body to the verified installation", async () => {
    const first = await api.handle(signed("POST", "/jobs", "1", submission("tenant-key")));
    const otherTenant = await api.handle(signed("POST", "/jobs", "2", submission("tenant-key")));
    expect(first.status).toBe(202);
    expect(otherTenant.status).toBe(202);
    expect((otherTenant.body as { jobId: string }).jobId)
      .not.toBe((first.body as { jobId: string }).jobId);
  });

  it("accepts only one of two concurrent conflicting requests", async () => {
    const [a, b] = await Promise.all([
      api.handle(signed("POST", "/jobs", "1", {
        ...submission("race-key"),
        request: { repository: "acme/a" },
      })),
      api.handle(signed("POST", "/jobs", "1", {
        ...submission("race-key"),
        request: { repository: "acme/b" },
      })),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const conflict = [a, b].find((response) => response.status === 409);
    expect(conflict?.body).toEqual({ error: "idempotency_conflict" });
  });

  it("rejects an unsigned request and a tampered signature", async () => {
    const unsigned: ApiRequest = {
      method: "POST",
      path: "/jobs",
      headers: {},
      body: JSON.stringify(submission("x")),
    };
    expect((await api.handle(unsigned)).status).toBe(401);

    const tampered = signed("POST", "/jobs", "1", submission("x"));
    tampered.headers["x-gate-signature"] = "sha256=deadbeef";
    expect((await api.handle(tampered)).status).toBe(401);
  });

  it("rejects a body whose installationId was swapped after signing", async () => {
    // Signed for installation 1, replayed claiming installation 2.
    const req = signed("POST", "/jobs", "1", submission("x"));
    req.headers["x-gate-installation"] = "2";
    expect((await api.handle(req)).status).toBe(401);
  });
});

describe("GET /jobs/:id", () => {
  it("reports pending then completed with x-schema-version + version metadata", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k1", "deep")));
    const jobId = (post.body as { jobId: string }).jobId;

    const pending = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect((pending.body as { state: string }).state).toBe("pending");

    // Worker claims + processes.
    const claimed = await store.claimNext("w1", 60_000);
    await api.processJob(jobId, claimed?.claimGeneration ?? 1);

    const done = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect(done.headers["x-schema-version"]).toBe("1");
    const body = done.body as { state: string; result: { metadata: { model: string } } };
    expect(body.state).toBe("completed");
    // depth=deep routes to the deep model.
    expect(body.result.metadata.model).toBe("qwen3-vl-plus");
  });

  it("routes triage depth to the fast model", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k2", "triage")));
    const jobId = (post.body as { jobId: string }).jobId;
    const claimed = await store.claimNext("w1", 60_000);
    await api.processJob(jobId, claimed?.claimGeneration ?? 1);

    const done = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    const body = done.body as { result: { metadata: { model: string } } };
    expect(body.result.metadata.model).toBe("qwen3-vl-flash");
  });

  it("does not disclose another tenant's job (404)", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k3")));
    const jobId = (post.body as { jobId: string }).jobId;

    // Installation 2 asks for installation 1's job.
    const res = await api.handle(signed("GET", `/jobs/${jobId}`, "2"));
    expect(res.status).toBe(404);
  });

  it("answers 404, not 500, for an id that is not a job handle", async () => {
    // A job id is a uuid this engine minted. Anything else never named a job,
    // and handing it to `jobs.id = $1` made Postgres raise a type error that
    // surfaced as `500 internal_error`: the engine reporting ITSELF as broken
    // because a caller asked for a handle that cannot exist. A consumer that
    // mishandles a conflict envelope and polls `/jobs/undefined` is the case
    // that found this.
    for (const id of ["undefined", "null", "1", "not-a-uuid"]) {
      const res = await api.handle(signed("GET", `/jobs/${id}`, "1"));
      expect(res.status, `GET /jobs/${id}`).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    }
  });

  it("gives the same non-enumerating answer on DELETE", async () => {
    const res = await api.handle(signed("DELETE", "/jobs/undefined", "1"));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("still accepts a real job handle whatever its case", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k-case")));
    const jobId = (post.body as { jobId: string }).jobId;
    const res = await api.handle(signed("GET", `/jobs/${jobId.toUpperCase()}`, "1"));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /jobs/:id (cooperative cancel)", () => {
  it("flips to cancelling immediately, aborts via the coordinator, and writes no result", async () => {
    const killed: string[] = [];
    const coordinator = new CancellationCoordinator(async (id) => {
      killed.push(id);
    });
    api = createJobApi({ store, objectStore, secret: SECRET, processor: testProcessor, coordinator });

    const post = await api.handle(signed("POST", "/jobs", "1", submission("k4")));
    const jobId = (post.body as { jobId: string }).jobId;
    coordinator.register(jobId);
    await store.claimNext("w1", 60_000); // job is running

    const del = await api.handle(signed("DELETE", `/jobs/${jobId}`, "1"));
    expect(del.status).toBe(200);
    expect((del.body as { cancelling: boolean }).cancelling).toBe(true);

    // Consumer sees the intent immediately.
    const got = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect((got.body as { state: string }).state).toBe("cancelling");
    // Inference aborted + microVM kill invoked.
    expect(coordinator.isAborted(jobId)).toBe(true);
    expect(killed).toEqual([jobId]);

    // A late processJob writes NO result for a job that left `running`.
    await expect(api.processJob(jobId, 1)).rejects.toThrow(/not running/);
    const afterProcess = await store.get(jobId);
    expect(afterProcess?.status).toBe("cancelling");
    expect(afterProcess?.resultPointer).toBeNull();
    expect(await objectStore.get(`jobs/${jobId}/critique/result.json`)).toBeNull();

    // Worker finalizes -> canceled -> consumer sees terminal failed.
    await store.markCanceled(jobId);
    const final = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect((final.body as { state: string }).state).toBe("failed");
  });

  it("does not disclose another tenant's job on cancel", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k5")));
    const jobId = (post.body as { jobId: string }).jobId;
    expect((await api.handle(signed("DELETE", `/jobs/${jobId}`, "2"))).status).toBe(404);
  });

  it("deletes a result artifact when cancellation wins the publication race", async () => {
    api = createJobApi({
      store,
      objectStore,
      secret: SECRET,
      processor: async (job) => {
        await store.requestCancel(job.id);
        return {
          grade: "ship",
          overall: "late result",
          findings: [],
          notReviewed: [],
          artifacts: { annotatedScreenshots: [] },
          screenshotRetentionSeconds: 0,
          metadata: {
            engineVersion: "1",
            model: "test",
            promptVersion: "test",
            captureVersion: "test",
            uiDnaVersion: null,
          },
        };
      },
    });
    const post = await api.handle(signed("POST", "/jobs", "1", submission("publish-race")));
    const jobId = (post.body as { jobId: string }).jobId;
    await store.claimNext("w1", 60_000);

    await expect(api.processJob(jobId, 1)).rejects.toThrow(/before publication/);
    expect((await store.get(jobId))?.status).toBe("cancelling");
    expect(await objectStore.get(`jobs/${jobId}/critique/result.json`)).toBeNull();
  });
});

describe("claim-generation fencing (#166)", () => {
  it("a late worker from an expired lease cannot publish over the recovered attempt", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("fence-1", "deep")));
    const jobId = (post.body as { jobId: string }).jobId;

    // Worker A claims (generation 1), then dies: expire its lease and recover.
    const first = await store.claimNext("worker-a", 60_000);
    expect(first?.claimGeneration).toBe(1);
    await db.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const recovered = await store.recoverExpired({ maxAttempts: 3 });
    expect(recovered).toEqual([{ id: jobId, outcome: "requeued", previousOwner: "worker-a" }]);

    // Worker B claims the recovered attempt and publishes.
    const second = await store.claimNext("worker-b", 60_000);
    expect(second?.claimGeneration).toBe(3); // recovery + reclaim each bump the fence
    await api.processJob(jobId, second?.claimGeneration ?? 0);
    const published = await store.get(jobId);
    expect(published?.status).toBe("succeeded");
    const pointer = published?.resultPointer ?? "";

    // Worker A resumes late: its stale generation cannot publish, fail, or renew,
    // and worker B's result pointer is untouched.
    await expect(api.processJob(jobId, 1)).rejects.toThrow(/not running|stale/);
    expect(await store.retryOrFail(jobId, "late failure", 3, 1)).toBeNull();
    expect(await store.renewLease(jobId, "worker-a", 1, 60_000)).toBe(false);
    const final = await store.get(jobId);
    expect(final?.status).toBe("succeeded");
    expect(final?.resultPointer).toBe(pointer);
    expect(await objectStore.get(pointer)).not.toBeNull();
  });
});

describe("hardening (gstack /review fixes)", () => {
  it("a succeeded job whose result artifact is gone returns failed, not completed+null", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k6")));
    const jobId = (post.body as { jobId: string }).jobId;
    await store.claimNext("w1", 60_000);
    // Mark succeeded with a pointer to an object that was never written (expired/missing).
    await store.complete(jobId, "jobs/missing/critique/result.json", 1);

    const got = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    const body = got.body as { state: string; error?: string; result?: unknown };
    expect(body.state).toBe("failed");
    expect(body.error).toBe("result_unavailable");
    expect(body.result).toBeUndefined(); // never completed+null
  });

  it("rejects a stale timestamp by default (replay protection on without config)", async () => {
    const body = JSON.stringify(submission("k7"));
    const stale = signEngineRequest({ body, installationId: "1", secret: SECRET, timestamp: Date.now() - 10 * 60_000 });
    const res = await api.handle({ method: "POST", path: "/jobs", headers: stale, body });
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toBe("timestamp_skew");
  });

  it("rejects a non-numeric timestamp instead of silently bypassing the skew check", async () => {
    const body = JSON.stringify(submission("k8"));
    const headers = signEngineRequest({ body, installationId: "1", secret: SECRET });
    headers["x-gate-timestamp"] = "not-a-number";
    const res = await api.handle({ method: "POST", path: "/jobs", headers, body });
    // signature was computed over the real ts, so swapping the header also breaks the sig;
    // either way it must NOT be accepted.
    expect(res.status).toBe(401);
  });
});
