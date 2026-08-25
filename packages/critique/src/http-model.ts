import type { ChatChunk, ChatCompletionsCreate, ChatCreateParams } from "./dashscope.js";

/**
 * Dependency-free OpenAI-compatible transport for `DashScopeModelClient` (#27,
 * #76, W1-05). `createOpenAICompatibleCreate` adapts the official OpenAI SDK;
 * this is the same seam implemented over `fetch` + SSE, so
 * `@apatureai/verdict-critique` can talk to a real endpoint (DashScope's
 * compatible mode, a self-hosted vLLM/SGLang/ollama server, or anything else
 * exposing `POST {baseUrl}/chat/completions`) without taking an SDK dependency.
 *
 * Everything DashScope carries in `extra_body` on the SDK path (`enable_thinking`
 * and the per-tier `max_pixels` budget, #69) is a top-level body field on the
 * raw HTTP path, which is what the service actually reads; `extra_body` is purely
 * an SDK affordance for forwarding unknown keys.
 *
 * ## Resilience (W1-05)
 *
 * The bare `fetch` this used to be silently inherited undici's 300s
 * headers/body timeouts and had no retry, so a self-hosted qwen3-vl endpoint
 * that took minutes to answer surfaced as a hard `TypeError: fetch failed` and
 * the whole (already-captured) review was thrown away. This transport now owns
 * its timeouts and retries explicitly:
 *
 * - an explicit **connect/headers** timeout (abort if the response headers do
 *   not arrive in time) and an optional **idle** timeout (abort if the stream
 *   stalls between chunks) — both driven by an `AbortController` we control, so
 *   they are configurable per request rather than inherited from the runtime;
 * - **retry** with exponential backoff + full jitter on transport failures and
 *   retryable status codes (408/425/429/5xx), bounded by a max-attempt count and
 *   an optional total-time budget, honouring a `Retry-After` header when present;
 * - the caller's own `AbortSignal` (supersession, #66) is never retried — it is
 *   an intentional cancel and propagates immediately.
 *
 * Raising the ceiling ABOVE undici's inherited 300s (rather than aborting sooner)
 * needs a dispatcher, so an optional `dispatcher` is passed straight through to
 * `fetch`; when a caller supplies a configured undici `Agent`, its
 * connect/headers/body timeouts govern and ours become the outer bound.
 *
 * `fetch` is injected so this is unit-tested against a fake SSE stream. NEVER
 * call a live model from a test.
 */

/** Trailing-slash-insensitive join of the endpoint base and a path. */
function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** A timeout this transport raised itself (connect/headers, idle, or total). */
export class ModelTimeoutError extends Error {
  constructor(
    readonly phase: "connect" | "idle" | "total",
    timeoutMs: number,
  ) {
    super(`model endpoint ${phase} timeout after ${timeoutMs}ms`);
    this.name = "ModelTimeoutError";
  }
}

/** Explicit, owned request timeouts. `0` (or undefined) disables a phase. */
export interface HttpTimeoutConfig {
  /** Abort if response headers have not arrived within this many ms. */
  connectTimeoutMs?: number;
  /** Abort if no stream chunk arrives within this many ms (idle gap). */
  idleTimeoutMs?: number;
  /** Abort the whole call, retries included, after this many ms. */
  totalTimeoutMs?: number;
}

/** Bounded retry policy for transient failures. */
export interface HttpRetryConfig {
  /** Total attempts including the first (>=1). 1 disables retries. */
  maxAttempts?: number;
  /** Backoff base in ms for the first retry. */
  baseDelayMs?: number;
  /** Cap on a single jittered backoff delay in ms. */
  maxDelayMs?: number;
}

const DEFAULT_TIMEOUTS: Required<HttpTimeoutConfig> = {
  // Headers arrive as soon as the server starts the SSE response, well before
  // the (possibly minutes-long) generation, so a generous connect bound is safe.
  connectTimeoutMs: 120_000,
  // Off by default: a reasoning model streams tokens continuously but can pause,
  // and undici already caps a truly idle body at 300s. Opt in to tighten.
  idleTimeoutMs: 0,
  // Off by default: a full-page critique legitimately runs for many minutes.
  totalTimeoutMs: 0,
};

const DEFAULT_RETRY: Required<HttpRetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/** Structured diagnostics emitted before/around a call (default: discarded). */
export type HttpModelLog =
  | { kind: "request"; url: string; images: number; imageTokenEstimate: number }
  | { kind: "retry"; url: string; attempt: number; delayMs: number; reason: string };

