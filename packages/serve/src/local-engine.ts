import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createJobApi, type ApiRequest, type ApiResponse } from "@apatureai/verdict-api";
import type { CaptureBrowser } from "@apatureai/verdict-capture";
import {
  FileScreenshotSink,
  lexicalEmbedder,
  loadRepoContext,
  loadRepoGenome,
  localJudgmentProvenance,
  resolveLocalModel,
  runLocalReview,
  stampJudgmentProvenance,
  writeReviewArtifacts,
  LEXICAL_EMBEDDER_ID,
  type LocalGenome,
  type LocalReviewRequest,
  type ModelChoice,
  type ResolvedLocalModel,
  passModelsFromEnv,
  contextWindowFromEnv,
} from "@apatureai/verdict-cli";
import type { ContextBlockInput } from "@apatureai/verdict-context";
import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import { CancellationCoordinator, JobStore, type JobRecord } from "@apatureai/verdict-jobs";
import { EngineHttpServer } from "@apatureai/verdict-runtime/http";
import { EngineWorker } from "@apatureai/verdict-runtime/worker";
import { InMemoryObjectStore } from "@apatureai/verdict-storage";
import type { EngineReviewResult } from "@apatureai/verdict-types";
import { PGlite } from "@electric-sql/pglite";
import {
  artifactUrl,
  createArtifactServer,
  jobArtifactDir,
  jobScreenshotPrefix,
} from "./artifacts.js";
import { LocalEngineError } from "./errors.js";
import { assertAttested, LOCAL_ENGINE_NAME } from "./provenance.js";
import { toLocalReviewRequest } from "./request.js";

/**
 * verdict's job API, served for real, with nothing to provision.
 *
 * The async job API in `@apatureai/verdict-api` was always a complete transport: HMAC
 * verification, tenant scoping, exact idempotency, cancellation, claim-generation
 * fencing. What it never had was a review behind it. Its `processor` used to
 * default to a stub that answered every job with `findings: []` and
 * `promptVersion: "stub@0"`, and the only composition root that bound the real
 * pipeline (`@apatureai/verdict-runtime`) needs Postgres, an S3-compatible bucket and a
 * `CAPTURE_ENDPOINT` capture fleet that does not exist in this repository. So
 * the honest answer to "can I point something at verdict over HTTP" was no.
 *
 * This is that answer made yes. It binds the SAME job API to the SAME pipeline
 * the CLI runs (`runLocalReview`), backed by:
 *
 *   - an embedded PGlite database, migrated with the real migrations, so the job
 *     store is the real `JobStore` with its real claim and fencing semantics;
 *   - an in-memory object store for the result document;
 *   - in-process Chromium for capture, exactly as the CLI captures;
 *   - the CLI's `auto | mock | canned | live` model selection, off the same
 *     `MODEL_BASE_URL` / `MODEL_API_KEY` variables.
 *
 * What that buys, and what it costs, both stated:
 *   - jobs live in an in-memory database, so a restart forgets them;
 *   - one review runs at a time, because one browser serves the worker loop;
 *   - `DELETE /jobs/:id` aborts the model stream and marks the job cancelling,
 *     but an in-flight in-process capture runs to completion: there is no
 *     sandbox to kill here, and pretending otherwise would be the invention this
 *     repository exists to avoid.
 */

export interface LocalEngineOptions {
  /** HMAC secret every request must be signed with. */
  secret: string;
  /** Directory artifacts are written under. Created if missing. */
  outRoot: string;
  /** Injected so tests never launch a browser. */
  launchBrowser(): Promise<CaptureBrowser>;
  /** Environment the model selection reads (`MODEL_BASE_URL` / `MODEL_API_KEY`). */
  env?: Record<string, string | undefined>;
  /** `auto | mock | canned | live`, the CLI's `--model` (default `auto`). */
  model?: ModelChoice;
  /** Canned script for the offline path. */
  scriptPath?: string;
  /** Directory holding tokens.json / .designreview.yml / package.json. */
  contextDir?: string;
  /** Capture each page twice and compare the bytes. */
  verifyStability?: boolean;
  /** Worker poll interval (default 200ms; this queue is local and idle-cheap). */
  workerPollMs?: number;
  /**
   * Attempts before a job is failed. Default 1: a local capture failure is
   * almost never transient, and three Chromium runs to reach the same error
   * wastes minutes and says nothing new.
   */
  maxAttempts?: number;
  /** Origin used to build artifact URLs. Defaults to the listening address. */
  publicBaseUrl?: string;
  logger?: Pick<Console, "info" | "error">;
}

export interface LocalEngine {
  /** Which critique client this deployment resolved, and whether it is a model. */
  readonly model: ResolvedLocalModel;
  /** The transport handler, callable in-process without a socket. */
  handle(request: ApiRequest): Promise<ApiResponse>;
  /** Start listening; returns the bound port. */
  listen(port?: number, host?: string): Promise<number>;
  /** Origin artifact URLs are built against. Empty until `listen` or `publicBaseUrl`. */
  baseUrl(): string;
  /** Run every currently queued job to completion. Deterministic; used by tests. */
  drainOnce(): Promise<void>;
  close(): Promise<void>;
}

