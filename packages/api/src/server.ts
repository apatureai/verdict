import {
  IdempotencyRequestConflictError,
  type CancellationCoordinator,
  type JobRecord,
  type JobStore,
  type ReviewDepth,
} from "@apatureai/verdict-jobs";
import { objectKey, type ObjectStore } from "@apatureai/verdict-storage";
import { SCHEMA_VERSION, type EngineReviewResult } from "@apatureai/verdict-types";
import {
  INSTALLATION_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyEngineRequest,
} from "./hmac.js";

/** Produces the wire result for a job (the worker step). */
export type JobProcessor = (job: JobRecord) => Promise<EngineReviewResult>;

/** Last result transformation/check before bytes enter durable publication. */
export type BeforePublish = (
  job: JobRecord,
  result: EngineReviewResult,
) => Promise<EngineReviewResult>;

export interface JobApiOptions {
  store: JobStore;
  objectStore: ObjectStore;
  /** HMAC secret (engineHmacSecret from the KMS-backed store). */
  secret: string;
  /** Consuming surface label for the dedup key (default "gate"). */
  consumer?: string;
  /** Intent label for the dedup key (default "pr_review"). */
  intentType?: string;
  /** Anti-replay window; omit to disable skew checking. */
  maxSkewMs?: number;
  now?: () => number;
  /**
   * Worker step. REQUIRED, with no default.
   *
   * This option used to be optional, falling back to an "EM0 stub" that
   * returned a version-stamped result with `findings: []`, `notReviewed: []`
   * and `promptVersion: "stub@0"`. An empty result is indistinguishable from a
   * clean review, so a deployment that had never been wired to the real
   * pipeline reported every page as having nothing wrong with it. There is no
   * safe default here: the only honest answer to "nothing is bound" is to
   * refuse to build the API, which is what the constructor does now. A caller
   * that wants a canned result passes one explicitly, at its own call site,
   * where a reader can see it.
   */
  processor: JobProcessor;
  /** Final fail-closed policy hook, after every processor path and before persistence. */
  beforePublish?: BeforePublish;
  /** Cooperative-cancellation coordinator (#66); when set, DELETE aborts inference + microVM. */
  coordinator?: CancellationCoordinator;
}

/** Transport-agnostic request (a thin HTTP adapter maps Node/Fastify onto this). */
export interface ApiRequest {
  method: string;
  /** Path only, e.g. "/jobs" or "/jobs/<id>". */
  path: string;
  headers: Record<string, string | undefined>;
  /** Raw request body (signed verbatim); "" for GET/DELETE. */
  body: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface SubmitBody {
  idempotencyKey?: unknown;
  depth?: unknown;
  request?: unknown;
}

/** Job ids are `gen_random_uuid()` values (see `0002_jobs.up.sql`). */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isJobId(value: string): boolean {
  return JOB_ID.test(value);
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body,
});

/**
 * Async job API: `POST /jobs` -> 202 {jobId} (409 on duplicate idempotency key),
 * `GET /jobs/:id` polls, `DELETE /jobs/:id` cancels. Every request is HMAC-
 * verified and scoped to the verified installationId; results carry the
 * `x-schema-version` header + version metadata.
 */