export interface HttpModelEndpoint {
  /** OpenAI-compatible base URL, e.g. `https://host/compatible-mode/v1`. */
  baseUrl: string;
  /** Bearer token sent as `authorization: Bearer <key>`. */
  apiKey: string;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Extra request headers (e.g. a gateway's tenant header). */
  headers?: Record<string, string>;
  /** Explicit connect/idle/total timeouts (owned, not inherited). */
  timeouts?: HttpTimeoutConfig;
  /** Bounded retry policy for transient failures. */
  retry?: HttpRetryConfig;
  /**
   * Optional undici `Agent`/dispatcher passed through to `fetch` so a caller can
   * raise Node's inherited connect/headers/body ceilings. Typed loosely to avoid
   * an undici type dependency in this dependency-free transport.
   */
  dispatcher?: unknown;
  /** Structured log sink; defaults to a no-op. */
  log?: (event: HttpModelLog) => void;
  /** Injected clock (ms); defaults to `Date.now`. Tests use a fake clock. */
  now?: () => number;
  /** Injected [0,1) source; defaults to `Math.random`. Tests pin jitter. */
  random?: () => number;
  /** Injected abortable sleep; defaults to a real timer. Tests skip real waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

/** Options for the SSE decoder. */
export interface DecodeSseOptions {
  /** Abort the read if no chunk arrives within this many ms (0 disables). */
  idleTimeoutMs?: number;
  /** Called when the idle timeout fires, before the generator throws. */
  onIdleTimeout?: () => void;
}

/** Race a promise against an idle timer; rejects with `ModelTimeoutError` on lapse. */
function withIdleTimeout<T>(
  promise: Promise<T>,
  idleTimeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  if (idleTimeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new ModelTimeoutError("idle", idleTimeoutMs));
    }, idleTimeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Decode a byte stream of `text/event-stream` into chat chunks. Events are
 * separated by a blank line; the decoder buffers across chunk boundaries because
 * a single TCP read routinely splits an event in half.
 *
 * An optional idle timeout aborts a stalled stream instead of hanging forever;
 * `onIdleTimeout` lets the caller also abort the underlying request.
 */
export async function* decodeSseStream(
  body: ReadableStream<Uint8Array>,
  options: DecodeSseOptions = {},
): AsyncGenerator<ChatChunk, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  const onIdleTimeout = () => {
    reader.cancel().catch(() => {});
    options.onIdleTimeout?.();
  };
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await withIdleTimeout(reader.read(), idleTimeoutMs, onIdleTimeout);
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

/** Status codes worth retrying: request timeout, too-early, rate limit, and 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Parse a `Retry-After` header into milliseconds. Accepts delta-seconds
 * (`"120"`) and an HTTP-date; returns `null` for a missing/unparseable value.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Full-jitter exponential backoff: uniform in `[0, min(cap, base·2^(n-1)))`. */
export function backoffDelayMs(
  retryNumber: number,
  base: number,
  cap: number,
  random: () => number,
): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, retryNumber - 1));
  return Math.floor(random() * ceiling);
}

/** Real abortable sleep; rejects promptly if the signal aborts first. */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Qwen3-VL merges 2×2 patches of 14px → ~one token per 28×28px block. */
export function estimateQwenImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / (28 * 28));
}

/** Read `width`/`height` from a base64 PNG `data:` URI's IHDR, else `null`. */
export function pngDimensionsFromDataUrl(url: string): { width: number; height: number } | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) return null;
  let header: Buffer;
  try {
    // The 8-byte signature + 25-byte IHDR chunk live in the first 33 bytes;
    // decode a small prefix rather than the whole (multi-MB) screenshot.
    header = Buffer.from((match[1] as string).slice(0, 64), "base64");
  } catch {
    return null;
  }
  // PNG signature then IHDR: width @ byte 16, height @ byte 20 (big-endian u32).
  if (header.length < 24 || header.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** Rough Qwen3-VL image-token estimate summed over a request's PNG data-URIs. */
function estimateImageTokensFromMessages(messages: unknown[]): { images: number; tokens: number } {
  let images = 0;
  let tokens = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
      if (typeof url !== "string") continue;
      images += 1;
      const dims = pngDimensionsFromDataUrl(url);
      if (dims) tokens += estimateQwenImageTokens(dims.width, dims.height);
    }
  }
  return { images, tokens };
}

/**
 * Build the injectable streaming `create` for `DashScopeModelClient` against a
 * live OpenAI-compatible endpoint. The returned function performs one POST per
 * attempt and hands back the decoded chunk stream; the caller's AbortSignal
 * cancels it, and transient failures are retried within the configured budget.
 */