export async function createLocalEngine(options: LocalEngineOptions): Promise<LocalEngine> {
  if (!options.secret) throw new Error("createLocalEngine requires an HMAC secret");

  const outRoot = resolve(options.outRoot);
  await mkdir(outRoot, { recursive: true });
  const env = options.env ?? {};
  const logger = options.logger;

  const db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  const store = new JobStore(pgliteExecutor(db));
  const objectStore = new InMemoryObjectStore();

  const sink = new FileScreenshotSink(outRoot);
  const model = await resolveLocalModel({
    choice: options.model ?? "auto",
    env,
    resolveImageUrl: (image, maxPixels) => sink.dataUriFor(image.objectKey, maxPixels),
    ...(options.scriptPath ? { scriptPath: options.scriptPath } : {}),
  });

  let repoContext: ContextBlockInput | undefined;
  // The design system every job on this server is judged against, read once at
  // startup from the operator's directory. Without a `--context-dir` there is
  // nowhere to read one from and the reviews say so, job by job, rather than
  // reading as grounded reviews that happened to find nothing.
  let repoGenome: LocalGenome | undefined;
  if (options.contextDir) {
    repoContext = (await loadRepoContext(options.contextDir, [])).context;
    repoGenome = await loadRepoGenome(options.contextDir);
  }

  let base = options.publicBaseUrl ?? "";
  let browser: CaptureBrowser | null = null;
  const ensureBrowser = async (): Promise<CaptureBrowser> => {
    if (browser) return browser;
    try {
      browser = await options.launchBrowser();
    } catch (error) {
      throw new LocalEngineError(
        "capture_unavailable",
        `could not launch a browser, so nothing could be captured: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return browser;
  };

  // No sandbox to tear down: capture runs in this process. The abort signal the
  // coordinator hands out still reaches every model call, which is the part that
  // can actually be stopped, and the kill hook says so instead of pretending.
  const coordinator = new CancellationCoordinator(async (jobId) => {
    logger?.info(
      `engine job ${jobId} cancelling: the model stream is aborted; an in-flight local capture runs to completion`,
    );
  });

  const processor = async (job: JobRecord): Promise<EngineReviewResult> => {
    const request: LocalReviewRequest = {
      ...toLocalReviewRequest(job, {
        ...(repoContext ? { repoContext } : {}),
        ...(repoGenome ? { genome: repoGenome } : {}),
        ...(options.verifyStability !== undefined ? { verifyStability: options.verifyStability } : {}),
        keyPrefix: jobScreenshotPrefix(job.id),
      }),
      // C2: run the context-window preflight on a live run (same resolution as the
      // CLI), so a served job degrades the map deterministically instead of the
      // endpoint silently context-shifting it. Offline clients need no preflight.
      ...(model.kind === "live" ? { contextWindow: contextWindowFromEnv(process.env) } : {}),
    };
    const signal = coordinator.register(job.id);
    const outcome = await runLocalReview(request, {
      browser: await ensureBrowser(),
      sink,
      modelFactory: model.factory,
      ...(passModelsFromEnv() ? { passModels: passModelsFromEnv() } : {}),
      // The same offline embedder the CLI injects, so a job served here and a
      // run of `pnpm review` over the same directory retrieve the same rules.
      embedder: lexicalEmbedder,
      embedderId: LEXICAL_EMBEDDER_ID,
      artifactUrlFor: (key) => artifactUrl(base, options.secret, key),
      signal,
    });

    const stamped = stampJudgmentProvenance(
      {
        ...outcome.result,
        artifacts: {
          ...outcome.result.artifacts,
          engineDebugUrl: artifactUrl(base, options.secret, `jobs/${job.id}`),
        },
      },
      localJudgmentProvenance(LOCAL_ENGINE_NAME, model.kind, outcome.result.metadata.model),
    );

    // The same four files the CLI writes, so `review.json` on disk and the body
    // of `GET /jobs/:id` are the same bytes, and the geometry map and the
    // measured facts a caller wants are fetchable rather than merely counted.
    await writeReviewArtifacts(jobArtifactDir(outRoot, job.id), { ...outcome, result: stamped });
    return stamped;
  };

  const api = createJobApi({
    store,
    objectStore,
    secret: options.secret,
    processor,
    // Fail-closed: nothing is published without a judgment-provenance stamp.
    beforePublish: async (_job, result) => assertAttested(result),
    coordinator,
  });

  const worker = new EngineWorker({
    store,
    processJob: api.processJob,
    pollIntervalMs: options.workerPollMs ?? 200,
    maxAttempts: options.maxAttempts ?? 1,
    onJobSettled: (jobId) => coordinator.release(jobId),
    ...(logger ? { logger } : {}),
  });

  const server = new EngineHttpServer({
    handle: api.handle,
    serveRaw: createArtifactServer({ root: outRoot, secret: options.secret }),
    readiness: {
      database: async () => {
        await db.query("SELECT 1");
        return true;
      },
      // Readiness for this deployment is literally "can it capture", so the probe
      // launches the browser it would use. A missing Chromium fails /readyz.
      capture: async () => {
        await ensureBrowser();
        return true;
      },
      worker: () => worker.isReady(),
    },
  });

  let started = false;

  return {
    model,
    handle: api.handle,
    baseUrl: () => base,
    async listen(port = 0, host = "127.0.0.1") {
      const bound = await server.listen(port, host);
      if (!options.publicBaseUrl) base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${bound}`;
      await worker.start();
      started = true;
      return bound;
    },
    async drainOnce() {
      if (!started) {
        await worker.start();
        started = true;
      }
      await worker.drainOnce();
    },
    async close() {
      await server.close();
      await worker.stop();
      if (browser) await browser.close().catch(() => undefined);
      await db.close();
    },
  };
}
