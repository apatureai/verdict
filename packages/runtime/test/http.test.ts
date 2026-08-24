import { afterEach, describe, expect, it } from "vitest";
import type { ApiRequest, ApiResponse } from "@apatureai/verdict-api";
import { EngineHttpServer, type RawRequest, type RawResponse } from "../src/http.js";

/**
 * The transport's own contract, and in particular WHAT EACH ROUTE IS TOLD ABOUT
 * THE URL. The JSON job API routes by splitting the path on "/", so it must be
 * handed the pathname with no query string or a job id would absorb one. A
 * byte-serving route authenticates a signed URL whose token lives IN the query
 * string, so it must be handed the query. Getting that split wrong is silent:
 * the signer and the verifier still agree, the token just never arrives, and
 * every correctly signed artifact URL comes back 401.
 */

const readiness = {
  database: async () => true,
  capture: async () => true,
  worker: () => true,
};

let server: EngineHttpServer | null = null;

afterEach(async () => {
  if (server) await server.close();
  server = null;
});

async function start(options: {
  handle?: (request: ApiRequest) => Promise<ApiResponse>;
  serveRaw?: (request: RawRequest) => Promise<RawResponse | null>;
}): Promise<string> {
  server = new EngineHttpServer({
    handle: options.handle ?? (async () => ({ status: 404, body: { error: "not_found" } })),
    ...(options.serveRaw ? { serveRaw: options.serveRaw } : {}),
    readiness,
  });
  const port = await server.listen(0, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

describe("EngineHttpServer", () => {
  it("hands a raw route the query string, and the path without it", async () => {
    let seen: RawRequest | null = null;
    const base = await start({
      serveRaw: async (request) => {
        seen = request;
        return { status: 200, headers: { "content-type": "text/plain" }, body: new Uint8Array([0x6f, 0x6b]) };
      },
    });

    const response = await fetch(`${base}/artifacts/jobs/abc/shot.png?token=deadbeef&v=2`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    const request = seen as unknown as RawRequest;
    expect(request.path).toBe("/artifacts/jobs/abc/shot.png");
    expect(request.query.get("token")).toBe("deadbeef");
    expect(request.query.get("v")).toBe("2");
  });

  it("falls through to the JSON handler when the raw route declines", async () => {
    const paths: string[] = [];
    const base = await start({
      serveRaw: async () => null,
      handle: async (request) => {
        paths.push(request.path);
        return { status: 200, body: { ok: true } };
      },
    });

    const response = await fetch(`${base}/jobs/abc-123?ignored=1`);
    expect(response.status).toBe(200);
    // The job API splits this on "/" to find the id, so the query must be gone.
    expect(paths).toEqual(["/jobs/abc-123"]);
  });

  it("never consults a raw route for a method that carries a body", async () => {
    let rawCalls = 0;
    const base = await start({
      serveRaw: async () => {
        rawCalls += 1;
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
      handle: async (request) => ({ status: 200, body: { body: request.body } }),
    });

    const response = await fetch(`${base}/jobs`, { method: "POST", body: '{"a":1}' });
    expect(await response.json()).toEqual({ body: '{"a":1}' });
    expect(rawCalls).toBe(0);
  });

  it("answers the liveness and readiness probes without reaching either route", async () => {
    const base = await start({
      serveRaw: async () => {
        throw new Error("a probe must never reach the raw route");
      },
      handle: async () => {
        throw new Error("a probe must never reach the JSON handler");
      },
    });

    expect(await (await fetch(`${base}/livez`)).json()).toEqual({ status: "live" });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ready",
      components: { database: true, capture: true, worker: true },
    });
  });

  it("refuses a body larger than the limit instead of buffering it", async () => {
    server = new EngineHttpServer({
      handle: async () => ({ status: 200, body: {} }),
      readiness,
      maxBodyBytes: 8,
    });
    const port = await server.listen(0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/jobs`, {
      method: "POST",
      body: "x".repeat(64),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "body_too_large" });
  });
});
