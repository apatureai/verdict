import type { PassModelOverrides } from "@apatureai/verdict-critique";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cannedModelFactory,
  defaultModelFactory,
  parseCannedScript,
  resolveModelRuntime,
  type ImageUrlResolver,
  type ModelClientFactory,
} from "@apatureai/verdict-critique";
import type { ModelChoice } from "./args.js";
import type { ReportModelKind } from "./report.js";

/**
 * Which critique client a local run uses, resolved in ONE place.
 *
 * Every local front door reads the same two variables and applies the same
 * `auto | mock | canned | live` rule, because the failure this guards against
 * is silent: the mock and canned clients produce a well-formed result with a
 * grade in it, and a caller that cannot tell which client ran cannot tell a
 * review from a fixture. So the resolution returns a `kind` alongside the
 * factory, and every caller is expected to state it: the CLI prints it in the
 * banner and refuses to print a grade, the HTTP server stamps it into the
 * payload as judgment provenance.
 */

/** Directory holding the bundled demo site and the canned script. */
export function fixturesDir(): string {
  return fileURLToPath(new URL("../fixtures/", import.meta.url));
}

export interface ResolvedLocalModel {
  factory: ModelClientFactory;
  /** One line naming the active client, for a banner or a log. */
  description: string;
  /** Only `live` means a model saw the page. */
  kind: ReportModelKind;
}

export interface ResolveLocalModelOptions {
  choice: ModelChoice;
  env: Record<string, string | undefined>;
  /**
   * Resolve a captured image's object key to something the model can fetch.
   * Locally there is no signed object-store URL to hand out, so this inlines the
   * bytes as a `data:` URI.
   */
  resolveImageUrl: ImageUrlResolver;
  /** Canned script path; defaults to the bundled one. */
  scriptPath?: string;
  /** Renders the script path for the description (the CLI shortens it). */
  displayPath?: (path: string) => string;
}

/**
 * `auto` means live when `MODEL_API_KEY` is set and canned when it is not. The
 * live path never guesses `MODEL_BASE_URL`; `resolveModelRuntime` throws when a
 * key is present without one.
 */
export async function resolveLocalModel(
  options: ResolveLocalModelOptions,
): Promise<ResolvedLocalModel> {
  const keyPresent = (options.env.MODEL_API_KEY ?? "").trim().length > 0;
  const choice = options.choice === "auto" ? (keyPresent ? "live" : "canned") : options.choice;

  if (choice === "live") {
    const runtime = resolveModelRuntime(options.env, { resolveImageUrl: options.resolveImageUrl });
    return { factory: runtime.factory, description: runtime.description, kind: "live" };
  }
  if (choice === "mock") {
    return {
      factory: defaultModelFactory,
      description: "MOCK model client — deterministic, empty critique. No network call.",
      kind: "mock",
    };
  }
  const scriptPath = options.scriptPath ?? join(fixturesDir(), "canned-critique.json");
  const parsed = parseCannedScript(JSON.parse(await readFile(scriptPath, "utf8")));
  if (!parsed.ok) throw new Error(`invalid canned script ${scriptPath}: ${parsed.error}`);
  const shown = options.displayPath ? options.displayPath(scriptPath) : scriptPath;
  return {
    factory: cannedModelFactory(parsed.script),
    description: `CANNED replay client — authored responses, not a live model (${shown})`,
    kind: "canned",
  };
}

/** Backends a local front door accepts in `MODEL_BACKEND` (unknown ⇒ ignored). */
const KNOWN_BACKENDS = ["dashscope", "self-host", "openai", "vllm", "ollama", "openrouter"] as const;
type KnownBackend = (typeof KNOWN_BACKENDS)[number];

/** Parse `MODEL_BACKEND`, or undefined when unset/blank/unrecognized. */
export function backendFromEnv(env: NodeJS.ProcessEnv = process.env): KnownBackend | undefined {
  const raw = (env.MODEL_BACKEND ?? "").trim();
  return (KNOWN_BACKENDS as readonly string[]).includes(raw) ? (raw as KnownBackend) : undefined;
}

/**
 * Per-pass model config from the environment, matching the names the deployable
 * runtime has always read: `TRIAGE_MODEL`, `DEEP_MODEL`, and `MODEL_BACKEND`.
 *
 * `MODEL_BASE_URL` lets a caller point at any OpenAI-compatible endpoint, but
 * until this existed the request still named the built-in Qwen ids, so the
 * documented quickstart only worked against an endpoint that happened to serve
 * `qwen3-vl-flash` and `qwen3-vl-plus`.
 *
 * `MODEL_BACKEND` is read HERE too, not only by `packages/runtime`. It sets the
 * per-pass `backend`, which is what selects the endpoint capability profile (so
 * DashScope-only knobs never reach ollama/vLLM) AND, downstream, the deep-pass
 * path (single guided call vs the two-step). Before this, `pnpm review` and the
 * local server always ran as `dashscope` regardless of the endpoint they were
 * pointed at. Returns undefined only when none of the three is set, so the
 * defaults stay exactly as they were.
 */
export function passModelsFromEnv(env: NodeJS.ProcessEnv = process.env): PassModelOverrides | undefined {
  const triage = (env.TRIAGE_MODEL ?? "").trim();
  const deep = (env.DEEP_MODEL ?? "").trim();
  const backend = backendFromEnv(env);
  if (triage.length === 0 && deep.length === 0 && backend === undefined) return undefined;
  const triageOverride = {
    ...(triage.length > 0 ? { model: triage } : {}),
    ...(backend ? { backend } : {}),
  };
  const deepOverride = {
    ...(deep.length > 0 ? { model: deep } : {}),
    ...(backend ? { backend } : {}),
  };
  return {
    ...(Object.keys(triageOverride).length > 0 ? { triage: triageOverride } : {}),
    ...(Object.keys(deepOverride).length > 0 ? { deep: deepOverride } : {}),
  };
}
