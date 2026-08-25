import type { ModelBackend } from "./model.js";

/**
 * Per-backend endpoint capability profile (#27/#76).
 *
 * The engine talks to several OpenAI-compatible endpoints, and they do NOT agree
 * on the extension knobs. Treating them as one shape is what discarded a full,
 * correct pass in the field: `enable_thinking` is a DashScope-only `extra_body`
 * key; ollama silently ignores it, so a coercion step meant to run WITHOUT
 * reasoning kept reasoning, burned its whole context window, and returned `{}`.
 * The reasoning delta field disagrees too — DashScope streams `reasoning_content`
 * while ollama/vLLM/OpenRouter stream `reasoning`, so a client that reads only
 * one gets an empty reasoning block off every other endpoint.
 *
 * This profile is the single place those differences live. It controls:
 *   - whether the DashScope-only `enable_thinking` extra may be sent,
 *   - whether the per-tile `max_pixels` extra may be sent,
 *   - which single-call structured-output mode the endpoint supports, and
 *   - (documentation) which reasoning delta field the endpoint streams.
 *
 * The client tolerates BOTH reasoning fields regardless, so a mislabeled backend
 * still captures reasoning; `reasoningDeltaField` records the expected one.
 *
 * An unrecognized backend gets `CONSERVATIVE_PROFILE`: no vendor-specific keys,
 * the two-step coercion path, both reasoning fields read. Adding a new endpoint
 * is a one-line entry here, never a change at a call site.
 */
export interface EndpointProfile {
  /** May the DashScope-only `enable_thinking` extra_body key be sent? */
  sendEnableThinking: boolean;
  /** May the per-tile Qwen3-VL `max_pixels` extra_body key be sent? */
  sendMaxPixels: boolean;
  /**
   * Single-call structured-output capability:
   *   - `json_schema`: guided decoding — combine Thinking + a strict schema in ONE
   *     call, so the two-step is unnecessary (the default where supported).
   *   - `json_object`: JSON is guaranteed but not the schema; needs the two-step
   *     coercion + Zod validator.
   *   - `none`: no structured-output support; two-step coercion, lean on salvage.
   */
  structuredOutput: "json_schema" | "json_object" | "none";
  /** Reasoning delta field this endpoint is expected to stream (both are read). */
  reasoningDeltaField: "reasoning_content" | "reasoning";
  /**
   * Whether the endpoint reuses an IMPLICIT prompt-prefix cache across calls
   * (DashScope context cache, vLLM/SGLang automatic prefix caching, ollama's
   * prompt cache) — G4/#34. These backends need no per-call cache_control knob: the
   * cacheable unit is the byte-identical PREFIX, and the "hint" is emitting it
   * strictly first with no interpolation (which `invariantPromptPrefix` guarantees).
   * A cache HIT is observed back on `ModelUsage.cachedTokens`. A backend whose
   * caching is unknown (a proxy) is marked false so we never REPORT a saving the
   * endpoint may not deliver; correctness is identical either way.
   */
  implicitPromptCache: boolean;
  /**
   * The endpoint's typical advertised context window in tokens (C2). This is what
   * the deep-pass context-window preflight estimates the prompt + reserved
   * completion against, so the geometry map is degraded deterministically (or the
   * run fails loudly) rather than the endpoint silently context-shifting it out
   * mid-generation. It is a DEFAULT for the backend, overridable per run by
   * `MODEL_CONTEXT_WINDOW` (a deployment that serves a smaller/larger window says
   * so there). The recommended local tag is `qwen3vl-32k` (32768); the 12k tag
   * overflows the unlocked prompt, which is exactly the run the preflight catches.
   */
  contextWindowTokens: number;
}

/** The Qwen3-VL served context this project standardises on (the `qwen3vl-32k` tag). */
const QWEN3VL_32K = 32_768;

/** No vendor-specific keys; two-step coercion; both reasoning fields read. */
export const CONSERVATIVE_PROFILE: EndpointProfile = {
  sendEnableThinking: false,
  sendMaxPixels: false,
  structuredOutput: "json_object",
  reasoningDeltaField: "reasoning",
  implicitPromptCache: false,
  contextWindowTokens: QWEN3VL_32K,
};

