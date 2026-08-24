import { S3Client } from "@aws-sdk/client-s3";
import { createJobApi, createJobReviewProcessor } from "@apatureai/verdict-api";
import { buildGenomeIndex, type Embedder } from "@apatureai/verdict-context";
import {
  ENGINE_VERSION,
  PROMPT_VERSION,
  RUBRIC_VERSION,
  enforceGroundingAuthority,
  resolvePassModel,
  type ModelClientFactory,
  type PassModelOverrides,
} from "@apatureai/verdict-critique";
import { pgExecutor } from "@apatureai/verdict-db";
import {
  createCalibrationRuntimeBinding,
  ModelPromptRegistry,
  type PromotedCalibration,
} from "@apatureai/verdict-eval";
import { CancellationCoordinator, JobStore, type JobRecord } from "@apatureai/verdict-jobs";
import { EngineMetrics, initTelemetry, METER_NAME, type Telemetry } from "@apatureai/verdict-observability";
import { EnvSecretStore } from "@apatureai/verdict-secrets";
import { S3ObjectStore, type ObjectStore } from "@apatureai/verdict-storage";
import type { EngineReviewResult, GroundingAuthorityUnknownReason } from "@apatureai/verdict-types";
import { Pool } from "pg";
import { HttpCaptureClient, HttpGenomeResolver, createOpenAIAdapters, type CaptureClient, type GenomeResolver } from "./adapters.js";
import {
  GroundingAuthorityError,
  authorityProvenance,
  compareAuthorityReceipts,
  monotonicGroundingAuthorityPort,
  unknownAuthorityProvenance,
  validateGroundingAuthorityReceipt,
  type GroundingAuthorityKey,
  type GroundingAuthorityPort,
  type GroundingAuthorityReceipt,
} from "./authority.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import {
  applyCaptureEvidence,
  assertEvidenceResolvable,
  signEvidenceUrls,
} from "./evidence.js";
import { EngineHttpServer } from "./http.js";
import { repositoryForJob, toReviewInput } from "./input.js";
import { applyMeasuredRoutes, measurementGap, stabilityGap } from "./measurement.js";
import {
  assertAttested,
  stampJudgmentProvenance,
  UnattestedResultError,
  witnessModelCalls,
  type JudgmentWitness,
} from "./provenance.js";
import { EngineWorker, PgNotificationSource, type NotificationSource } from "./worker.js";

export interface EngineRuntimeOptions {
  store: JobStore;
  objectStore: ObjectStore;
  engineHmacSecret: string;
  capture: CaptureClient;
  modelFactory: ModelClientFactory;
  passModels?: PassModelOverrides;
  calibrationResolver?: { currentCalibration(): Promise<PromotedCalibration | null> };
  genomeResolver?: GenomeResolver;
  /** Required alongside genomeResolver; rechecks the exact version at publication. */
  groundingAuthority?: GroundingAuthorityPort;
  /** Authority mirror freshness bound (default 60 seconds). */
  authorityMaxAgeMs?: number;
  authorityNow?: () => Date;
  authorityMetrics?: Pick<
    EngineMetrics,
    "recordAuthorityLookupLatency" | "recordAuthorityLookupFailure"
  >;
  /**
   * Where the measured half's own instruments are recorded. Separate from
   * `authorityMetrics` only because they are recorded at a different point in
   * the run; in the composition root both are the same `EngineMetrics`.
   *
   * These two counters are the reversal signals for the measurement decision:
   * how often a measured page drew no judgment at all, and how often a result
   * carries no measurement, so nobody downstream infers "clean" from silence.
   */
  reviewMetrics?: Pick<
    EngineMetrics,
    "recordMeasuredFactsUnjudged" | "recordMeasurementsAbsent"
  >;
  embedder?: Embedder;
  /**
   * How long a published review's evidence links stay openable, in seconds
   * (default one hour). This is the TTL on the signed object-store URLs the
   * publication step mints for every finding's screenshot: after it elapses the
   * links are dead and the durable object key in `screenshotId` is all that is
   * left. Longer means a leaked result document grants access for longer;
   * shorter means a reviewer who opens the PR comment tomorrow finds nothing.
   */
  evidenceUrlTtlSeconds?: number;
  notificationSource?: NotificationSource;
  databaseReady(): Promise<boolean>;
  workerPollMs?: number;
  workerMaxAttempts?: number;
  /** Lease TTL per claimed attempt; the worker heartbeats at a third of it (#166). */
  workerLeaseMs?: number;
  /** Hard per-attempt deadline independent of heartbeats (#166); unset = none. */
  jobMaxAttemptMs?: number;
  logger?: Pick<Console, "info" | "error">;
}

