import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pageHealthFootnote, type CaptureBrowser } from "@apatureai/verdict-capture";
import type { PageHealth } from "@apatureai/verdict-types";
import type { CliOptions } from "./args.js";
import { FileScreenshotSink } from "./file-sink.js";
import { loadRepoGenome } from "./genome-source.js";
import { lexicalEmbedder, LEXICAL_EMBEDDER_ID } from "./lexical-embedder.js";
import { runLocalReview, writeReviewArtifacts } from "./local-review.js";
import { contextWindowFromEnv, fixturesDir, passModelsFromEnv, resolveLocalModel } from "./model-choice.js";
import { CLI_ENGINE_NAME, localJudgmentProvenance, stampJudgmentProvenance } from "./provenance.js";
import { loadRepoContext } from "./repo-context.js";
import { displayPath, renderSummary, type RunSummary } from "./report.js";
import { serveDirectory, type StaticSite } from "./static-server.js";

/**
 * The CLI's one job: capture a rendered UI with a real browser, ground a
 * critique against the repository's own design context, run the engine's
 * validation tail over the result, and write the artifacts out.
 *
 * With no `--url` it serves the bundled demo site itself, so the whole thing runs
 * with no credentials, no external service and no network access.
 *
 * The pipeline itself lives in `local-review.ts`, shared verbatim with the local
 * HTTP job server, so the two front doors cannot drift. What stays here is the
 * terminal-specific part: the demo site, the banner and the report.
 */

export { fixturesDir };

/** Render a path relative to the working directory when that stays readable. */
function show(path: string): string {
  return displayPath(path, relative(process.cwd(), path));
}

/**
 * Page health minus the determinism check.
 *
 * The check earns its own report line (`renderStability`), with the counts and
 * the "something is still moving" advice spelled out, so folding it into the
 * one-line footnote as well would say the same thing twice on the same screen.
 * The WIRE result keeps it: a consumer reading `review.json` or a Gate comment
 * has no second line to read it from.
 */
function withoutStability(health: PageHealth): PageHealth {
  const { stability: _stability, ...rest } = health;
  return rest;
}

export interface RunIo {
  log(line: string): void;
  error(line: string): void;
  env: Record<string, string | undefined>;
  /** Injected so tests never launch a browser. */
  launchBrowser(): Promise<CaptureBrowser>;
}

export async function runCli(options: CliOptions, io: RunIo): Promise<number> {
  const started = Date.now();
  let site: StaticSite | null = null;
  let browser: CaptureBrowser | null = null;

  try {
    let baseUrl = options.url;
    let targetNote = "";
    const demoRoot = join(fixturesDir(), "demo-site");
    if (baseUrl === undefined) {
      site = await serveDirectory(demoRoot);
      baseUrl = site.baseUrl;
      targetNote = "(bundled demo site)";
    }

    const contextDir = options.contextDir ?? demoRoot;
    const loaded = await loadRepoContext(contextDir, options.routes);
    // The design system this review is judged against, from the same directory
    // the tokens and the brand block come from. A missing snapshot is the common
    // case and is not an error: the run says what it could not ground on.
    const genome = await loadRepoGenome(contextDir);

    const outDir = resolve(options.outDir);
    await mkdir(outDir, { recursive: true });
    const sink = new FileScreenshotSink(outDir);
    const model = await resolveLocalModel({
      choice: options.model,
      env: io.env,
      resolveImageUrl: (image) => sink.dataUriFor(image.objectKey),
      ...(options.script ? { scriptPath: options.script } : {}),
      displayPath: show,
    });

    io.log(`judgment-engine — reviewing ${baseUrl} ${targetNote}`.trimEnd());
    io.log(`  ${model.description}`);
    io.log("  launching Chromium…");
    browser = await io.launchBrowser();

    io.log(`  capturing ${options.routes.length} route(s) × ${options.viewports.length} viewport(s)…`);
    io.log("  running triage + deep pass…");
    const outcome = await runLocalReview(
      {
        url: baseUrl,
        routes: options.routes,
        viewports: options.viewports,
        installationId: "local",
        depth: "deep",
        context: loaded.context,
        genome,
        verifyStability: options.verifyStability,
        // C2: run the context-window preflight on a live run, resolving the deep
        // endpoint's window from its profile. A canned/mock client sends no prompt
        // to a real endpoint, so it needs no preflight.
        ...(model.kind === "live" ? { contextWindow: contextWindowFromEnv(io.env) } : {}),
      },
      {
        browser,
        sink,
        modelFactory: model.factory,
        ...(passModelsFromEnv() ? { passModels: passModelsFromEnv() } : {}),
        // Offline and deterministic, so genome retrieval costs a local run
        // nothing and works with no credentials. It ranks by word overlap, not
        // by meaning, which the report states next to the grounding it produced.
        embedder: lexicalEmbedder,
        embedderId: LEXICAL_EMBEDDER_ID,
        artifactUrlFor: (key) => sink.urlFor(key),
      },
    );

    // The same stamp, from the same function, that the HTTP server applies. The
    // terminal report refuses to print a grade nothing earned, but review.json
    // outlives the terminal, so it says so in-band too.
    const result = stampJudgmentProvenance(
      outcome.result,
      localJudgmentProvenance(CLI_ENGINE_NAME, model.kind, outcome.result.metadata.model),
    );
    const written = await writeReviewArtifacts(outDir, { ...outcome, result });
    const files = written.paths.map(show);

    io.log(
      renderSummary({
        target: baseUrl,
        targetNote,
        routes: options.routes,
        viewports: options.viewports,
        modelKind: model.kind,
        modelDescription: model.description,
        captureVersion: outcome.capture.captureVersion,
        screenshotCount: outcome.capture.images.length,
        screenshotDir: show(join(outDir, "screenshots")),
        geometryCount: outcome.capture.geometry.length,
        grounding: outcome.grounding,
        deterministicFindings: outcome.capture.deterministicFindings,
        factsFile: show(written.factsPath),
        pageHealthFootnote: pageHealthFootnote(withoutStability(outcome.capture.pageHealth)),
        stability: outcome.capture.stability,
        hallucinationDrops: outcome.hallucinationDrops,
        modelFindingsSeen: outcome.modelFindingsSeen,
        result,
        files,
        elapsedMs: Date.now() - started,
      } satisfies RunSummary),
    );
    return 0;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (site) await site.close().catch(() => undefined);
  }
}
