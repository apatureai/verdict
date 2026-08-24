import type { SecretStore } from "@apatureai/verdict-secrets";
import type { PassModelOverrides } from "@apatureai/verdict-critique";

export interface RuntimeConfig {
  port: number;
  databaseUrl: string;
  engineHmacSecret: string;
  modelApiKey: string;
  modelBaseUrl: string;
  passModels: PassModelOverrides;
  embeddingModel?: string;
  captureEndpoint: string;
  captureToken: string;
  genomeEndpoint?: string;
  genomeToken?: string;
  /** Bounded Source of Truth publication recheck timeout (#175). */
  authorityTimeoutMs: number;
  /** Maximum accepted age of mirrored UI-DNA evidence (#175). */
  authorityMaxAgeMs: number;
  objectStoreBucket: string;
  objectStoreRegion: string;
  objectStoreEndpoint?: string;
  objectStoreAccessKeyId: string;
  objectStoreSecretAccessKey: string;
  /**
   * How long the evidence links in a published review stay openable. Default
   * one hour: long enough for a reviewer to click the link in a PR comment,
   * short enough that a leaked result document stops granting access.
   */
  evidenceUrlTtlSeconds: number;
  workerPollMs: number;
  workerMaxAttempts: number;
  /** Lease TTL per claimed attempt (#166); the worker heartbeats at a third of it. */
  workerLeaseMs: number;
  /** Hard per-attempt deadline independent of heartbeats (#166). */
  jobMaxAttemptMs: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing runtime configuration: ${key}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}

/** Fail-fast production configuration. No model/capture/stub fallback exists. */
export async function loadRuntimeConfig(
  secrets: SecretStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeConfig> {
  const [databaseUrl, engineHmacSecret, modelApiKey, objectStoreAccessKeyId, objectStoreSecretAccessKey] =
    await Promise.all([
      secrets.get("databaseUrl"),
      secrets.get("engineHmacSecret"),
      secrets.get("modelApiKey"),
      secrets.get("objectStoreAccessKeyId"),
      secrets.get("objectStoreSecretAccessKey"),
    ]);
  const genomeEndpoint = env.GENOME_ENDPOINT;
  const genomeToken = env.GENOME_API_TOKEN;
  const embeddingModel = env.EMBEDDING_MODEL;
  const genomeParts = [genomeEndpoint, genomeToken, embeddingModel].filter(Boolean).length;
  if (genomeParts !== 0 && genomeParts !== 3) {
    throw new Error("GENOME_ENDPOINT, GENOME_API_TOKEN, and EMBEDDING_MODEL must be configured together");
  }
  if (env.MODEL_BACKEND !== undefined && env.MODEL_BACKEND !== "dashscope" && env.MODEL_BACKEND !== "self-host") {
    throw new Error("MODEL_BACKEND must be dashscope or self-host");
  }
  return {
    port: positiveInt(env, "PORT", 8080),
    databaseUrl,
    engineHmacSecret,
    modelApiKey,
    modelBaseUrl: required(env, "MODEL_BASE_URL"),
    passModels: {
      triage: {
        model: env.TRIAGE_MODEL ?? "qwen3-vl-flash",
        backend: env.MODEL_BACKEND === "self-host" ? "self-host" : "dashscope",
        thinking: false,
      },
      deep: {
        model: env.DEEP_MODEL ?? "qwen3-vl-plus",
        backend: env.MODEL_BACKEND === "self-host" ? "self-host" : "dashscope",
        thinking: true,
      },
    },
    ...(embeddingModel ? { embeddingModel } : {}),
    captureEndpoint: required(env, "CAPTURE_ENDPOINT"),
    captureToken: required(env, "CAPTURE_API_TOKEN"),
    ...(genomeEndpoint ? { genomeEndpoint } : {}),
    ...(genomeToken ? { genomeToken } : {}),
    authorityTimeoutMs: positiveInt(env, "AUTHORITY_TIMEOUT_MS", 2_000),
    authorityMaxAgeMs: positiveInt(env, "AUTHORITY_MAX_AGE_MS", 60_000),
    objectStoreBucket: required(env, "OBJECT_STORE_BUCKET"),
    objectStoreRegion: env.OBJECT_STORE_REGION ?? "auto",
    ...(env.OBJECT_STORE_ENDPOINT ? { objectStoreEndpoint: env.OBJECT_STORE_ENDPOINT } : {}),
    objectStoreAccessKeyId,
    objectStoreSecretAccessKey,
    evidenceUrlTtlSeconds: positiveInt(env, "EVIDENCE_URL_TTL_SECONDS", 3_600),
    workerPollMs: positiveInt(env, "WORKER_POLL_MS", 5_000),
    workerMaxAttempts: positiveInt(env, "WORKER_MAX_ATTEMPTS", 3),
    workerLeaseMs: positiveInt(env, "WORKER_LEASE_MS", 60_000),
    // Default sits above Gate's 10-minute review deadline so the engine, not a
    // guess, decides when a hung capture/model attempt is abandoned (#166).
    jobMaxAttemptMs: positiveInt(env, "JOB_MAX_ATTEMPT_MS", 12 * 60_000),
  };
}
