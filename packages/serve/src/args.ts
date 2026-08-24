import type { ModelChoice } from "@apatureai/verdict-cli";

/**
 * Argument parsing for `judgment-engine-serve`. Pure: it never touches the
 * filesystem, the network or `process`, so every flag combination is unit-tested.
 */

export interface ServeOptions {
  port: number;
  host: string;
  outDir: string;
  model: ModelChoice;
  contextDir?: string;
  script?: string;
  publicBaseUrl?: string;
  verifyStability: boolean;
  help: boolean;
}

export const DEFAULT_SERVE_OPTIONS: ServeOptions = {
  port: 8080,
  host: "127.0.0.1",
  outDir: "out/serve",
  model: "auto",
  verifyStability: false,
  help: false,
};

export class ServeArgError extends Error {}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new ServeArgError(`${flag} requires a value`);
  return value;
}

export function parseServeArgs(argv: readonly string[]): ServeOptions {
  const options: ServeOptions = { ...DEFAULT_SERVE_OPTIONS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--port": {
        const port = Number(requireValue("--port", next));
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new ServeArgError(`--port must be a port number, got "${String(next)}"`);
        }
        options.port = port;
        i += 1;
        break;
      }
      case "--host":
        options.host = requireValue("--host", next);
        i += 1;
        break;
      case "--out":
        options.outDir = requireValue("--out", next);
        i += 1;
        break;
      case "--context-dir":
        options.contextDir = requireValue("--context-dir", next);
        i += 1;
        break;
      case "--script":
        options.script = requireValue("--script", next);
        i += 1;
        break;
      case "--public-url":
        options.publicBaseUrl = requireValue("--public-url", next);
        i += 1;
        break;
      case "--model": {
        const model = requireValue("--model", next);
        if (model !== "auto" && model !== "mock" && model !== "canned" && model !== "live") {
          throw new ServeArgError(`unknown --model "${model}" (expected auto, mock, canned or live)`);
        }
        options.model = model;
        i += 1;
        break;
      }
      case "--verify-stability":
        options.verifyStability = true;
        break;
      default:
        throw new ServeArgError(`unknown argument "${arg}"`);
    }
  }

  return options;
}

export const SERVE_USAGE = `judgment-engine-serve: serve grounded design reviews over the async job API.

Usage:
  judgment-engine-serve [options]

Consumers POST /jobs with an HMAC signature, an idempotency key and a depth,
then poll GET /jobs/:id. DELETE /jobs/:id cancels. Every request is signed with
ENGINE_HMAC_SECRET, which is required and never defaulted.

Options:
  --port <n>              Port to listen on (default: 8080; 0 picks a free one)
  --host <addr>           Address to bind (default: 127.0.0.1)
  --out <dir>             Where artifacts are written (default: out/serve)
  --context-dir <dir>     Directory holding tokens.json, .designreview.yml and
                          package.json, used where a request supplies no context
  --script <file.json>    Canned model script for the offline path
  --public-url <origin>   Origin used to build artifact URLs (default: the
                          address the server bound to)
  --model <choice>        auto | mock | canned | live (default: auto)
                            auto   live if MODEL_API_KEY is set, else canned
                            mock   deterministic empty critique, no network
                            canned replay a scripted critique from --script
                            live   MODEL_BASE_URL + MODEL_API_KEY, real calls
  --verify-stability      Capture each page twice and compare the bytes
  -h, --help              Show this message

Environment:
  ENGINE_HMAC_SECRET      Required. The shared secret requests are signed with.
  MODEL_BASE_URL          OpenAI-compatible endpoint. Never guessed.
  MODEL_API_KEY           Bearer token for that endpoint.

Without a model key the server still captures, measures and grounds for real,
and every result it returns carries provenance saying no model judged the page.

Requires a Chromium binary. From the repository root:
  pnpm browser:install
`;
