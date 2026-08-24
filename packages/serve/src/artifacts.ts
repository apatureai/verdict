import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { FileScreenshotSink } from "@apatureai/verdict-cli";
import type { RawRequest, RawResponse } from "@apatureai/verdict-runtime/http";

/**
 * Serving the files a review left behind.
 *
 * A wire result points at its screenshots by URL. In production those are
 * short-TTL signed object-store URLs; this deployment has no object store, so
 * it serves the same bytes off disk under `/artifacts/<object key>` and signs
 * the URL the same way in spirit: a per-key HMAC token the holder of the
 * engine secret can mint and nobody else can. Without it the port would be an
 * unauthenticated file server for screenshots of whatever pages were reviewed.
 *
 * The token does not expire. That is a real difference from `signedGetUrl` and
 * is stated rather than papered over: a local artifact URL is valid until the
 * engine secret changes or the file is deleted.
 */

export const ARTIFACT_PREFIX = "/artifacts/";
const TOKEN_PARAM = "token";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

/** Per-key MAC. Scoped to the exact key, so one URL never grants another. */
export function artifactToken(secret: string, key: string): string {
  return createHmac("sha256", secret).update(`artifact:${key}`).digest("hex").slice(0, 32);
}

function tokenMatches(secret: string, key: string, provided: string | null): boolean {
  if (!provided) return false;
  const expected = Buffer.from(artifactToken(secret, key), "utf8");
  const supplied = Buffer.from(provided, "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

/** The URL a wire result should carry for an artifact key. */
export function artifactUrl(baseUrl: string, secret: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}${artifactPath(secret, key)}`;
}

/** Origin-relative form of the same URL: path, then the per-key token. */
export function artifactPath(secret: string, key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${ARTIFACT_PREFIX}${path}?${TOKEN_PARAM}=${artifactToken(secret, key)}`;
}

/**
 * Inverse of the encoding `artifactPath` applies: per segment, never over the
 * whole string, so a key segment containing an encoded separator decodes back
 * to itself instead of splitting into two segments.
 */
function keyFromPathname(pathname: string): string {
  return pathname
    .slice(ARTIFACT_PREFIX.length)
    .replace(/\/$/, "")
    .split("/")
    .map(decodeURIComponent)
    .join("/");
}

export interface ArtifactServerOptions {
  /** Directory every artifact key is resolved under. */
  root: string;
  secret: string;
}

/**
 * A `serveRaw` handler for `EngineHttpServer`. Returns `null` for anything that
 * is not an artifact request, so the JSON job API keeps every other path.
 */
export function createArtifactServer(options: ArtifactServerOptions) {
  // The sink already owns the "this key must not escape the root" rule, and
  // reusing it means the read path and the write path cannot disagree.
  const sink = new FileScreenshotSink(options.root);

  return async function serveArtifact(request: RawRequest): Promise<RawResponse | null> {
    if (!request.path.startsWith(ARTIFACT_PREFIX)) return null;

    let key: string;
    const json = (status: number, body: unknown): RawResponse => ({
      status,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(body)),
    });
    try {
      key = keyFromPathname(request.path);
    } catch {
      // decodeURIComponent throws on a malformed escape such as `%zz`.
      return json(400, { error: "invalid_artifact_key" });
    }

    if (!tokenMatches(options.secret, key, request.query.get(TOKEN_PARAM))) {
      return json(401, { error: "invalid_artifact_token" });
    }

    let path: string;
    try {
      path = sink.pathFor(key);
    } catch {
      return json(400, { error: "invalid_artifact_key" });
    }

    let entry;
    try {
      entry = await stat(path);
    } catch {
      return json(404, { error: "artifact_not_found" });
    }

    if (entry.isDirectory()) {
      const names = (await readdir(path)).sort();
      return json(200, {
        key,
        // Each entry carries its own signed path, so the index is walkable by
        // whoever already holds a valid URL for the directory above it.
        entries: names.map((name) => ({
          name,
          key: `${key}/${name}`,
          url: artifactPath(options.secret, `${key}/${name}`),
        })),
      });
    }

    return {
      status: 200,
      headers: { "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" },
      body: await readFile(path),
    };
  };
}

/** Directory on disk holding one job's artifacts. */
export function jobArtifactDir(root: string, jobId: string): string {
  return join(root, "jobs", jobId);
}

/** Object-key prefix one job's screenshots are written under. */
export function jobScreenshotPrefix(jobId: string): string {
  return `jobs/${jobId}/screenshots`;
}
