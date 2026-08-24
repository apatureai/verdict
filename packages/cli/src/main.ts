#!/usr/bin/env node
import { launchChromiumCaptureBrowser } from "@apatureai/verdict-capture/playwright";
import { ArgError, parseArgs, USAGE } from "./args.js";
import { runCli } from "./run.js";

/**
 * `judgment-engine` entry point. Exit codes: 0 success, 1 run failure,
 * 2 bad arguments, the same convention as the release-gate CLI.
 */
async function main(): Promise<number> {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ArgError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    return await runCli(options, {
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      env: process.env,
      launchBrowser: () => launchChromiumCaptureBrowser(),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = await main();
