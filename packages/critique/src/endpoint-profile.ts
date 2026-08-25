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
}

/** No vendor-specific keys; two-step coercion; both reasoning fields read. */
export const CONSERVATIVE_PROFILE: EndpointProfile = {
  sendEnableThinking: false,
  sendMaxPixels: false,
  structuredOutput: "json_object",
  reasoningDeltaField: "reasoning",
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
  },
  // vLLM / SGLang self-host: guided decoding (xgrammar/outlines) does Thinking +
  // json_schema in ONE call, and accepts the Qwen `max_pixels` extra.
  vllm: {
    sendEnableThinking: false,
    sendMaxPixels: true,
    structuredOutput: "json_schema",
    reasoningDeltaField: "reasoning",
  },
  // Historical alias for a vLLM/SGLang guided-decoding endpoint.
  "self-host": {
    sendEnableThinking: false,
    sendMaxPixels: true,
    structuredOutput: "json_schema",
    reasoningDeltaField: "reasoning",
  },
  // OpenAI: Structured Outputs (json_schema) in one call; no DashScope extras.
  openai: {
    sendEnableThinking: false,
    sendMaxPixels: false,
    structuredOutput: "json_schema",
    reasoningDeltaField: "reasoning",
  },
  // Ollama OpenAI-compatible mode: supports a json_schema `response_format` for
  // single-call structured output; ignores DashScope extras (which is exactly
  // what broke the two-step here), and streams `reasoning`.
  ollama: {
    sendEnableThinking: false,
    sendMaxPixels: false,
    structuredOutput: "json_schema",
    reasoningDeltaField: "reasoning",
  },
  // OpenRouter proxies many models with uneven structured-output support, so it
  // stays on the conservative two-step and leans on the salvage path.
  openrouter: {
    sendEnableThinking: false,
    sendMaxPixels: false,
    structuredOutput: "json_object",
    reasoningDeltaField: "reasoning",
  },
};

/** The capability profile for a backend; unrecognized backends get conservative. */
export function endpointProfile(backend: ModelBackend): EndpointProfile {
  if (backend === "mock") return CONSERVATIVE_PROFILE;
  return PROFILES[backend] ?? CONSERVATIVE_PROFILE;
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