export function createHttpChatCompletionsCreate(endpoint: HttpModelEndpoint): ChatCompletionsCreate {
  const fetchImpl = endpoint.fetchImpl ?? fetch;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...endpoint.timeouts };
  const retry = { ...DEFAULT_RETRY, ...endpoint.retry };
  const now = endpoint.now ?? Date.now;
  const random = endpoint.random ?? Math.random;
  const sleep = endpoint.sleep ?? realSleep;
  const log = endpoint.log ?? (() => {});
  const url = endpointUrl(endpoint.baseUrl, "/chat/completions");
  const maxAttempts = Math.max(1, retry.maxAttempts);

  return async (params, options) => {
    const callerSignal = options.signal;
    const startedAt = now();
    const body = JSON.stringify(toHttpChatBody(params));

    const estimate = estimateImageTokensFromMessages(params.messages);
    log({ kind: "request", url, images: estimate.images, imageTokenEstimate: estimate.tokens });

    const deadlineExceeded = () =>
      timeouts.totalTimeoutMs > 0 && now() - startedAt >= timeouts.totalTimeoutMs;

    /**
     * Decide whether to retry `attempt` and, if so, sleep the backoff and return
     * the delay used; return `null` to stop (budget/attempts exhausted).
     */
    const scheduleRetry = async (attempt: number, retryAfterMs: number | null): Promise<number | null> => {
      if (attempt >= maxAttempts) return null;
      if (deadlineExceeded()) return null;
      const jittered = backoffDelayMs(attempt, retry.baseDelayMs, retry.maxDelayMs, random);
      let delay = retryAfterMs !== null ? Math.max(retryAfterMs, jittered) : jittered;
      if (timeouts.totalTimeoutMs > 0) {
        const remaining = timeouts.totalTimeoutMs - (now() - startedAt);
        if (remaining <= 0) return null;
        delay = Math.min(delay, remaining);
      }
      try {
        await sleep(delay, callerSignal);
      } catch {
        return null; // caller aborted during backoff
      }
      return delay;
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (callerSignal?.aborted) {
        throw callerSignal.reason instanceof Error ? callerSignal.reason : new Error("aborted");
      }

      // One controller per attempt: the caller's signal, the connect timeout,
      // and a later idle timeout all abort THIS attempt's request.
      const controller = new AbortController();
      const abort = (reason: unknown) => controller.abort(reason);
      const onCallerAbort = () => abort(callerSignal?.reason);
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      const connectTimer =
        timeouts.connectTimeoutMs > 0
          ? setTimeout(() => abort(new ModelTimeoutError("connect", timeouts.connectTimeoutMs)), timeouts.connectTimeoutMs)
          : undefined;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${endpoint.apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            ...endpoint.headers,
          },
          body,
          signal: controller.signal,
          ...(endpoint.dispatcher ? { dispatcher: endpoint.dispatcher } : {}),
        } as RequestInit);
      } catch (error) {
        if (connectTimer) clearTimeout(connectTimer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        // A caller-initiated cancel is intentional: propagate, never retry.
        if (callerSignal?.aborted) {
          throw callerSignal.reason instanceof Error ? callerSignal.reason : new Error("aborted");
        }
        lastError = error;
        const delay = await scheduleRetry(attempt, null);
        if (delay === null) throw error;
        log({ kind: "retry", url, attempt, delayMs: delay, reason: describeError(error) });
        continue;
      }

      // Headers are in: the connect timeout is satisfied.
      if (connectTimer) clearTimeout(connectTimer);

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 500);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        if (isRetryableStatus(response.status)) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
          lastError = new Error(`model endpoint ${url} returned ${response.status}`);
          const delay = await scheduleRetry(attempt, retryAfterMs);
          if (delay !== null) {
            log({ kind: "retry", url, attempt, delayMs: delay, reason: `status ${response.status}` });
            continue;
          }
        }
        throw new Error(
          `model endpoint ${url} returned ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }

      if (!response.body) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        throw new Error("model endpoint returned no response body");
      }

      // Success. From here we are streaming; a mid-stream failure cannot be
      // retried (bytes already delivered), so it surfaces to the caller. The
      // idle timeout bounds a stall by aborting this attempt's controller.
      return decodeSseStream(response.body, {
        idleTimeoutMs: timeouts.idleTimeoutMs,
        onIdleTimeout: () => abort(new ModelTimeoutError("idle", timeouts.idleTimeoutMs)),
      });
    }

    // Exhausted attempts.
    throw lastError instanceof Error ? lastError : new Error(`model endpoint ${url} failed`);
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name}: ${code}` : error.message;
  }
  return String(error);
}
