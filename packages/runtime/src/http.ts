import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiRequest, ApiResponse } from "@apatureai/verdict-api";

export interface ReadinessChecks {
  database(): Promise<boolean>;
  capture(): Promise<boolean>;
  worker(): boolean;
}

/** A response whose body is bytes, not JSON (screenshots and other artifacts). */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * What a byte-serving route is handed.
 *
 * `query` is separate from `path` on purpose, and is the reason this is not
 * just `Omit<ApiRequest, "body">`. `ApiRequest.path` is the pathname alone:
 * the JSON job API routes by splitting it on "/", so a query string reaching
 * it would be read as part of the job id. A signed artifact URL carries its
 * token in the query string, so a raw route that only ever saw the pathname
 * could never find the token and would reject every URL the signer minted.
 * Giving the query its own field means neither side can silently drop it.
 */
export interface RawRequest {
  method: string;
  /** Pathname only, with no query string, like `ApiRequest.path`. */
  path: string;
  /** Parsed query string of the request target. */
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
}

export interface EngineHttpServerOptions {
  handle(request: ApiRequest): Promise<ApiResponse>;
  readiness: ReadinessChecks;
  maxBodyBytes?: number;
  /**
   * Optional byte-serving route, consulted before the JSON handler and only for
   * requests with no body. Returning `null` falls through to `handle`. This is
   * how a deployment that stores artifacts locally serves the screenshot a
   * finding points at; deployments backed by object storage hand out signed URLs
   * instead and leave this unset.
   */
  serveRaw?(request: RawRequest): Promise<RawResponse | null>;
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headersOf(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return headers;
}

export class EngineHttpServer {
  private readonly server: Server;
  private readonly maxBodyBytes: number;

  constructor(private readonly options: EngineHttpServerOptions) {
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    this.server = createServer((request, response) => {
      void this.route(request, response);
    });
  }

  async listen(port: number, host = "0.0.0.0"): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = new URL(request.url ?? "/", "http://engine.local");
    const path = target.pathname;
    if (request.method === "GET" && path === "/livez") {
      writeJson(response, 200, { status: "live" });
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      const [database, capture] = await Promise.all([
        this.options.readiness.database().catch(() => false),
        this.options.readiness.capture().catch(() => false),
      ]);
      const worker = this.options.readiness.worker();
      const ready = database && capture && worker;
      writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", components: { database, capture, worker } });
      return;
    }
    try {
      if (this.options.serveRaw && request.method === "GET") {
        const raw = await this.options.serveRaw({
          method: "GET",
          path,
          query: target.searchParams,
          headers: headersOf(request),
        });
        if (raw) {
          response.writeHead(raw.status, raw.headers);
          response.end(Buffer.from(raw.body));
          return;
        }
      }
      const body = await readBody(request, this.maxBodyBytes);
      const result = await this.options.handle({
        method: request.method ?? "GET",
        path,
        headers: headersOf(request),
        body,
      });
      writeJson(response, result.status, result.body, result.headers);
    } catch (error) {
      if (error instanceof Error && error.message === "body_too_large") {
        writeJson(response, 413, { error: "body_too_large" });
        return;
      }
      writeJson(response, 500, { error: "internal_error" });
    }
  }
}
