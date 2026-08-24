import type { ChatChunk, ChatCompletionsCreate, ChatCreateParams } from "./dashscope.js";

/**
 * Dependency-free OpenAI-compatible transport for `DashScopeModelClient` (#27,
 * #76). `createOpenAICompatibleCreate` adapts the official OpenAI SDK; this is
 * the same seam implemented over `fetch` + SSE, so `@apatureai/verdict-critique` can talk to
 * a real endpoint (DashScope's compatible mode, a self-hosted vLLM/SGLang server,
 * or anything else exposing `POST {baseUrl}/chat/completions`) without taking an
 * SDK dependency.
 *
 * Everything DashScope carries in `extra_body` on the SDK path (`enable_thinking`
 * and the per-tier `max_pixels` budget, #69) is a top-level body field on the
 * raw HTTP path, which is what the service actually reads; `extra_body` is purely
 * an SDK affordance for forwarding unknown keys.
 *
 * `fetch` is injected so this is unit-tested against a fake SSE stream. NEVER
 * call a live model from a test.
 */

/** Trailing-slash-insensitive join of the endpoint base and a path. */
function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export interface HttpModelEndpoint {
  /** OpenAI-compatible base URL, e.g. `https://host/compatible-mode/v1`. */
  baseUrl: string;
  /** Bearer token sent as `authorization: Bearer <key>`. */
  apiKey: string;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Extra request headers (e.g. a gateway's tenant header). */
  headers?: Record<string, string>;
}

/** The request body sent to `/chat/completions` (extra_body flattened). */
export function toHttpChatBody(params: ChatCreateParams): Record<string, unknown> {
  const { enable_thinking, max_pixels, ...rest } = params;
  return {
    ...rest,
    ...(enable_thinking !== undefined ? { enable_thinking } : {}),
    ...(max_pixels !== undefined ? { max_pixels } : {}),
  };
}

/**
 * Parse one SSE `data:` payload into a chunk. Returns `null` for the terminal
 * `[DONE]` sentinel and for any payload that is not JSON (keep-alive comments,
 * vendor-specific noise): a malformed frame must never abort a live stream.
 */
export function parseSseData(payload: string): ChatChunk | null {
  const trimmed = payload.trim();
  if (trimmed.length === 0 || trimmed === "[DONE]") return null;
  try {
    return JSON.parse(trimmed) as ChatChunk;
  } catch {
    return null;
  }
}

/** Split an SSE event block into its concatenated `data:` payload. */
function dataPayload(event: string): string | null {
  const lines = event.split("\n").filter((line) => line.startsWith("data:"));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice("data:".length)).join("\n");
}

/**
 * Decode a byte stream of `text/event-stream` into chat chunks. Events are
 * separated by a blank line; the decoder buffers across chunk boundaries because
 * a single TCP read routinely splits an event in half.
 */
export async function* decodeSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatChunk, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF so the blank-line split is transport-independent.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = dataPayload(event);
        if (payload !== null) {
          const chunk = parseSseData(payload);
          if (chunk) yield chunk;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    // Flush a final event that arrived without its trailing blank line.
    const payload = dataPayload(buffer);
    if (payload !== null) {
      const chunk = parseSseData(payload);
      if (chunk) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Build the injectable streaming `create` for `DashScopeModelClient` against a
 * live OpenAI-compatible endpoint. The returned function performs one POST and
 * hands back the decoded chunk stream; the caller's AbortSignal cancels it.
 */
export function createHttpChatCompletionsCreate(endpoint: HttpModelEndpoint): ChatCompletionsCreate {
  const fetchImpl = endpoint.fetchImpl ?? fetch;
  return async (params, options) => {
    const response = await fetchImpl(endpointUrl(endpoint.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...endpoint.headers,
      },
      body: JSON.stringify(toHttpChatBody(params)),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      // Surface the endpoint's own error text. An auth or quota failure is the
      // single most common live-path problem and the body says which.
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `model endpoint ${endpointUrl(endpoint.baseUrl, "/chat/completions")} returned ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    if (!response.body) throw new Error("model endpoint returned no response body");
    return decodeSseStream(response.body);
  };
}
