import { describe, expect, it, vi } from "vitest";
import { ModelConfigError, resolveModelRuntime } from "../src/index.js";

/**
 * The mock/live decision is the one configuration mistake that fails silently:
 * a mock run produces a well-formed, entirely empty review that reads as a clean
 * bill of health. These tests pin both the choice and the wording that announces it.
 */

describe("resolveModelRuntime", () => {
  it("defaults to the mock client when no API key is configured", () => {
    const runtime = resolveModelRuntime({});
    expect(runtime.mode).toBe("mock");
    expect(runtime.description).toMatch(/^MOCK model client/);
    expect(runtime.baseUrl).toBeUndefined();
    expect(runtime.factory({ model: "m", backend: "mock", thinking: false }).backend).toBe("mock");
  });

  it("treats a blank key as absent rather than as a live configuration", () => {
    expect(resolveModelRuntime({ MODEL_API_KEY: "   " }).mode).toBe("mock");
  });

  it("refuses to guess an endpoint when a key is set without a base URL", () => {
    expect(() => resolveModelRuntime({ MODEL_API_KEY: "k" })).toThrow(ModelConfigError);
    expect(() => resolveModelRuntime({ MODEL_API_KEY: "k" })).toThrow(/MODEL_BASE_URL/);
  });

  it("builds a live client that names its endpoint", () => {
    const runtime = resolveModelRuntime({
      MODEL_API_KEY: "k",
      MODEL_BASE_URL: " https://model.example/v1 ",
    });
    expect(runtime.mode).toBe("live");
    expect(runtime.baseUrl).toBe("https://model.example/v1");
    expect(runtime.description).toContain("https://model.example/v1");
    expect(runtime.description).toMatch(/^LIVE model client/);
  });

  it("routes a live call through the configured endpoint and image resolver", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    const runtime = resolveModelRuntime(
      { MODEL_API_KEY: "k", MODEL_BASE_URL: "https://model.example/v1" },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveImageUrl: (image) => `data:image/png;base64,${image.objectKey}`,
      },
    );

    const client = runtime.factory({ model: "qwen3-vl-plus", backend: "self-host", thinking: false });
    const response = await client.complete({
      model: "qwen3-vl-plus",
      thinking: false,
      responseFormat: "json_object",
      messages: [{ role: "user", content: "go", images: [{ objectKey: "AAA", route: "/", viewport: "mobile" }] }],
    });

    expect(client.backend).toBe("self-host");
    expect(response.text).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://model.example/v1/chat/completions");
    const sent = JSON.parse(init.body as string);
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[0].content[1].image_url.url).toBe("data:image/png;base64,AAA");
  });

  it("threads MODEL_MAX_ATTEMPTS into the live client so a 503 is retried (W1-05)", async () => {
    let calls = 0;
    const okStream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response("overloaded", { status: 503 }) : okStream();
    });
    const runtime = resolveModelRuntime(
      { MODEL_API_KEY: "k", MODEL_BASE_URL: "https://model.example/v1", MODEL_MAX_ATTEMPTS: "2" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} },
    );
    const client = runtime.factory({ model: "m", backend: "self-host", thinking: false });
    const response = await client.complete({
      model: "m",
      thinking: false,
      messages: [{ role: "user", content: "go" }],
    });
    expect(response.text).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
