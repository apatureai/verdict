import { describe, expect, it, vi } from "vitest";
import {
  createHttpChatCompletionsCreate,
  decodeSseStream,
  DashScopeModelClient,
  parseSseData,
  toHttpChatBody,
  isRetryableStatus,
  parseRetryAfter,
  backoffDelayMs,
  estimateQwenImageTokens,
  pngDimensionsFromDataUrl,
  ModelTimeoutError,
  type ChatCreateParams,
  type HttpModelLog,
} from "../src/index.js";

/** Wrap SSE text in a byte stream, optionally split at arbitrary points. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const PARAMS: ChatCreateParams = {
  model: "qwen3-vl-plus",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  enable_thinking: true,
  max_pixels: 1024,
};

describe("toHttpChatBody", () => {
  it("sends enable_thinking and max_pixels as top-level fields, not extra_body", () => {
    const body = toHttpChatBody(PARAMS);
    expect(body).toMatchObject({ model: "qwen3-vl-plus", enable_thinking: true, max_pixels: 1024 });
    expect(body).not.toHaveProperty("extra_body");
  });

  it("omits the optional fields entirely when unset", () => {
    const body = toHttpChatBody({ model: "m", messages: [], stream: true });
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body).not.toHaveProperty("max_pixels");
  });
});

describe("parseSseData", () => {
  it("returns null for the terminal sentinel and for non-JSON noise", () => {
    expect(parseSseData("[DONE]")).toBeNull();
    expect(parseSseData("   ")).toBeNull();
    expect(parseSseData("not json")).toBeNull();
  });

  it("parses a chat chunk", () => {
    expect(parseSseData('{"choices":[{"delta":{"content":"a"}}]}')).toEqual({
      choices: [{ delta: { content: "a" } }],
    });
  });
});

describe("decodeSseStream", () => {
  it("buffers across chunk boundaries that split an event in half", async () => {
    const stream = sseStream([
      'data: {"choices":[{"delta":{"content":"he',
      'llo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const texts: string[] = [];
    for await (const chunk of decodeSseStream(stream)) {
      texts.push(chunk.choices[0]?.delta.content ?? "");
    }
    expect(texts).toEqual(["hello", " world"]);
  });

  it("handles CRLF line endings and a final event with no trailing blank line", async () => {
    const stream = sseStream(['data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{"content":"b"}}]}']);
    const texts: string[] = [];
    for await (const chunk of decodeSseStream(stream)) texts.push(chunk.choices[0]?.delta.content ?? "");
    expect(texts).toEqual(["a", "b"]);
  });

  it("skips comment frames without aborting the stream", async () => {
    const stream = sseStream([': keep-alive\n\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\n']);
    const texts: string[] = [];
    for await (const chunk of decodeSseStream(stream)) texts.push(chunk.choices[0]?.delta.content ?? "");
    expect(texts).toEqual(["a"]);
  });
});

describe("createHttpChatCompletionsCreate", () => {
  it("posts to {baseUrl}/chat/completions with a bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(sseStream(["data: [DONE]\n\n"]), { status: 200 }));
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://model.example/v1/",
      apiKey: "k-123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await create(PARAMS, {});

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://model.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k-123");
    expect(JSON.parse(init.body as string)).toMatchObject({ enable_thinking: true, max_pixels: 1024 });
  });

  it("surfaces the endpoint's own error body on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
    );
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://model.example/v1",
      apiKey: "bad",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(create(PARAMS, {})).rejects.toThrow(/returned 401.*invalid api key/s);
  });

  it("drives DashScopeModelClient end to end over a fake endpoint", async () => {
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking…"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"grade\\":"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\"ship\\"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":7}}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = vi.fn(async () => new Response(sseStream(body), { status: 200 }));
    const client = new DashScopeModelClient(
      createHttpChatCompletionsCreate({
        baseUrl: "https://model.example/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      { resolveImageUrl: (image) => `https://cdn.example/${image.objectKey}` },
      "self-host",
    );

    const response = await client.complete({
      model: "qwen3-vl-plus",
      thinking: true,
      messages: [
        { role: "system", content: "rubric" },
        {
          role: "user",
          content: "review",
          images: [{ objectKey: "a.png", route: "/", viewport: "mobile" }],
        },
      ],
    });

    expect(response.text).toBe('{"grade":"ship"}');
    expect(response.thinkingText).toBe("thinking…");
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 3, cachedTokens: 7 });
    expect(response.finishReason).toBe("stop");

    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://cdn.example/a.png" },
    });
  });
});

/** A 200 SSE response that immediately ends the stream. */
function okStream(): Response {
  return new Response(sseStream(["data: [DONE]\n\n"]), { status: 200 });
}