export interface EngineRuntime {
  server: EngineHttpServer;
  worker: EngineWorker;
  start(port: number, host?: string): Promise<number>;
  stop(): Promise<void>;
}

/** Compose the real API, orchestrator processor, cancellation, worker, and health surfaces. */
export function createEngineRuntime(options: EngineRuntimeOptions): EngineRuntime {
  if (Boolean(options.genomeResolver) !== Boolean(options.groundingAuthority)) {
    throw new Error("UI-DNA grounding requires both genomeResolver and groundingAuthority");
  }
  const authorityNow = options.authorityNow ?? ((): Date => new Date());
  const authority = options.groundingAuthority
    ? monotonicGroundingAuthorityPort({
        statusFor: async (key) => validateGroundingAuthorityReceipt(
          await options.groundingAuthority!.statusFor(key),
          { now: authorityNow(), ...(options.authorityMaxAgeMs !== undefined
            ? { maxAgeMs: options.authorityMaxAgeMs }
            : {}) },
        ),
      })
    : undefined;
  const groundingByJob = new Map<string, {
    key: GroundingAuthorityKey;
    initial: GroundingAuthorityReceipt | null;
    initialFailure: GroundingAuthorityUnknownReason | null;
  }>();
  const evidenceUrlTtlSeconds = options.evidenceUrlTtlSeconds ?? 3_600;
  // What each in-flight job's model calls actually did, keyed the same way and
  // torn down at the same moment as the grounding evidence above: the answer is
  // observed while the review runs and read at publication.
  const witnessByJob = new Map<string, JudgmentWitness>();
  const coordinator = new CancellationCoordinator((jobId) => options.capture.cancel(jobId));
  const coreProcessor = createJobReviewProcessor(
    (job: JobRecord) => toReviewInput(job, evidenceUrlTtlSeconds),
    async (job: JobRecord, input) => {
      const signal = coordinator.register(job.id);
      const witness = witnessModelCalls(options.modelFactory);
      witnessByJob.set(job.id, witness);
      const promotedCalibration = options.calibrationResolver
        ? await options.calibrationResolver.currentCalibration()
        : null;
      const deepModel = resolvePassModel("deep", options.passModels).model;
      const calibration = promotedCalibration
        ? createCalibrationRuntimeBinding(
            promotedCalibration.report,
            promotedCalibration.promotionMode,
            {
              model: deepModel,
              promptVersion: PROMPT_VERSION,
              engineVersion: ENGINE_VERSION,
              rubricVersion: RUBRIC_VERSION,
            },
          )
        : { ok: false as const, reason: "missing_calibration_report" as const, error: "no promoted calibration report" };
      const resolvedGenome = options.genomeResolver
        ? await options.genomeResolver.resolve(repositoryForJob(job), job.installationId)
        : null;
      if (resolvedGenome && !options.embedder) {
        throw new Error("UI-DNA grounding resolved a genome but no embedder is configured");
      }
      input.context.uiDnaVersion = resolvedGenome?.version ?? null;
      if (resolvedGenome) {
        let initial: GroundingAuthorityReceipt | null = null;
        let initialFailure: GroundingAuthorityUnknownReason | null = null;
        try {
          initial = validateGroundingAuthorityReceipt(resolvedGenome.authority, {
            now: authorityNow(),
            ...(options.authorityMaxAgeMs !== undefined ? { maxAgeMs: options.authorityMaxAgeMs } : {}),
          });
        } catch (error) {
          initialFailure = error instanceof GroundingAuthorityError ? error.reason : "malformed";
        }
        groundingByJob.set(job.id, {
          key: {
            tenantId: job.installationId,
            repository: repositoryForJob(job),
            dnaVersion: resolvedGenome.version,
          },
          initial,
          initialFailure,
        });
      }
      const genomeIndex = resolvedGenome && options.embedder
        ? await buildGenomeIndex(resolvedGenome.version, resolvedGenome.rules, options.embedder)
        : undefined;

      // Capture FIRST, then build the per-route inputs from what the capture
      // MEASURED, then hand the orchestrator the capture it already has. This is
      // the same order the local pipeline runs in (`runLocalReview` captures,
      // calls `factsForRoute` / `breakageForRoute`, and passes
      // `captureInSandbox: async () => captured`), and it is the only order that
      // can work: the deterministic checks are computed during capture, so the
      // facts that ground the deep prompt and the breakage that overrules triage
      // do not exist yet when `toReviewInput` builds the routes.
      //
      // Before this, that ordering problem was simply not solved on this path:
      // `toReviewInput` emitted bare `{ route }` objects and nothing ever filled
      // them, so the deployed service ran every deep prompt with no measured
      // facts and every triage pass with nothing that could overrule a model
      // declining to look. The behaviour documented on `ReviewRoute` -- that
      // both shipped surfaces populate `deterministicBreakage` -- was true of the
      // CLI and the local server and false of the thing behind the HTTP API.
      const captured = await options.capture.forJob(job.id, signal)(input.url, input.captureContext);
      applyMeasuredRoutes(input, captured);
      // Same ordering problem, same answer: a finding's evidence is the shot of
      // its own route and viewport, and which shots exist is a fact about the
      // capture that has just come back.
      applyCaptureEvidence(input, captured);
      const gap = measurementGap(captured);
      if (gap) options.logger?.info(`engine job ${job.id}: ${gap}`);
      // The same shape of honesty for the other thing a capture service may not
      // implement: a review that ASKED for the determinism check and got no
      // counts back verified nothing, and must not read as though it did.
      const stabilityMissing = stabilityGap(input.captureContext, captured);
      if (stabilityMissing) options.logger?.info(`engine job ${job.id}: ${stabilityMissing}`);

      return {
        // The capture already ran, so the seam hands the orchestrator the result
        // it produced rather than capturing the same pages a second time.
        captureInSandbox: async () => captured,
        // The witness is a pass-through around the configured factory; the
        // orchestrator gets the same clients and the result gets to say whether
        // any of them was ever asked to look at a page.
        modelFactory: witness.factory,
        ...(options.passModels ? { passModels: options.passModels } : {}),
        ...(calibration.ok
          ? { calibration: calibration.binding }
          : { confidenceUnavailableReason: calibration.reason }),
        ...(genomeIndex ? { genomeIndex } : {}),
        ...(genomeIndex && options.embedder ? { embedder: options.embedder } : {}),
        signal,
      };
    },
  );
  const processor = async (job: JobRecord) => {
    const result = await coreProcessor(job);
    // Recorded from the published result, so the counter and the payload a
    // consumer reads can never disagree about which run this was.
    if (result.gradeUnavailableReason === "measured_facts_unjudged") {
      options.reviewMetrics?.recordMeasuredFactsUnjudged({ model: result.metadata.model });
    }
    if (result.measurements === undefined) {
      options.reviewMetrics?.recordMeasurementsAbsent({ model: result.metadata.model });
    }
    return result;
  };
  const applyGroundingAuthority = async (
    job: JobRecord,
    assembled: EngineReviewResult,
  ): Promise<EngineReviewResult> => {
    const grounding = groundingByJob.get(job.id);
    if (!grounding || !authority) return assembled;

    const startedAt = Date.now();
    let publication: GroundingAuthorityReceipt | null = null;
    try {
      publication = await authority.statusFor(grounding.key);
      if (grounding.initialFailure) {
        throw new GroundingAuthorityError(
          grounding.initialFailure,
          "resolve-time authority evidence was not trustworthy",
        );
      }
      if (!grounding.initial) {
        throw new GroundingAuthorityError("missing", "resolve-time authority evidence is missing");
      }
      if (assembled.metadata.uiDnaVersion !== grounding.key.dnaVersion) {
        throw new GroundingAuthorityError("malformed", "result DNA version differs from authority key");
      }
      compareAuthorityReceipts(grounding.initial, publication);
      const publicationCheckedAt = authorityNow().toISOString();
      options.authorityMetrics?.recordAuthorityLookupLatency(Date.now() - startedAt, {
        outcome: publication.status,
      });
      const stamped: EngineReviewResult = {
        ...assembled,
        metadata: {
          ...assembled.metadata,
          groundingAuthority: authorityProvenance(publication, publicationCheckedAt),
        },
      };
      return enforceGroundingAuthority(stamped, { status: publication.status });
    } catch (error) {
      const reason: GroundingAuthorityUnknownReason = error instanceof GroundingAuthorityError
        ? error.reason
        : "unavailable";
      const lastKnown = error instanceof GroundingAuthorityError ? error.lastKnown : undefined;
      const publicationCheckedAt = authorityNow().toISOString();
      options.authorityMetrics?.recordAuthorityLookupLatency(Date.now() - startedAt, { outcome: "unknown" });
      options.authorityMetrics?.recordAuthorityLookupFailure(reason);
      options.logger?.info(`engine job ${job.id} grounding authority unknown: ${reason}`);
      const stamped: EngineReviewResult = {
        ...assembled,
        metadata: {
          ...assembled.metadata,
          groundingAuthority: unknownAuthorityProvenance(
            lastKnown ?? publication ?? grounding.initial,
            publicationCheckedAt,
            reason,
          ),
        },
      };
      return enforceGroundingAuthority(stamped, { status: "unknown" });
    }
  };
  /**
   * Everything that has to be true of the bytes before they become the
   * published result, in the order the facts become knowable.
   *
   * Grounding authority first, because it can still suppress the grade and add
   * to `notReviewed`, and the provenance stamp has to describe the result that
   * is actually published. Evidence next: the projection wrote durable object
   * keys and this is where they become links, at publication time so the TTL is
   * spent by a reader rather than by the deep pass. The stamp last, then both
   * guards, so a path that ever skips a step fails the attempt instead of
   * publishing a grade of unknown origin or evidence that opens nothing.
   */
  const beforePublish = async (job: JobRecord, assembled: EngineReviewResult): Promise<EngineReviewResult> => {
    const grounded = await applyGroundingAuthority(job, assembled);
    const evidenced = await signEvidenceUrls(grounded, (objectKey) =>
      options.objectStore.signedGetUrl(objectKey, evidenceUrlTtlSeconds),
    );
    const witness = witnessByJob.get(job.id);
    if (!witness) {
      // Unreachable by construction: the deps provider records the witness
      // before the orchestrator runs, and nothing reaches publication without
      // it. Fail closed anyway, because the alternative to knowing is guessing.
      throw new UnattestedResultError(
        `job ${job.id} reached publication with no record of what its model calls did; refusing to attest`,
      );
    }
    return assertEvidenceResolvable(
      assertAttested(stampJudgmentProvenance(evidenced, witness.provenance())),
    );
  };
  const api = createJobApi({
    store: options.store,
    objectStore: options.objectStore,
    secret: options.engineHmacSecret,
    processor,
    beforePublish,
    coordinator,
  });
  const worker = new EngineWorker({
    store: options.store,
    processJob: api.processJob,
    ...(options.notificationSource ? { notificationSource: options.notificationSource } : {}),
    ...(options.workerPollMs !== undefined ? { pollIntervalMs: options.workerPollMs } : {}),
    ...(options.workerMaxAttempts !== undefined ? { maxAttempts: options.workerMaxAttempts } : {}),
    ...(options.workerLeaseMs !== undefined ? { leaseTtlMs: options.workerLeaseMs } : {}),
    ...(options.jobMaxAttemptMs !== undefined ? { maxAttemptMs: options.jobMaxAttemptMs } : {}),
    // Lease lost mid-attempt (#166): abort the local inference stream + capture
    // sandbox so the fenced-out attempt stops burning compute.
    onLeaseLost: (jobId) => {
      void coordinator.cancel(jobId);
    },
    // Recovered a lost worker's attempt: best-effort stop of its capture job.
    onRecovered: (job) => {
      void options.capture.cancel(job.id).catch(() => undefined);
    },
    finalizeCancellation: async (jobId, claimGeneration) => {
      await options.store.markCanceled(jobId, claimGeneration);
    },
    onJobSettled: (jobId) => {
      coordinator.release(jobId);
      groundingByJob.delete(jobId);
      witnessByJob.delete(jobId);
    },
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const server = new EngineHttpServer({
    handle: api.handle,
    readiness: {
      database: options.databaseReady,
      capture: () => options.capture.ready(),
      worker: () => worker.isReady(),
    },
  });
  return {
    server,
    worker,
    async start(port, host) {
      try {
        await worker.start();
        return await server.listen(port, host);
      } catch (error) {
        await worker.stop();
        throw error;
      }
    },
    async stop() {
      await server.close();
      await worker.stop();
    },
  };
}

export interface ProductionRuntime {
  runtime: EngineRuntime;
  config: RuntimeConfig;
  telemetry: Telemetry;
  pool: Pool;
  start(): Promise<number>;
  stop(): Promise<void>;
}

/** Bind all production adapters. Missing dependencies fail before a port is opened. */
export async function buildProductionRuntime(env: NodeJS.ProcessEnv = process.env): Promise<ProductionRuntime> {
  const config = await loadRuntimeConfig(new EnvSecretStore(env), env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  const store = new JobStore(pgExecutor(pool));
  const calibrationRegistry = new ModelPromptRegistry(pgExecutor(pool));
  const s3 = new S3Client({
    region: config.objectStoreRegion,
    ...(config.objectStoreEndpoint ? { endpoint: config.objectStoreEndpoint } : {}),
    credentials: {
      accessKeyId: config.objectStoreAccessKeyId,
      secretAccessKey: config.objectStoreSecretAccessKey,
    },
  });
  const objectStore = new S3ObjectStore(s3, config.objectStoreBucket);
  const capture = new HttpCaptureClient(config.captureEndpoint, config.captureToken);
  const openai = createOpenAIAdapters({
    apiKey: config.modelApiKey,
    baseURL: config.modelBaseUrl,
    objectStore,
    ...(config.embeddingModel ? { embeddingModel: config.embeddingModel } : {}),
  });
  const genomeResolver = config.genomeEndpoint && config.genomeToken
    ? new HttpGenomeResolver(config.genomeEndpoint, config.genomeToken, fetch, config.authorityTimeoutMs)
    : undefined;
  const telemetry = initTelemetry({ serviceName: "judgment-engine", serviceVersion: "0.0.0" });
  const engineMetrics = new EngineMetrics(telemetry.meterProvider.getMeter(METER_NAME));
  const runtime = createEngineRuntime({
    store,
    objectStore,
    engineHmacSecret: config.engineHmacSecret,
    capture,
    modelFactory: openai.modelFactory,
    passModels: config.passModels,
    calibrationResolver: calibrationRegistry,
    ...(genomeResolver ? { genomeResolver } : {}),
    ...(genomeResolver ? { groundingAuthority: genomeResolver } : {}),
    authorityMaxAgeMs: config.authorityMaxAgeMs,
    authorityMetrics: engineMetrics,
    reviewMetrics: engineMetrics,
    ...(openai.embedder ? { embedder: openai.embedder } : {}),
    evidenceUrlTtlSeconds: config.evidenceUrlTtlSeconds,
    notificationSource: new PgNotificationSource(config.databaseUrl),
    databaseReady: async () => {
      await pool.query("SELECT 1");
      return true;
    },
    workerPollMs: config.workerPollMs,
    workerMaxAttempts: config.workerMaxAttempts,
    workerLeaseMs: config.workerLeaseMs,
    jobMaxAttemptMs: config.jobMaxAttemptMs,
    logger: console,
  });
  return {
    runtime,
    config,
    telemetry,
    pool,
    start: () => runtime.start(config.port),
    async stop() {
      await runtime.stop();
      await Promise.all([pool.end(), telemetry.shutdown()]);
    },
  };
}
