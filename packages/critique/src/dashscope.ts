import { endpointProfile } from "./endpoint-profile.js";
import type {
  ModelBackend,
  ModelCallOptions,
  ModelClient,
  ModelImage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
} from "./model.js";

/**
 * DashScope model client (TRD §6.1/§6.5, #27). Streams against the DashScope
 * OpenAI-compatible endpoint (the OpenAI SDK shape, never `@anthropic-ai/sdk`),
 * selects the Thinking checkpoint for the deep pass (reasoning on, temp ~0.6),
 * splits the reasoning stream (`reasoning_content`) from the answer, and threads
 * an AbortSignal into every call. The exact same client serves self-host
 * vLLM/SGLang by pointing the create fn at that endpoint (#76).
 *
 * The streaming `create` is injected so the client is unit-tested against a fake
 * stream, NEVER a live model. `createOpenAICompatibleCreate` adapts a real
 * OpenAI-SDK client in production.
 */

/** One streamed chunk in the OpenAI chat-completions shape. */
export interface ChatChunk {
  choices: Array<{
    // qwen3-vl and several OpenAI-compatible self-host servers stream it as
    // `reasoning` (W1-05). Accept either so the deep pass never silently loses
    // the whole chain-of-thought against a self-hosted endpoint.
    delta: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

export interface ChatCreateParams {
  model: string;
  messages: unknown[];
  stream: true;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  response_format?:
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };
  /** DashScope passes `enable_thinking` via extra_body on the OpenAI-compatible path. */
  enable_thinking?: boolean;
  /** Per-tile Qwen3-VL image-token budget (#69); forwarded via extra_body. */
  max_pixels?: number;
  /** Hard output-token cap; set only on the bounded repair re-ask. */
  max_tokens?: number;
}

/** OpenAI-compatible streaming create (chat.completions.create with stream:true). */
export type ChatCompletionsCreate = (
  params: ChatCreateParams,
  options: { signal?: AbortSignal },
) => Promise<AsyncIterable<ChatChunk>>;

/** Resolve an object-storage key to a (signed) URL the model can fetch (#6). */
export type ImageUrlResolver = (image: ModelImage) => string | Promise<string>;

export interface DashScopeOptions {
  /** Temperature for the Thinking/deep pass. */
  thinkingTemperature?: number;
  resolveImageUrl?: ImageUrlResolver;
}

async function toOpenAIMessages(messages: ModelMessage[], resolveUrl: ImageUrlResolver): Promise<unknown[]> {
  return Promise.all(messages.map(async (m) => {
    if (!m.images || m.images.length === 0) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content },
        ...await Promise.all(
          m.images.map(async (img) => ({
            type: "image_url",
            image_url: { url: await resolveUrl(img) },
          })),
        ),
      ],
    };
  }));
}

export class DashScopeModelClient implements ModelClient {
  readonly backend: ModelBackend;
  private readonly resolveUrl: ImageUrlResolver;
  private readonly thinkingTemperature: number;

  constructor(
    private readonly create: ChatCompletionsCreate,
    options: DashScopeOptions = {},
    backend: ModelBackend = "dashscope",
  ) {
    this.backend = backend;
    this.resolveUrl = options.resolveImageUrl ?? ((img) => img.objectKey);
    this.thinkingTemperature = options.thinkingTemperature ?? 0.6;
  }

  /** Resolve the OpenAI-compatible `response_format` for a request. */
  private resolveResponseFormat(request: ModelRequest): ChatCreateParams["response_format"] {
    if (request.responseFormat === "json_schema" && request.jsonSchema) {
      return { type: "json_schema", json_schema: { name: "critique", schema: request.jsonSchema, strict: true } };
    }
    if (request.responseFormat === "json_object" && !request.thinking) {
      return { type: "json_object" };
    }
    return undefined;
  }

  async complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse> {
    // Thinking and json_object are mutually exclusive (#29 two-step); only set
    // json_object on the non-thinking coercion call. json_schema (self-host vLLM
    // guided decoding, #76) CAN combine with thinking, so it is not gated on it.
    const responseFormat = this.resolveResponseFormat(request);
    // The endpoint capability profile gates the DashScope-only extras. Sending
    // `enable_thinking` to an endpoint that ignores it (ollama) is the exact bug
    // that let a "non-thinking" coercion keep reasoning and never emit JSON, so a
    // non-DashScope endpoint never receives it.
    const profile = endpointProfile(this.backend);
    const stream = await this.create(
      {
        model: request.model,
        messages: await toOpenAIMessages(request.messages, this.resolveUrl),
        stream: true,
        stream_options: { include_usage: true },
        temperature: request.thinking ? this.thinkingTemperature : undefined,
        ...(profile.sendEnableThinking ? { enable_thinking: request.thinking } : {}),
        ...(profile.sendMaxPixels && request.maxPixels !== undefined ? { max_pixels: request.maxPixels } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        response_format: responseFormat,
      },
      { signal: options?.signal },
    );

    let content = "";
    let thinking = "";
    let finishReason = "stop";
    let usage: ChatChunk["usage"];
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const reasoningDelta = choice?.delta.reasoning_content ?? choice?.delta.reasoning;
      if (reasoningDelta) thinking += reasoningDelta;
      if (choice?.delta.content) content += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }

    return {
      text: content,
      thinkingText: thinking || undefined,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      finishReason,
    };
  }
}

/** Minimal OpenAI-SDK surface used in production (kept dependency-light + testable). */
export interface OpenAILikeClient {
  chat: {
    completions: {
      create(params: ChatCreateParams, options: { signal?: AbortSignal }): Promise<AsyncIterable<ChatChunk>>;
    };
  };
}

/**
 * Adapt a real OpenAI-SDK client (constructed with the DashScope `baseURL` +
 * api key, or a self-host vLLM URL) into the injectable create fn. DashScope's
 * `enable_thinking` rides in `extra_body`.
 */
export function createOpenAICompatibleCreate(client: OpenAILikeClient): ChatCompletionsCreate {
  return (params, options) => {
    const { enable_thinking, max_pixels, ...rest } = params;
    const extra: Record<string, unknown> = {};
    if (enable_thinking !== undefined) extra.enable_thinking = enable_thinking;
    if (max_pixels !== undefined) extra.max_pixels = max_pixels;
    const body = { ...rest, ...(Object.keys(extra).length > 0 ? { extra_body: extra } : {}) };
    return client.chat.completions.create(body as ChatCreateParams, options);
  };
}