/** Drain a create() result so its stream (and any idle timer) actually runs. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of stream) {
    void chunk;
  }
}

describe("retry classification helpers", () => {
  it("retries 408/425/429 and every 5xx, but not 4xx like 400/401/404", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false);
  });

  it("parses Retry-After as delta-seconds and as an HTTP-date", () => {
    expect(parseRetryAfter("2", 0)).toBe(2_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("garbage", 0)).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5_000);
  });

  it("full-jitter backoff stays within [0, min(cap, base·2^(n-1)))", () => {
    expect(backoffDelayMs(1, 500, 30_000, () => 0)).toBe(0);
    expect(backoffDelayMs(1, 500, 30_000, () => 0.999)).toBeLessThan(500);
    // attempt 4 ceiling = 500·2^3 = 4000, capped by 30000
    expect(backoffDelayMs(4, 500, 30_000, () => 0.999)).toBeLessThan(4_000);
    // cap bites: 500·2^10 = 512000 → clamped to 30000
    expect(backoffDelayMs(11, 500, 30_000, () => 0.5)).toBe(15_000);
  });
});

describe("image-token estimate", () => {
  it("estimates ~one Qwen token per 28×28px block", () => {
    expect(estimateQwenImageTokens(2880, 1800)).toBe(Math.ceil((2880 * 1800) / 784));
    expect(estimateQwenImageTokens(28, 28)).toBe(1);
  });

  it("reads width/height from a PNG data URI and ignores non-PNG urls", () => {
    // 1×1 PNG.
    const onePx =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    expect(pngDimensionsFromDataUrl(onePx)).toEqual({ width: 1, height: 1 });
    expect(pngDimensionsFromDataUrl("https://cdn.example/a.png")).toBeNull();
    expect(pngDimensionsFromDataUrl("data:image/jpeg;base64,/9j/xxxx")).toBeNull();
  });

  it("logs a per-call image-token estimate before sending (W1-05)", async () => {
    const onePx =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const events: HttpModelLog[] = [];
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://m.example/v1",
      apiKey: "k",
      fetchImpl: (async () => okStream()) as unknown as typeof fetch,
      log: (e) => events.push(e),
    });
    await create(
      {
        ...PARAMS,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: onePx } }] }] as unknown as ChatCreateParams["messages"],
      },
      {},
    );
    const request = events.find((e) => e.kind === "request");
    expect(request).toMatchObject({ kind: "request", images: 1, imageTokenEstimate: 1 });
  });
});

describe("createHttpChatCompletionsCreate resilience (W1-05)", () => {
  const noWait = async () => {}; // skip real backoff sleeps
  const fixedJitter = () => 0.5;

  it("retries a 503 with backoff then succeeds, and reports the retry", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response("overloaded", { status: 503 }) : okStream();
    });
    const events: HttpModelLog[] = [];
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://m.example/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noWait,
      random: fixedJitter,
      log: (e) => events.push(e),
    });
    await drain(await create(PARAMS, {}));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.kind === "retry")).toHaveLength(1);
    expect(events.find((e) => e.kind === "retry")).toMatchObject({ attempt: 1, reason: "status 503" });
  });

  it("honours a Retry-After header as the backoff floor", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : okStream();
    });
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://m.example/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: fixedJitter,
    });
    await drain(await create(PARAMS, {}));
    // jitter would be ~250ms; Retry-After: 2 pushes the floor to 2000ms.
    expect(delays).toEqual([2_000]);
  });

  it("does not retry a non-retryable 401 and surfaces the body", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 }));
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://m.example/v1",
      apiKey: "bad",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noWait,
    });
    await expect(create(PARAMS, {})).rejects.toThrow(/returned 401.*bad key/s);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a transport failure then gives up after maxAttempts, throwing the last error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://m.example/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { maxAttempts: 3 },
      sleep: noWait,
      random: fixedJitter,
    });
    await expect(create(PARAMS, {})).rejects.toThrow(/ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never retries a caller-initiated abort (supersession)", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort(new Error("superseded"));
      // Model the real fetch: reject once the passed signal aborts.
      throw (init.signal as AbortSignal).reason ?? new Error("aborted");
    });
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://m.example/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { maxAttempts: 5 },
      sleep: noWait,
    });
    await expect(create(PARAMS, { signal: controller.signal })).rejects.toThrow(/superseded/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts and surfaces a connect timeout when headers never arrive", async () => {
    // fetch that resolves only once its signal aborts (a stuck connection).
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
        }),
    );
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://m.example/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeouts: { connectTimeoutMs: 10 },
      retry: { maxAttempts: 1 },
      sleep: noWait,
    });
    await expect(create(PARAMS, {})).rejects.toBeInstanceOf(ModelTimeoutError);
  });

  it("aborts a stalled stream via the idle timeout", async () => {
    // A stream that emits one chunk then never closes.
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
        // never close, never enqueue again → idle
      },
    });
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://m.example/v1",
      apiKey: "k",
      fetchImpl: (async () => new Response(stalling, { status: 200 })) as unknown as typeof fetch,
      timeouts: { connectTimeoutMs: 0, idleTimeoutMs: 20 },
    });
    const stream = await create(PARAMS, {});
    await expect(drain(stream)).rejects.toBeInstanceOf(ModelTimeoutError);
  });
});
