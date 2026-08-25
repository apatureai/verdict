import type { Viewport } from "@apatureai/verdict-types";

/**
 * Per-pass model abstraction (TRD §6/§7, #26). Every model backend sits behind
 * this one `ModelClient` interface: DashScope (v1), self-host vLLM (#76), a
 * fine-tuned checkpoint (#79), or a different VLM/Claude. A model swap is
 * therefore a config change with no call-site change in `critique()` or any
 * consumer.
 */
/**
 * Which endpoint the client is actually talking to. This is NOT decorative: an
 * endpoint capability profile (`endpoint-profile.ts`) keys off it to decide
 * whether DashScope-only knobs (`enable_thinking`, `max_pixels`) may be sent and
 * whether single-call structured output is available. A DashScope-only key sent
 * to a non-DashScope endpoint is the exact failure that discarded a full pass in
 * the field (ollama ignored `enable_thinking`, so the "non-thinking" coercion
 * step burned its context on reasoning and never emitted JSON).
 *
 * `self-host` is a historical alias for a vLLM/SGLang guided-decoding endpoint.
 * `mock` is the in-memory client. An unrecognized value gets the conservative
 * profile (no vendor-specific keys, two-step coercion, both reasoning fields).
 */
export type ModelBackend =
  | "dashscope"
  | "openai"
  | "vllm"
  | "ollama"
  | "openrouter"
  | "self-host"
  | "mock";

/** Reference to a captured, budget-fitted image sent to the model. */
export interface ModelImage {
  objectKey: string;
  route: string;
  viewport: Viewport;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: ModelImage[];
}

export interface ModelRequest {
  /** Resolved model id, e.g. "qwen3-vl-plus". */
  model: string;
  messages: ModelMessage[];
  /** Whether to run the Thinking pass (deep) vs non-thinking (triage/coercion). */
  thinking: boolean;
  /** Image-token budget enforced in the adapter (#69); undefined = backend default. */
  maxPixels?: number;
  /**
   * Output mode. `text` = prose Thinking critique; `json_object` = DashScope
   * coercion (#31, thinking ⊥ json so it rides the second step of the two-step);
   * `json_schema` = self-host vLLM guided decoding (#76), which CAN combine with
   * thinking in a single call.
   */
  responseFormat?: "text" | "json_object" | "json_schema";
  /** JSON Schema for `json_schema` guided decoding (self-host #76). */
  jsonSchema?: Record<string, unknown>;
  /**
   * Hard cap on generated tokens. Deliberately left unset on the normal Thinking
   * and coercion calls (a cap truncates a long-but-valid critique). It exists for
   * exactly one caller: the single bounded repair re-ask, which is fenced to a
   * fixed budget so a model that ignores the "answer only" instruction and starts
   * reasoning again cannot run away a second time.
   */
  maxTokens?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prefix-cache hit tokens (DashScope `prompt_tokens_details.cached_tokens`, #34). */
  cachedTokens: number;
}

export interface ModelResponse {
  text: string;
  /** The reasoning block when `thinking` was requested (split from `text`). */
  thinkingText?: string;
  usage: ModelUsage;
  finishReason: string;
}

/** Per-call options; an AbortSignal is threaded into every stream call (#27, supersession #66). */
export interface ModelCallOptions {
  signal?: AbortSignal;
}

/** The swappable model adapter. Implementations: MockModelClient (here), DashScope (#27), vLLM (#76). */
export interface ModelClient {
  readonly backend: ModelBackend;
  complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse>;
}
