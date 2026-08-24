import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CancellationCoordinator,
  IdempotencyRequestConflictError,
  JOB_NOTIFY_CHANNEL,
  JOB_SUBMISSION_DIGEST_VERSION,
  JobStore,
  jobSubmissionDigest,
  type EnqueueJobInput,
} from "../src/index.js";

let db: PGlite;
let store: JobStore;

const baseInput: EnqueueJobInput = {
  consumer: "gate",
  installationId: "1",
  intentType: "pr_review",
  idempotencyKey: "gate:1:pr_review:sha-abc",
  depth: "deep",
  input: { prNumber: 42 },
};

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  store = new JobStore(pgliteExecutor(db));
});

afterEach(async () => {
  await db.close();
});

describe("enqueue idempotency", () => {
  it("creates a queued job and returns the same handle for an exact retry", async () => {
    const first = await store.enqueue(baseInput);
    expect(first.created).toBe(true);
    expect(first.job.status).toBe("queued");
    expect(first.job.input).toEqual({ prNumber: 42 });

    const second = await store.enqueue({ ...baseInput, input: { prNumber: 42 } });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id); // same job, not a new row

    const { rows } = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs");
    expect(rows[0]?.count).toBe("1");
  });

  it("rejects the same key with a different repository/request without disclosing the existing handle", async () => {
    const first = await store.enqueue({
      ...baseInput,
      input: { repository: { owner: "acme", name: "a" }, prNumber: 42 },
    });

    let conflict: unknown;
    try {
      await store.enqueue({
        ...baseInput,
        input: { repository: { owner: "acme", name: "b" }, prNumber: 42 },
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(IdempotencyRequestConflictError);
    expect(String(conflict)).not.toContain(first.job.id);
    expect(String(conflict)).not.toContain(baseInput.idempotencyKey);
  });

  it("canonicalizes request object key order but keeps depth semantically distinct", async () => {
    const inputA = {
      ...baseInput,
      input: { repository: { owner: "acme", name: "web" }, pullRequest: { number: 42, headSha: "abc" } },
    };
    const first = await store.enqueue(inputA);
    const retry = await store.enqueue({
      ...baseInput,
      input: { pullRequest: { headSha: "abc", number: 42 }, repository: { name: "web", owner: "acme" } },
    });
    expect(retry).toMatchObject({ created: false, job: { id: first.job.id } });
    await expect(store.enqueue({ ...inputA, depth: "triage" }))
      .rejects.toBeInstanceOf(IdempotencyRequestConflictError);
  });

  it("linearizes concurrent conflicting submissions so only one request owns the key", async () => {
    const [a, b] = await Promise.allSettled([
      store.enqueue({ ...baseInput, input: { repository: "acme/a" } }),
      store.enqueue({ ...baseInput, input: { repository: "acme/b" } }),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null)
      .toBeInstanceOf(IdempotencyRequestConflictError);
    const { rows } = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs");
    expect(rows[0]?.count).toBe("1");
  });

  it("fails closed for a migrated legacy row whose digest cannot be safely reconstructed", async () => {
    const first = await store.enqueue(baseInput);
    await db.query("UPDATE jobs SET submission_digest = $2 WHERE id = $1", [
      first.job.id,
      `sha256:${"0".repeat(64)}`,
    ]);
    await expect(store.enqueue(baseInput)).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
  });

  it("uses a versioned engine-owned sha256 digest while treating caller keys as opaque", () => {
    expect(JOB_SUBMISSION_DIGEST_VERSION).toBe("judgment-engine/job-submission/v1");
    expect(jobSubmissionDigest(baseInput)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(jobSubmissionDigest({ ...baseInput, idempotencyKey: "future namespace / opaque key" }))
      .toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => jobSubmissionDigest({ ...baseInput, input: new Date(0) }))
      .toThrow(/non-JSON object/);
  });
});

describe("claimNext (SKIP LOCKED)", () => {
  it("claims the oldest queued job once and marks it running", async () => {
    const { job } = await store.enqueue(baseInput);

    const claimed = await store.claimNext("w1", 60_000);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    // The claim records a fenced lease (#166).
    expect(claimed?.claimGeneration).toBe(1);
    expect(claimed?.leaseOwner).toBe("w1");
    expect(claimed?.leaseExpiresAt).toBeInstanceOf(Date);
    expect(claimed?.heartbeatAt).toBeInstanceOf(Date);

    // Nothing left queued.
    expect(await store.claimNext("w1", 60_000)).toBeNull();
  });
});

describe("lifecycle transitions", () => {
  it("completes a running job with a result pointer", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    await store.complete(job.id, "jobs/abc/critique/result.json", 1);

    const got = await store.get(job.id);
    expect(got?.status).toBe("succeeded");
    expect(got?.resultPointer).toBe("jobs/abc/critique/result.json");
  });

  it("fails a running job with an error", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    await store.fail(job.id, "capture unstable", 1);

    const got = await store.get(job.id);
    expect(got?.status).toBe("failed");
    expect(got?.error).toBe("capture unstable");
  });

  it("cancels a non-terminal job and refuses a terminal one", async () => {
    const { job } = await store.enqueue(baseInput);
    const canceled = await store.cancel(job.id);
    expect(canceled?.status).toBe("canceled");

    // Already terminal -> null.
    expect(await store.cancel(job.id)).toBeNull();
  });
});

describe("pg_notify dispatch", () => {
  it("notifies listeners on enqueue (no busy-poll)", async () => {
    const received: string[] = [];
    await db.listen(JOB_NOTIFY_CHANNEL, (payload: string) => received.push(payload));

    const { job } = await store.enqueue(baseInput);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toContain(job.id);
  });
});

describe("priority scheduling (#67)", () => {
  it("claims higher-priority work first (gate-blocking before other consumers)", async () => {
    // Enqueue a low-priority other-consumer job first, then a gate-blocking one.
    await store.enqueue({
      consumer: "mcp",
      installationId: "1",
      intentType: "pr_review",
      idempotencyKey: "mcp:1:pr_review:a",
      depth: "deep",
    });
    const { job: gateJob } = await store.enqueue({
      consumer: "gate",
      installationId: "1",
      intentType: "pr_review",
      idempotencyKey: "gate:1:pr_review:b",
      depth: "deep",
    });

    // Despite being enqueued second, the gate-blocking job is claimed first.
    const claimed = await store.claimNext("w1", 60_000);
    expect(claimed?.id).toBe(gateJob.id);
    expect(claimed?.priority).toBe(0);
  });
});

describe("cooperative cancellation (#66)", () => {
  it("requestCancel -> cancelling (immediately), then markCanceled -> canceled", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000); // running

    const cancelling = await store.requestCancel(job.id);
    expect(cancelling?.status).toBe("cancelling");

    // complete/fail are no-ops once the job left `running` (no result written).
    await store.complete(job.id, "jobs/x/critique/result.json", 1);
    const mid = await store.get(job.id);
    expect(mid?.status).toBe("cancelling");
    expect(mid?.resultPointer).toBeNull();

    const finalized = await store.markCanceled(job.id);
    expect(finalized?.status).toBe("canceled");
  });

  it("requestCancel returns null for an already-terminal job", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    await store.complete(job.id, "jobs/x/r.json", 1); // succeeded
    expect(await store.requestCancel(job.id)).toBeNull();
  });
});