export function createJobApi(options: JobApiOptions) {
  // Defensive at runtime as well as in the type: this constructor is reachable
  // from JavaScript and from JSON-shaped configuration, and the failure mode it
  // guards (an unbound API answering "no findings") is the one this repository
  // exists to make impossible.
  if (typeof options.processor !== "function") {
    throw new Error("Job API requires an explicit review processor");
  }
  const consumer = options.consumer ?? "gate";
  const intentType = options.intentType ?? "pr_review";
  const { processor } = options;
  // Replay protection is on by default (signers send Date.now()); a caller can
  // widen/narrow the window but not silently ship with it off.
  const maxSkewMs = options.maxSkewMs ?? 300_000;

  function verify(req: ApiRequest): { ok: true; installationId: string } | { ok: false; res: ApiResponse } {
    const installationId = req.headers[INSTALLATION_HEADER] ?? "";
    const result = verifyEngineRequest({
      body: req.body,
      installationId,
      timestamp: req.headers[TIMESTAMP_HEADER] ?? "",
      signature: req.headers[SIGNATURE_HEADER] ?? "",
      secret: options.secret,
      maxSkewMs,
      now: options.now?.(),
    });
    if (!result.ok) return { ok: false, res: json(401, { error: result.reason }) };
    return { ok: true, installationId };
  }

  function toJobState(job: JobRecord): { state: string; error?: string } {
    switch (job.status) {
      case "queued":
        return { state: "pending" };
      case "running":
        return { state: "running" };
      case "succeeded":
        return { state: "completed" };
      case "cancelling":
        return { state: "cancelling" };
      case "failed":
        return { state: "failed", error: job.error ?? "engine job failed" };
      case "canceled":
        return { state: "failed", error: "canceled" };
      default: {
        // Exhaustiveness guard: adding a JobStatus without a case here is a
        // compile error, not a silent `undefined` state on the GET response.
        const _never: never = job.status;
        return { state: "failed", error: `unknown status ${String(_never)}` };
      }
    }
  }

  async function handlePost(req: ApiRequest, installationId: string): Promise<ApiResponse> {
    let parsed: SubmitBody;
    try {
      parsed = JSON.parse(req.body) as SubmitBody;
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const { idempotencyKey, depth } = parsed;
    if (typeof idempotencyKey !== "string" || (depth !== "triage" && depth !== "deep")) {
      return json(400, { error: "invalid_submission" });
    }

    let enqueued: Awaited<ReturnType<JobStore["enqueue"]>>;
    try {
      enqueued = await options.store.enqueue({
        consumer,
        installationId,
        intentType,
        idempotencyKey: `${consumer}:${installationId}:${intentType}:${idempotencyKey}`,
        depth: depth as ReviewDepth,
        input: parsed.request,
      });
    } catch (error) {
      if (error instanceof IdempotencyRequestConflictError) {
        // Non-enumerating: never disclose the existing job handle or digests.
        return json(409, { error: "idempotency_conflict" });
      }
      throw error;
    }
    const { job, created } = enqueued;
    // 202 created, or 409 exact retry -> consumer polls the existing job.
    return json(created ? 202 : 409, { jobId: job.id });
  }

  async function handleGet(id: string, installationId: string): Promise<ApiResponse> {
    const job = await options.store.get(id);
    // 404 (not 403) when the job is missing or owned by another tenant. No
    // existence disclosure across tenants.
    if (!job || job.installationId !== installationId) return json(404, { error: "not_found" });

    const mapped = toJobState(job);
    const headers = { "x-schema-version": SCHEMA_VERSION };
    if (job.status === "succeeded" && job.resultPointer) {
      const bytes = await options.objectStore.get(job.resultPointer);
      // A succeeded job whose result artifact is missing/expired (retention) must
      // NOT report `completed` with a null result: a poller would deref it and
      // crash. Report a terminal failure with a reason instead.
      if (!bytes) return json(200, { jobId: id, state: "failed", error: "result_unavailable" }, headers);
      const result = JSON.parse(new TextDecoder().decode(bytes)) as EngineReviewResult;
      return json(200, { jobId: id, state: "completed", result }, headers);
    }
    return json(200, { jobId: id, ...mapped }, headers);
  }

  async function handleDelete(id: string, installationId: string): Promise<ApiResponse> {
    const job = await options.store.get(id);
    if (!job || job.installationId !== installationId) return json(404, { error: "not_found" });
    // Cooperative cancel (#66): flip to `cancelling` immediately (consumer sees
    // intent at once), then best-effort abort inference + stop the microVM.
    const cancelling = await options.store.requestCancel(id);
    if (cancelling) await options.coordinator?.cancel(id);
    return json(200, { jobId: id, cancelling: cancelling !== null });
  }

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const verified = verify(req);
    if (!verified.ok) return verified.res;
    const { installationId } = verified;

    const segments = req.path.split("/").filter(Boolean); // ["jobs"] or ["jobs", "<id>"]
    if (segments[0] !== "jobs") return json(404, { error: "not_found" });
    const id = segments[1];

    // A job id is a uuid the engine minted. Anything else never named a job here,
    // and handing it to `jobs.id = $1` made Postgres raise a type error that
    // surfaced as `500 internal_error`: the engine reporting itself as broken
    // because a client asked for a handle that cannot exist. It is the same
    // answer as a handle belonging to another tenant, for the same reason:
    // 404, disclosing nothing.
    if (id !== undefined && !isJobId(id)) return json(404, { error: "not_found" });

    if (req.method === "POST" && !id) return handlePost(req, installationId);
    if (req.method === "GET" && id) return handleGet(id, installationId);
    if (req.method === "DELETE" && id) return handleDelete(id, installationId);
    return json(405, { error: "method_not_allowed" });
  }

  /**
   * Worker step: run the processor for a *running* job, persist the result to
   * object storage, and mark the job succeeded. Returns the wire result.
   * Publication is fenced on the worker's claim generation (#166): a late
   * worker whose lease expired and whose attempt was recovered cannot publish
   * over the recovered attempt.
   */
  async function processJob(jobId: string, claimGeneration: number): Promise<EngineReviewResult> {
    const job = await options.store.get(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    if (job.status !== "running") throw new Error(`job ${jobId} is not running`);
    if (job.claimGeneration !== claimGeneration) {
      throw new Error(`job ${jobId} claim generation ${claimGeneration} is stale`);
    }
    const assembled = await processor(job);
    // One hook covers the full/triage/empty processor paths. Authority and other
    // mutable policy must be rechecked here, not only when dependencies resolve.
    const result = options.beforePublish
      ? await options.beforePublish(job, assembled)
      : assembled;
    const pointer = objectKey(jobId, "critique", "result.json");
    await options.objectStore.put(pointer, JSON.stringify(result), {
      contentType: "application/json",
    });
    const published = await options.store.complete(jobId, pointer, claimGeneration);
    if (!published) {
      // Cancellation or lease recovery can win after inference but before
      // publication. The fenced DB transition is the linearization point;
      // remove the unreferenced object so a canceled/superseded/recovered
      // attempt leaves no publishable result artifact.
      await options.objectStore.delete(pointer);
      throw new Error(`job ${jobId} left running state before publication`);
    }
    return result;
  }

  return { handle, processJob };
}
