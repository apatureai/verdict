import type { Viewport } from "@apatureai/verdict-types";

/**
 * Per-pass model abstraction (TRD §6/§7, #26). Every model backend sits behind
 * this one `ModelClient` interface: DashScope (v1), self-host vLLM (#76), a
 * fine-tuned checkpoint (#79), or a different VLM/Claude. A model swap is
 * therefore a config change with no call-site change in `critique()` or any
 * consumer.
 */
export type ModelBackend = "dashscope" | "self-host" | "mock";

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