describe("bounded worker retry", () => {
  it("requeues below the attempt budget and fails at the budget", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    expect(await store.retryOrFail(job.id, "transient", 2, 1)).toBe("queued");
    expect((await store.get(job.id))?.status).toBe("queued");

    await store.claimNext("w1", 60_000);
    expect(await store.retryOrFail(job.id, "still broken", 2, 2)).toBe("failed");
    const failed = await store.get(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("still broken");
  });

  it("never requeues a cancelling job", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    await store.requestCancel(job.id);
    expect(await store.retryOrFail(job.id, "late failure", 3, 1)).toBeNull();
    expect((await store.get(job.id))?.status).toBe("cancelling");
  });
});

describe("worker leases + crash recovery (#166)", () => {
  const expireLease = async (id: string) =>
    db.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);

  it("renews a held lease and refuses a stale owner/generation", async () => {
    const { job } = await store.enqueue(baseInput);
    const claimed = await store.claimNext("w1", 60_000);
    const before = claimed?.leaseExpiresAt?.getTime() ?? 0;

    expect(await store.renewLease(job.id, "w1", 1, 120_000)).toBe(true);
    const renewed = await store.get(job.id);
    expect((renewed?.leaseExpiresAt?.getTime() ?? 0) > before).toBe(true);

    expect(await store.renewLease(job.id, "w2", 1, 60_000)).toBe(false); // wrong owner
    expect(await store.renewLease(job.id, "w1", 2, 60_000)).toBe(false); // wrong generation
  });

  it("requeues an expired running attempt below the budget, clearing the lease", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    await expireLease(job.id);

    const recovered = await store.recoverExpired({ maxAttempts: 3 });
    expect(recovered).toEqual([{ id: job.id, outcome: "requeued", previousOwner: "w1" }]);

    const got = await store.get(job.id);
    expect(got?.status).toBe("queued");
    expect(got?.leaseOwner).toBeNull();
    expect(got?.leaseExpiresAt).toBeNull();
    expect(got?.startedAt).toBeNull();
    expect(got?.error).toContain("w1");
    // The dead worker's renewal and finalizations are fenced out.
    expect(await store.renewLease(job.id, "w1", 1, 60_000)).toBe(false);
    expect(await store.complete(job.id, "jobs/x/r.json", 1)).toBe(false);
    expect(await store.retryOrFail(job.id, "late", 3, 1)).toBeNull();
  });

  it("re-notifies workers for a requeued attempt (no poll-interval wait)", async () => {
    const received: string[] = [];
    await db.listen(JOB_NOTIFY_CHANNEL, (payload: string) => received.push(payload));
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    await expireLease(job.id);

    await store.recoverExpired({ maxAttempts: 3 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((id) => id === job.id).length).toBeGreaterThanOrEqual(2);
  });

  it("fails terminally at the attempt budget with a bounded reason", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    await expireLease(job.id);

    const recovered = await store.recoverExpired({ maxAttempts: 1 });
    expect(recovered).toEqual([{ id: job.id, outcome: "failed", previousOwner: "w1" }]);
    const got = await store.get(job.id);
    expect(got?.status).toBe("failed");
    expect(got?.finishedAt).toBeInstanceOf(Date);
    expect(got?.error).toBe("lease expired (worker w1 lost or attempt deadline exceeded)");
  });

  it("claims after recovery use a fresh generation; the old one cannot publish", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000); // generation 1
    await expireLease(job.id);
    await store.recoverExpired({ maxAttempts: 3 });

    const reclaimed = await store.claimNext("w2", 60_000);
    expect(reclaimed?.claimGeneration).toBeGreaterThan(1);
    expect(reclaimed?.attempts).toBe(2);

    // Old generation fenced; new generation publishes exactly once.
    expect(await store.complete(job.id, "jobs/old/r.json", 1)).toBe(false);
    expect(await store.complete(job.id, "jobs/new/r.json", reclaimed?.claimGeneration ?? 0)).toBe(true);
    const got = await store.get(job.id);
    expect(got?.status).toBe("succeeded");
    expect(got?.resultPointer).toBe("jobs/new/r.json");
  });

  it("recovers a live-but-hung attempt past the hard deadline even with fresh heartbeats", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    // Heartbeats keep the lease fresh, but the attempt started long ago.
    await db.query(`UPDATE jobs SET started_at = now() - interval '15 minutes' WHERE id = $1`, [job.id]);

    expect(await store.recoverExpired({ maxAttempts: 3 })).toEqual([]); // no deadline: lease is live
    const recovered = await store.recoverExpired({ maxAttempts: 3, maxAttemptMs: 10 * 60_000 });
    expect(recovered).toEqual([{ id: job.id, outcome: "requeued", previousOwner: "w1" }]);
  });

  it("finalizes stale cancelling rows: expired lease and never-claimed cancels", async () => {
    // Canceled while queued: no worker will ever claim it, so no one finalizes it.
    const { job: queuedJob } = await store.enqueue(baseInput);
    await store.requestCancel(queuedJob.id);

    // Canceled while running, then the worker died mid-teardown.
    const { job: runningJob } = await store.enqueue({
      ...baseInput,
      idempotencyKey: "gate:1:pr_review:sha-def",
    });
    await store.claimNext("w1", 60_000);
    await store.requestCancel(runningJob.id);
    await expireLease(runningJob.id);

    const recovered = await store.recoverExpired({ maxAttempts: 3 });
    const outcomes = new Map(recovered.map((r) => [r.id, r.outcome]));
    expect(outcomes.get(queuedJob.id)).toBe("canceled");
    expect(outcomes.get(runningJob.id)).toBe("canceled");
    expect((await store.get(queuedJob.id))?.status).toBe("canceled");
    expect((await store.get(runningJob.id))?.status).toBe("canceled");
  });

  it("does not touch live leases or terminal rows", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000); // live lease
    const { job: doneJob } = await store.enqueue({
      ...baseInput,
      idempotencyKey: "gate:1:pr_review:sha-done",
    });
    await store.claimNext("w1", 60_000);
    await store.complete(doneJob.id, "jobs/d/r.json", 1);

    expect(await store.recoverExpired({ maxAttempts: 3 })).toEqual([]);
    expect((await store.get(job.id))?.status).toBe("running");
    expect((await store.get(doneJob.id))?.status).toBe("succeeded");
  });

  it("a worker's own finalization still lands while it holds the lease", async () => {
    const { job } = await store.enqueue(baseInput);
    const claimed = await store.claimNext("w1", 60_000);
    expect(await store.complete(job.id, "jobs/ok/r.json", claimed?.claimGeneration ?? 0)).toBe(true);
  });

  it("fenced markCanceled: a stale worker cannot finalize a reclaimed cancelling job", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000); // generation 1
    await store.requestCancel(job.id);
    // Stale generation refused; correct generation finalizes; reaper path (no
    // generation) also allowed.
    expect(await store.markCanceled(job.id, 2)).toBeNull();
    expect((await store.get(job.id))?.status).toBe("cancelling");
    expect((await store.markCanceled(job.id, 1))?.status).toBe("canceled");
  });

  it("reports lease health for gauges", async () => {
    expect(await store.leaseStats()).toEqual({ activeLeases: 0, oldestRunningMs: null });
    await store.enqueue(baseInput);
    await store.claimNext("w1", 60_000);
    const stats = await store.leaseStats();
    expect(stats.activeLeases).toBe(1);
    expect(stats.oldestRunningMs).toBeGreaterThanOrEqual(0);
  });
});

describe("CancellationCoordinator", () => {
  it("registers an abortable signal and runs the kill seam on cancel", async () => {
    const killed: string[] = [];
    const coordinator = new CancellationCoordinator(async (id) => {
      killed.push(id);
    });
    const signal = coordinator.register("job_1");
    expect(signal.aborted).toBe(false);

    await coordinator.cancel("job_1");
    expect(signal.aborted).toBe(true);
    expect(coordinator.isAborted("job_1")).toBe(true);
    expect(killed).toEqual(["job_1"]);
  });

  it("swallows kill-seam errors (teardown is best-effort)", async () => {
    const coordinator = new CancellationCoordinator(async () => {
      throw new Error("microVM stop failed");
    });
    coordinator.register("job_2");
    await expect(coordinator.cancel("job_2")).resolves.toBeUndefined();
    expect(coordinator.isAborted("job_2")).toBe(true);
  });
});
