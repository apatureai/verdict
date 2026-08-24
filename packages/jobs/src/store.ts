import type { SqlExecutor } from "@apatureai/verdict-db";
import { jobPriority } from "./priority.js";
import { jobSubmissionDigest } from "./submission-digest.js";

export type JobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "canceled";
export type ReviewDepth = "triage" | "deep";

/** Postgres NOTIFY channel workers LISTEN on; payload is the new job id. */
export const JOB_NOTIFY_CHANNEL = "engine_jobs";

export interface EnqueueJobInput {
  /** Consuming surface: "gate", "mcp", ... */
  consumer: string;
  installationId: string;
  /** Intent kind, e.g. "pr_review". */
  intentType: string;
  /** `{consumer}:{installationId}:{intentType}:{intentHash}`: the dedup key. */
  idempotencyKey: string;
  depth: ReviewDepth;
  /** Opaque job payload (target, trace carrier, ...). */
  input?: unknown;
}

export interface JobRecord {
  id: string;
  consumer: string;
  installationId: string;
  intentType: string;
  idempotencyKey: string;
  /** Engine-owned digest of immutable submission identity (legacy rows use a reserved sentinel). */
  submissionDigest: string;
  depth: ReviewDepth;
  status: JobStatus;
  input: unknown;
  /** Scheduling priority (lower = higher); the claim serves lowest first (#67). */
  priority: number;
  resultPointer: string | null;
  error: string | null;
  attempts: number;
  /**
   * Fencing token (#166): bumped on every claim. Finalization (`complete`,
   * `fail`, `retryOrFail`, lease renewal) is conditional on it, so a worker
   * whose lease expired and whose attempt was recovered can never publish over
   * the recovered attempt.
   */
  claimGeneration: number;
  /** Identity of the worker holding the current claim (null when unleased). */
  leaseOwner: string | null;
  /** When the current claim's lease lapses and the attempt becomes recoverable. */
  leaseExpiresAt: Date | null;
  /** Last successful lease renewal by the owning worker. */
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface JobRow {
  id: string;
  consumer: string;
  installation_id: string;
  intent_type: string;
  idempotency_key: string;
  submission_digest: string;
  depth: ReviewDepth;
  status: JobStatus;
  input: unknown;
  priority: number;
  result_pointer: string | null;
  error: string | null;
  attempts: number;
  claim_generation: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLS = `id, consumer, installation_id, intent_type, idempotency_key, submission_digest, depth, status, input,
  priority, result_pointer, error, attempts, claim_generation, lease_owner, lease_expires_at,
  heartbeat_at, created_at, updated_at, started_at, finished_at`;

function mapRow(r: JobRow): JobRecord {
  return {
    id: r.id,
    consumer: r.consumer,
    installationId: r.installation_id,
    intentType: r.intent_type,
    idempotencyKey: r.idempotency_key,
    submissionDigest: r.submission_digest,
    depth: r.depth,
    status: r.status,
    input: r.input,
    priority: r.priority,
    resultPointer: r.result_pointer,
    error: r.error,
    attempts: r.attempts,
    claimGeneration: r.claim_generation,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    heartbeatAt: r.heartbeat_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** One recovered attempt from `recoverExpired` (#166). */
export interface RecoveredJob {
  id: string;
  /** State the job was moved to: requeued below budget, failed at it, canceled if it was cancelling. */
  outcome: "requeued" | "failed" | "canceled";
  /** Worker that held the lapsed lease (null for a never-claimed cancelling row). */
  previousOwner: string | null;
}

export interface RecoverExpiredOptions {
  /** Attempt budget: an expired attempt below it requeues, at it fails terminally. */
  maxAttempts: number;
  /**
   * Optional hard attempt deadline in ms, independent of heartbeats: a live
   * worker stuck in a hung capture/model call renews its lease forever, so the
   * reaper also recovers any `running` attempt older than this deadline.
   */
  maxAttemptMs?: number;
}

/** Typed, non-enumerating rejection for a reused key bound to another request. */
export class IdempotencyRequestConflictError extends Error {
  readonly code = "idempotency_request_conflict" as const;

  constructor() {
    super("idempotency key is already bound to a different immutable submission");
    this.name = "IdempotencyRequestConflictError";
  }
}

/**
 * Job store over Postgres (TRD §3). Status + metadata live here (the source of
 * truth); results live in object storage, referenced by `resultPointer`. Enqueue
 * is idempotent across consumers via the unique `idempotency_key`; workers are
 * woken by `pg_notify` on `engine_jobs` and claim with `FOR UPDATE SKIP LOCKED`,
 * so there is no busy-poll.
 *
 * Ownership (#166): `SKIP LOCKED` only arbitrates the claim transaction; it is
 * not a durable lease. Every claim records a lease (`lease_owner`,
 * `lease_expires_at`) and bumps `claim_generation`; the owning worker renews the
 * lease while working, and every finalization is fenced on the generation, so a
 * worker that lost its lease (crash, OOM, machine replacement, hung call past
 * the attempt deadline) can never publish, fail, or cancel over the recovered
 * attempt.
 */
export class JobStore {
  constructor(private readonly exec: SqlExecutor) {}

  /**
   * Enqueue a job, returning the existing one only for an exact immutable retry
   * (`created: false`). ACID dedup via `ON CONFLICT DO NOTHING` + re-select.
   */
  async enqueue(input: EnqueueJobInput): Promise<{ job: JobRecord; created: boolean }> {
    const submissionDigest = jobSubmissionDigest(input);
    const storedInput = input.input === undefined ? {} : input.input;
    const { rows } = await this.exec.query<JobRow>(
      `INSERT INTO jobs (consumer, installation_id, intent_type, idempotency_key, submission_digest, depth, input, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLS}`,
      [
        input.consumer,
        input.installationId,
        input.intentType,
        input.idempotencyKey,
        submissionDigest,
        input.depth,
        JSON.stringify(storedInput),
        jobPriority(input.consumer, input.intentType),
      ],
    );

    const inserted = rows[0];
    if (inserted) return { job: mapRow(inserted), created: true };

    // The UNIQUE insert is the linearization point. A conflict may reuse the
    // existing handle only when the immutable engine-owned digest matches.
    const existing = await this.getByIdempotencyKey(input.idempotencyKey);
    if (!existing) throw new Error("enqueue conflict but the existing job could not be resolved");
    if (existing.submissionDigest !== submissionDigest) {
      throw new IdempotencyRequestConflictError();
    }
    return { job: existing, created: false };
  }

  async get(id: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(`SELECT ${COLS} FROM jobs WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async getByIdempotencyKey(key: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `SELECT ${COLS} FROM jobs WHERE idempotency_key = $1`,
      [key],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Atomically claim the oldest queued job, marking it running under a new
   * lease/generation owned by `owner`. Uses `FOR UPDATE SKIP LOCKED` so
   * concurrent workers never claim the same job and never block each other.
   * Returns null when the queue is empty.
   */
  async claimNext(owner: string, leaseTtlMs: number): Promise<JobRecord | null> {
    if (!owner) throw new Error("claimNext requires a worker identity");
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1) {
      throw new Error("leaseTtlMs must be a positive integer");
    }
    const { rows } = await this.exec.query<JobRow>(
      `UPDATE jobs
         SET status = 'running', started_at = now(), attempts = attempts + 1,
             claim_generation = claim_generation + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($2 * interval '1 millisecond'),
             heartbeat_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued'
         ORDER BY priority, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLS}`,
      [owner, leaseTtlMs],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Renew the lease for a claim the worker still owns. Returns false when the
   * worker no longer holds the claim (lease recovered, job finalized, or a
   * newer generation claimed it). The caller must treat the attempt as lost
   * and stop publishing.
   */
  async renewLease(
    id: string,
    owner: string,
    claimGeneration: number,
    leaseTtlMs: number,
  ): Promise<boolean> {
    const { rows } = await this.exec.query<{ id: string }>(
      `UPDATE jobs
         SET lease_expires_at = now() + ($4 * interval '1 millisecond'),
             heartbeat_at = now()
       WHERE id = $1 AND lease_owner = $2 AND claim_generation = $3
         AND status IN ('running', 'cancelling')
       RETURNING id`,
      [id, owner, claimGeneration, leaseTtlMs],
    );
    return rows.length === 1;
  }

  /**
   * Mark a running job succeeded with a pointer to its result in object
   * storage. Fenced on `claimGeneration`: a late worker whose attempt was
   * recovered gets false and must delete its unreferenced result object.
   */
  async complete(id: string, resultPointer: string, claimGeneration: number): Promise<boolean> {
    const { rows } = await this.exec.query<{ id: string }>(
      `UPDATE jobs SET status = 'succeeded', result_pointer = $2, finished_at = now(),
              lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'running' AND claim_generation = $3
       RETURNING id`,
      [id, resultPointer, claimGeneration],
    );
    return rows.length === 1;
  }

  /** Mark a running job failed with an error message (fenced on the claim generation). */
  async fail(id: string, error: string, claimGeneration: number): Promise<boolean> {
    const { rows } = await this.exec.query<{ id: string }>(
      `UPDATE jobs SET status = 'failed', error = $2, finished_at = now(),
              lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'running' AND claim_generation = $3
       RETURNING id`,
      [id, error, claimGeneration],
    );
    return rows.length === 1;
  }

  /**
   * Retry a failed attempt while it is below the bounded attempt budget, or
   * atomically mark it terminal. A cancelled/cancelling job is never requeued.
   * Fenced on the claim generation; returns null when the worker lost ownership.
   */
  async retryOrFail(
    id: string,
    error: string,
    maxAttempts: number,
    claimGeneration: number,
  ): Promise<"queued" | "failed" | null> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    const { rows } = await this.exec.query<{ status: "queued" | "failed" }>(
      `UPDATE jobs
         SET status = CASE WHEN attempts < $3 THEN 'queued' ELSE 'failed' END,
             error = $2,
             lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
             started_at = CASE WHEN attempts < $3 THEN NULL ELSE started_at END,
             finished_at = CASE WHEN attempts < $3 THEN NULL ELSE now() END
       WHERE id = $1 AND status = 'running' AND claim_generation = $4
       RETURNING status`,
      [id, error, maxAttempts, claimGeneration],
    );
    const state = rows[0]?.status ?? null;
    if (state === "queued") await this.notifyRequeued([id]);
    return state;
  }

  /**
   * Recover attempts whose worker is gone (#166): any `running` row past its
   * lease expiry, or past the optional hard attempt deadline even with a live
   * heartbeat, requeues below the attempt budget or fails terminally at it,
   * with a bounded reason recording the lost owner. Expired or never-leased
   * `cancelling` rows finalize to `canceled` (a job canceled while still queued
   * is never claimed, so no worker would ever finalize it). Requeued ids are
   * re-notified so LISTENing workers pick them up without waiting for a poll.
   *
   * Safe to run from every worker (startup + periodic): the guarded UPDATE is
   * the arbiter, so concurrent reapers recover each row exactly once.
   */
  async recoverExpired(options: RecoverExpiredOptions): Promise<RecoveredJob[]> {
    const { maxAttempts, maxAttemptMs } = options;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (maxAttemptMs !== undefined && (!Number.isInteger(maxAttemptMs) || maxAttemptMs < 1)) {
      throw new Error("maxAttemptMs must be a positive integer");
    }

    const recovered: RecoveredJob[] = [];

    const { rows: expiredRunning } = await this.exec.query<{
      id: string;
      status: "queued" | "failed";
      previous_owner: string | null;
    }>(
      `WITH expired AS (
         SELECT id, lease_owner FROM jobs
         WHERE status = 'running'
           AND (lease_expires_at < now()
                OR ($2::bigint IS NOT NULL AND started_at < now() - ($2 * interval '1 millisecond')))
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs j
         SET status = CASE WHEN j.attempts < $1 THEN 'queued' ELSE 'failed' END,
             error = 'lease expired (worker ' || coalesce(e.lease_owner, 'unknown') || ' lost or attempt deadline exceeded)',
             claim_generation = j.claim_generation + 1,
             lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
             started_at = CASE WHEN j.attempts < $1 THEN NULL ELSE j.started_at END,
             finished_at = CASE WHEN j.attempts < $1 THEN NULL ELSE now() END
       FROM expired e
       WHERE j.id = e.id
       RETURNING j.id, j.status, e.lease_owner AS previous_owner`,
      [maxAttempts, maxAttemptMs ?? null],
    );
    for (const row of expiredRunning) {
      recovered.push({
        id: row.id,
        outcome: row.status === "queued" ? "requeued" : "failed",
        previousOwner: row.previous_owner,
      });
    }

    const { rows: staleCancelling } = await this.exec.query<{
      id: string;
      previous_owner: string | null;
    }>(
      `WITH stale AS (
         SELECT id, lease_owner FROM jobs
         WHERE status = 'cancelling'
           AND (lease_expires_at < now() OR lease_expires_at IS NULL)
         FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs j
         SET status = 'canceled', finished_at = now(),
             claim_generation = j.claim_generation + 1,
             lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL
       FROM stale s
       WHERE j.id = s.id
       RETURNING j.id, s.lease_owner AS previous_owner`,
    );
    for (const row of staleCancelling) {
      recovered.push({ id: row.id, outcome: "canceled", previousOwner: row.previous_owner });
    }

    await this.notifyRequeued(recovered.filter((r) => r.outcome === "requeued").map((r) => r.id));
    return recovered;
  }

  /** Low-cardinality lease health snapshot for gauges/alerts (#166). */
  async leaseStats(): Promise<{ activeLeases: number; oldestRunningMs: number | null }> {
    const { rows } = await this.exec.query<{ active: number; oldest_ms: number | null }>(
      `SELECT count(*) FILTER (WHERE status = 'running')::int AS active,
              (extract(epoch FROM now() - min(started_at) FILTER (WHERE status = 'running')) * 1000)::float8 AS oldest_ms
       FROM jobs`,
    );
    const row = rows[0];
    return {
      activeLeases: row?.active ?? 0,
      oldestRunningMs: row?.oldest_ms ?? null,
    };
  }

  /**
   * Cancel a non-terminal job. Returns the updated record, or null if the job
   * was already terminal (succeeded/failed/canceled) or does not exist.
   */
  async cancel(id: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `UPDATE jobs SET status = 'canceled', finished_at = now(),
              lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING ${COLS}`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Cooperative-cancel step 1 (#66): move a non-terminal job to `cancelling`
   * immediately so consumers see the intent at once. Returns the record, or null
   * if already terminal/cancelling. Teardown (microVM kill + inference abort)
   * happens after; `markCanceled` finalizes. Because `complete`/`fail` only act
   * on `running` rows, no result is written for a job once it leaves `running`.
   */
  async requestCancel(id: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `UPDATE jobs SET status = 'cancelling'
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING ${COLS}`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Cooperative-cancel step 2 (#66): finalize a `cancelling` job to `canceled`.
   * When the caller is the claim-holding worker it passes its generation so a
   * recovered attempt cannot be finalized by the stale worker; the reaper
   * finalizes ownerless/expired `cancelling` rows via `recoverExpired`.
   */
  async markCanceled(id: string, claimGeneration?: number): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `UPDATE jobs SET status = 'canceled', finished_at = now(),
              lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'cancelling'
         AND ($2::int IS NULL OR claim_generation = $2)
       RETURNING ${COLS}`,
      [id, claimGeneration ?? null],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Re-emit the worker wakeup for requeued jobs (the insert trigger only fires on enqueue). */
  private async notifyRequeued(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.exec.query(`SELECT pg_notify('${JOB_NOTIFY_CHANNEL}', $1)`, [id]);
    }
  }
}
