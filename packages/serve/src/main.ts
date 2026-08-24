#!/usr/bin/env node
import { launchChromiumCaptureBrowser } from "@apatureai/verdict-capture/playwright";
import { parseServeArgs, SERVE_USAGE, ServeArgError } from "./args.js";
import { createLocalEngine } from "./local-engine.js";

/**
 * `judgment-engine-serve` entry point. Exit codes: 0 success, 1 start failure,
 * 2 bad arguments, the same convention as the review CLI.
 */
async function main(): Promise<number> {
  let options;
  try {
    options = parseServeArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ServeArgError) {
      console.error(`${error.message}\n\n${SERVE_USAGE}`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(SERVE_USAGE);
    return 0;
  }

  const secret = process.env.ENGINE_HMAC_SECRET;
  if (!secret || secret.trim().length === 0) {
    // No default, and no unauthenticated mode. An engine that accepts unsigned
    // jobs is an open browser pointed at whatever URL a stranger submits.
    console.error(
      "ENGINE_HMAC_SECRET is not set. Every request to this API is HMAC-signed with it, and it is never defaulted.\n" +
        'Set one, for example: export ENGINE_HMAC_SECRET="$(openssl rand -hex 32)"',
    );
    return 1;
  }

  const engine = await createLocalEngine({
    secret,
    outRoot: options.outDir,
    env: process.env,
    model: options.model,
    verifyStability: options.verifyStability,
    launchBrowser: () => launchChromiumCaptureBrowser(),
    ...(options.contextDir ? { contextDir: options.contextDir } : {}),
    ...(options.script ? { scriptPath: options.script } : {}),
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
    logger: console,
  });

  const port = await engine.listen(options.port, options.host);
  console.log(`judgment-engine-serve listening on http://${options.host}:${port}`);
  console.log(`  ${engine.model.description}`);
  if (engine.model.kind !== "live") {
    console.log(
      "  no model is configured, so every result will carry provenance saying nothing judged the page",
    );
  }
  console.log(`  artifacts: ${options.outDir}`);
  console.log("  POST /jobs to submit, GET /jobs/:id to poll, DELETE /jobs/:id to cancel");

  const shutdown = (signal: string): void => {
    console.log(`received ${signal}; draining`);
    void engine.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return 0;
}

process.exitCode = await main();