const PROFILES: Record<Exclude<ModelBackend, "mock">, EndpointProfile> = {
  // DashScope compatible-mode: the only endpoint that reads `enable_thinking` and
  // `max_pixels`, and the one that cannot combine Thinking with a strict schema
  // (research note 2026-06-18), so it stays on the json_object two-step.
  dashscope: {
    sendEnableThinking: true,
    sendMaxPixels: true,
    structuredOutput: "json_object",
    reasoningDeltaField: "reasoning_content",
    implicitPromptCache: true,
    contextWindowTokens: QWEN3VL_32K,
  },
  // vLLM / SGLang self-host: guided decoding (xgrammar/outlines) does Thinking +
  // json_schema in ONE call, and accepts the Qwen `max_pixels` extra.
  vllm: {
    sendEnableThinking: false,
    sendMaxPixels: true,
    structuredOutput: "json_schema",
    reasoningDeltaField: "reasoning",
    implicitPromptCache: true,
    contextWindowTokens: QWEN3VL_32K,
  },
  // Historical alias for a vLLM/SGLang guided-decoding endpoint.
  "self-host": {
    sendEnableThinking: false,
    sendMaxPixels: true,
    structuredOutput: "json_schema",
    reasoningDeltaField: "reasoning",
    implicitPromptCache: true,
    contextWindowTokens: QWEN3VL_32K,
  },
  // OpenAI: Structured Outputs (json_schema) in one call; no DashScope extras.
  openai: {
    sendEnableThinking: false,
    sendMaxPixels: false,
    structuredOutput: "json_schema",
    reasoningDeltaField: "reasoning",
    implicitPromptCache: true,
    contextWindowTokens: 128_000,
  },
  // Ollama OpenAI-compatible mode: supports a json_schema `response_format` for
  // single-call structured output; ignores DashScope extras (which is exactly
  // what broke the two-step here), and streams `reasoning`. The recommended tag
  // is `qwen3vl-32k`; the `qwen3vl-12k` tag overflows the unlocked prompt (set
  // `MODEL_CONTEXT_WINDOW=12288` there so the preflight degrades instead of
  // silently context-shifting).
  ollama: {
    sendEnableThinking: false,
    sendMaxPixels: false,
    structuredOutput: "json_schema",
    reasoningDeltaField: "reasoning",
    implicitPromptCache: true,
    contextWindowTokens: QWEN3VL_32K,
  },
  // OpenRouter proxies many models with uneven structured-output support, so it
  // stays on the conservative two-step and leans on the salvage path.
  openrouter: {
    sendEnableThinking: false,
    sendMaxPixels: false,
    structuredOutput: "json_object",
    reasoningDeltaField: "reasoning",
    implicitPromptCache: false,
    contextWindowTokens: QWEN3VL_32K,
  },
};

/** The capability profile for a backend; unrecognized backends get conservative. */
export function endpointProfile(backend: ModelBackend): EndpointProfile {
  if (backend === "mock") return CONSERVATIVE_PROFILE;
  return PROFILES[backend] ?? CONSERVATIVE_PROFILE;
}

/**
 * The deep-pass context window a backend's preflight should use (C2): the explicit
 * `MODEL_CONTEXT_WINDOW` override when a deployment sets a positive integer there,
 * otherwise the backend profile's default. This is the single place the CLI, the
 * local server and the runtime worker resolve the window from, so the preflight
 * runs with the same number on every surface — and actually runs at all, closing
 * the gap where `contextWindow` was dead code and the preflight never fired on a
 * real run. A non-numeric / non-positive override is ignored (falls back to the
 * profile default) rather than disabling the preflight.
 */
export function resolveContextWindowTokens(
  backend: ModelBackend,
  env: Record<string, string | undefined> = {},
): number {
  const raw = (env.MODEL_CONTEXT_WINDOW ?? "").trim();
  if (raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return endpointProfile(backend).contextWindowTokens;
}

/**
 * Whether a backend's deep pass should run as ONE guided-decoding call instead of
 * the DashScope two-step. This is the single source of truth every surface (CLI,
 * local server, runtime worker) resolves the deep-pass path from, so the same
 * `MODEL_BACKEND` produces the same path everywhere.
 */
export function backendUsesGuidedDecoding(backend: ModelBackend): boolean {
  return endpointProfile(backend).structuredOutput === "json_schema";
}
