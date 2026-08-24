import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  breakageForRoute,
  createBrowserCapture,
  factsForRoute,
  toMeasurementReport,
  type BrowserCaptureResult,
  type CaptureBrowser,
  type DeterministicFinding,
  checksRunFor,
  type ScreenshotSink,
} from "@apatureai/verdict-capture";
import { enforceGroundingAuthority, type ModelClientFactory,
  type PassModelOverrides,
} from "@apatureai/verdict-critique";
import { reviewSystemPrompt, runReview, type ReviewRoute } from "@apatureai/verdict-review";
import { buildGenomeIndex, type ContextBlockInput, type Embedder } from "@apatureai/verdict-context";
import type {
  CaptureContext,
  Critique,
  EngineReviewResult,
  PreviewBuildFact,
  Viewport,
} from "@apatureai/verdict-types";
import {
  resolveGrounding,
  withDisclosure,
  type LocalGenome,
  type LocalGrounding,
} from "./grounding.js";

/**
 * One local, in-process review: real Chromium capture, real deterministic
 * measurement, the real orchestrator and the real grounding gate, with no
 * database, no object store and no capture fleet.
 *
 * This module exists so there is exactly ONE local pipeline, not two. The
 * terminal CLI (`run.ts`) and the local HTTP job server (`@apatureai/verdict-serve`) are
 * two front doors onto this function; neither reimplements a step, so a result
 * polled from `GET /jobs/:id` and a result written to `out/review.json` are the
 * same bytes for the same input. Every live I/O is a parameter: the browser,
 * the screenshot sink, the model client factory and the genome embedder, which
 * is what keeps the whole thing testable against a fake browser and the mock
 * model.
 */

export interface LocalReviewRequest {
  /** Base URL to capture. Routes are appended to it. */
  url: string;
  /** Root-relative routes, e.g. `["/", "/pricing"]`. */
  routes: string[];
  viewports: Viewport[];
  /** Capture the dark-mode variant as well. */
  darkMode?: boolean;
  /**
   * Fork-safe capture: no storage state and no protection-bypass secret is
   * released. Local runs capture in this process and hold no such secrets, so
   * the default is `false`; a server carrying a tenant's secrets sets it.
   */
  isFork?: boolean;
  /** Tenant label recorded on the capture context. */
  installationId: string;
  depth: "triage" | "deep";
  /** Resolved design context (tokens, brand, component libraries, routes). */
  context: ContextBlockInput;
  /**
   * The resolved UI-DNA genome this review is grounded against, or the reason
   * there is none.
   *
   * This is the design-system half of verdict's claim, and until now no local
   * run had it: `runLocalReview` passed neither a genome index nor an embedder,
   * so the deep prompt's "Design-system rules (UI-DNA; trusted)" block was empty
   * on every review the CLI and the local HTTP server ever produced, and nothing
   * in the result said so. The deployed composition passed both, so the two
   * compositions disagreed about the one thing the product is for, and the path
   * a reader runs from the README was the one missing it.
   *
   * Resolution belongs to the caller, exactly as it does in the deployed path
   * (`GenomeResolver` there, `loadRepoGenome` here), because the two have
   * different sources of truth and only the caller knows which one it asked.
   * Absent means the caller resolved nothing and said nothing about why, which
   * is disclosed on the result as `no_genome_resolved` rather than passed over.
   */
  genome?: LocalGenome;
  /** Build/runtime facts from a preview supervisor, threaded into the deep prompt. */
  previewBuildFacts?: PreviewBuildFact[];
  /** Not-reviewed reasons decided before the review ran; carried through verbatim. */
  notReviewed?: string[];
  /**
   * The routes the CONFIG asked for, when the caller narrowed `routes` before
   * capture (today: the `routes.max_per_pr` cap). Absent means `routes` IS the
   * ask, which is true of every caller that narrows nothing.
   */
  requestedRoutes?: string[];
  /** Capture each page twice and compare the bytes. */
  verifyStability?: boolean;
  /** Retention advertised on the wire result. Local runs keep files until deleted. */
  screenshotRetentionSeconds?: number;
  /** Object-key prefix for screenshots (default `screenshots`). */
  keyPrefix?: string;
}

export interface LocalReviewDeps {
  browser: CaptureBrowser;
  /** Where PNG bytes land. `FileScreenshotSink` writes them to a directory. */
  sink: ScreenshotSink;
  modelFactory: ModelClientFactory;
  /**
   * Per-pass model ids, so a caller pointing `MODEL_BASE_URL` at their own
   * endpoint can name the models it actually serves.
   *
   * The runtime path has read `TRIAGE_MODEL` and `DEEP_MODEL` since it was
   * written; this path did not, so the documented quickstart sent the
   * built-in Qwen ids to whatever endpoint it was given. "Any
   * OpenAI-compatible endpoint" was only true for an endpoint that happened
   * to serve two models with those exact names.
   */
  passModels?: PassModelOverrides;
  /**
   * Embeds the genome's rules and each route's retrieval query (#104). Required
   * exactly when `request.genome` carries rules, which is the same invariant the
   * deployed composition enforces; a genome with no way to index it is a
   * configuration error, never a review that quietly drops the design system.
   * `lexicalEmbedder` is the offline implementation the local front doors inject.
   */
  embedder?: Embedder;
  /**
   * Names the embedding function for the run's record. Two embedders rank the
   * same genome differently, so a grounded review that cannot say which one
   * ranked it cannot be compared with another one.
   */
  embedderId?: string;
  /** Maps a screenshot object key to the URL the wire result should carry. */
  artifactUrlFor?: (key: string) => string;
  /** Cooperative cancellation, threaded into every model call. */
  signal?: AbortSignal;
}

export interface LocalReviewOutcome {
  /** The wire result, exactly as the job API and `review.json` carry it. */
  result: EngineReviewResult;
  /**
   * The internal critique: the rich form the wire result is projected from,
   * carrying the fields the projection drops (`introducedByThisPr`, the raw
   * per-finding confidence). Null only if the orchestrator never assembled one.
   */
  critique: Critique | null;
  capture: BrowserCaptureResult;
  systemPrompt: string;
  /**
   * Whether the repository's own design system reached the model, and when it
   * did not, the line the result carries saying so.
   */
  grounding: LocalGrounding;
  /** Findings deleted for citing a route or element the capture never produced. */
  hallucinationDrops: number;
  /** Findings the model or the replay script emitted before the gate ran. */
  modelFindingsSeen: number;
}

/** What a grounded run records when the caller injected an embedder it did not name. */
const UNNAMED_EMBEDDER = "unnamed embedder";

/**
 * State the run's design-system grounding on the result itself.
 *
 * Two cases, and the engine already owns the vocabulary for both:
 *
 *   - Nothing grounded it. The disclosure goes in `notReviewed`, next to the
 *     `[verdict] no model judged this page` line the same local front doors
 *     stamp when nothing judged the page, and for the same reason: the terminal
 *     report is not where most readers meet this result.
 *
 *   - A genome grounded it, and this process could not check that the version is
 *     still effective. Only the authority service can answer that, it is not
 *     reachable from a local run, and a snapshot on disk cannot answer it about
 *     itself: a revoked version's export still carries the receipt it was
 *     exported with. So the run treats its own grounding exactly as the deployed
 *     path treats grounding whose authority came back unknown, through the same
 *     `enforceGroundingAuthority` call: findings and provenance are preserved,
 *     blocking is suppressed, a `blocked` grade is floored to `needs_work`, and
 *     the reason is recorded in `notReviewed` in the engine's own words. Writing
 *     a second, friendlier sentence for the local case would have made two
 *     vocabularies for one fact.
 */
export function discloseGrounding(
  result: EngineReviewResult,
  grounding: LocalGrounding,
): EngineReviewResult {
  if (!grounding.grounded) {
    return { ...result, notReviewed: withDisclosure(result.notReviewed, grounding.disclosure) };
  }
  return enforceGroundingAuthority(result, { status: "unknown" });
}

/** Run one local review end to end. */
export async function runLocalReview(
  request: LocalReviewRequest,
  deps: LocalReviewDeps,
): Promise<LocalReviewOutcome> {
  // 0. Resolve the design-system grounding BEFORE the context block is built,
  //    because the genome's version is part of that block and therefore part of
  //    the prefix-cache key: a review grounded on `ui-dna@2026.06.12` and a
  //    review grounded on nothing must not share a cache entry.
  //
  //    `resolveGrounding` is the one place that decides whether this run is
  //    grounded. A genome that resolved but carries no rules retrieves nothing,
  //    so it counts as ungrounded here rather than as a version stamp over an
  //    empty prompt block.
  const grounding = resolveGrounding(
    request.genome,
    request.context,
    deps.embedderId ?? UNNAMED_EMBEDDER,
  );
  const genome = grounding.grounded ? (request.genome as Extract<LocalGenome, { available: true }>) : null;

  // The deployed composition throws on exactly this pairing, and so does this
  // one: a caller holding a genome and no embedder has misconfigured the review,
  // and silently reviewing without the design system is the failure this whole
  // change exists to remove.
  if (genome && !deps.embedder) {
    throw new Error("UI-DNA grounding resolved a genome but no embedder is configured");
  }

  // The version stamp travels on the context, which is what puts it in the
  // context block, in `metadata.uiDnaVersion` on the wire result, and in the
  // prompt the run writes to `system-prompt.txt`.
  const context: ContextBlockInput = genome
    ? { ...request.context, uiDnaVersion: genome.version }
    : request.context;

  // Embed every rule once, exactly as the deployed path does. Pure and offline
  // with the lexical embedder, so this costs a few milliseconds and no network.
  const genomeIndex =
    genome && deps.embedder
      ? await buildGenomeIndex(genome.version, genome.rules, deps.embedder)
      : undefined;

  const systemPrompt = reviewSystemPrompt(context);
  const capture = createBrowserCapture(
    { browser: deps.browser, sink: deps.sink, keyPrefix: request.keyPrefix ?? "screenshots" },
    { verifyStability: request.verifyStability === true },
  );

  const captureContext: CaptureContext = {
    installationId: request.installationId,
    viewports: request.viewports,
    darkMode: request.darkMode ?? false,
    isFork: request.isFork ?? false,
    routes: request.routes,
  };

  const captured = (await capture(request.url, captureContext)) as BrowserCaptureResult;

  // The deterministic facts are measured DURING capture, so the per-route inputs
  // the deep prompt is grounded on can only be assembled here, after it ran.
  //
  // `deterministicBreakage` is the subset of those measurements that means the
  // page came apart, and it is threaded through separately because it does a
  // different job: the deep prompt reads `facts`, but TRIAGE reads breakage, and
  // a route with measured breakage gets a deep review whatever the cheap model
  // answered. This field existed and was never populated on either shipped
  // surface, so until now the only thing that could force a deep review was the
  // triage model agreeing to one; a measured overflow the model failed to notice
  // was carried to the deep prompt on the routes that happened to be reviewed
  // and dropped entirely on the routes that were not.
  //
  // What is still NOT populated here, deliberately: `baselinePhash` and
  // `tileScores`. Both describe THIS capture against a PREVIOUS one, and a local
  // run has no previous one: nothing in this process, and nothing on disk that
  // it owns, records a per-(repo, route, viewport) hash or tile score from an
  // earlier run. Inventing a value would be worse than leaving it absent, since
  // the triage gate treats a confirmed match as grounds to skip the review
  // entirely. The consequences of the gap are exact and are documented on
  // `ReviewRoute`: the pHash + tile-diff short-circuit is unreachable on both
  // shipped surfaces, so every local run pays for a triage model call it could
  // sometimes have skipped, and when triage declines a deep review the run has
  // no baseline to have declined against, which is why the orchestrator marks
  // those routes not-reviewed instead of clean. Closing it needs a baseline
  // store keyed by repo and route with a retention and invalidation policy,
  // which is a feature, not a wiring fix.
  const routes: ReviewRoute[] = request.routes.map((route) => {
    const facts = factsForRoute(captured.deterministicFindings, route);
    const breakage = breakageForRoute(captured.deterministicFindings, route);
    const text = captured.pageText[route];
    return {
      route,
      ...(facts.length > 0 ? { facts } : {}),
      ...(breakage.length > 0 ? { deterministicBreakage: breakage } : {}),
      ...(text ? { pageText: text } : {}),
    };
  });

  let critique: Critique | null = null;
  const reviewed = await runReview(
    {
      url: request.url,
      depth: request.depth,
      context,
      captureContext,
      routes,
      // The measured half, published on the result rather than stopping at the
      // deep prompt. Same `DeterministicFinding[]` the two lines above turn into
      // prompt facts and triage breakage, grouped once for the wire.
      measurements: toMeasurementReport(
        captured.deterministicFindings,
        checksRunFor([...new Set(captured.images.map((image) => image.viewport))]),
      ),
      ...(request.previewBuildFacts ? { previewBuildFacts: request.previewBuildFacts } : {}),
      ...(request.notReviewed ? { notReviewed: request.notReviewed } : {}),
      ...(request.requestedRoutes ? { requestedRoutes: request.requestedRoutes } : {}),
      wireOptions: {
        screenshotRetentionSeconds: request.screenshotRetentionSeconds ?? 0,
        screenshotIdFor: (finding) =>
          captured.images.find(
            (image) => image.route === finding.route && image.viewport === finding.viewport,
          )?.objectKey ?? null,
        ...(deps.artifactUrlFor ? { artifactUrlFor: deps.artifactUrlFor } : {}),
      },
    },
    {
      // The capture already ran, so the seam hands the orchestrator the result
      // it produced rather than capturing a second time.
      captureInSandbox: async () => captured,
      modelFactory: deps.modelFactory,
      ...(deps.passModels ? { passModels: deps.passModels } : {}),
      // Retrieval needs both halves or neither: the orchestrator injects the
      // per-route rules only when it has an index to rank and an embedder to
      // embed the query with.
      ...(genomeIndex ? { genomeIndex } : {}),
      ...(genomeIndex && deps.embedder ? { embedder: deps.embedder } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      onCritique: (value) => {
        critique = value;
      },
    },
  );

  const result = discloseGrounding(reviewed, grounding);
  const assembled = critique as Critique | null;
  const hallucinationDrops = assembled?.validation.hallucinationDrops ?? 0;
  return {
    result,
    critique: assembled,
    capture: captured,
    systemPrompt,
    grounding,
    hallucinationDrops,
    // The critique now states what entered the validation tail. Reconstructing
    // it as survivors + grounding-gate drops undercounted every run the
    // confidence floor or trust budget also deleted from, so the "N model
    // finding(s) parsed" line under-reported the model's own output.
    modelFindingsSeen: assembled?.validation.modelFindingsSeen ?? 0,
  };
}

export interface WrittenArtifacts {
  /** Absolute paths, in report order. */
  paths: string[];
  /** The measured-fact file, which the report points at by name. */
  factsPath: string;
  /** The wire result, which the HTTP server serves back as the job result. */
  reviewPath: string;
  /** The DOM geometry map every `elementRef` was validated against. */
  geometryPath: string;
  /** The rubric that was actually sent. */
  promptPath: string;
}

/**
 * The measured-fact file's body.
 *
 * An empty file is the correct output for a clean page and an indistinguishable
 * output from "the checks never ran", which is the wrong thing for the one
 * artifact the honesty story rests on: these facts are the part of a review that
 * is true with no model involved, and a reader has to be able to see that they
 * were computed. So a clean page says so in words instead of saying nothing.
 */
export function renderDeterministicFacts(findings: DeterministicFinding[]): string {
  if (findings.length === 0) {
    return "0 issues found (contrast, overflow and touch-target checks ran and measured no violation)\n";
  }
  return `${findings
    .map(
      (finding) =>
        `[${finding.kind}] ${finding.route} ${finding.viewport} ${finding.selector}: ${finding.detail}`,
    )
    .join("\n")}\n`;
}

/**
 * Write a review's artifacts into a directory. The same four files, in the same
 * format, whichever front door ran the review, so an HTTP job leaves behind
 * exactly what `pnpm review` leaves behind.
 */
export async function writeReviewArtifacts(
  outDir: string,
  outcome: Pick<LocalReviewOutcome, "result" | "systemPrompt" | "capture">,
): Promise<WrittenArtifacts> {
  await mkdir(outDir, { recursive: true });
  const reviewPath = join(outDir, "review.json");
  const promptPath = join(outDir, "system-prompt.txt");
  const geometryPath = join(outDir, "geometry.json");
  const factsPath = join(outDir, "deterministic-facts.txt");

  await writeFile(reviewPath, `${JSON.stringify(outcome.result, null, 2)}\n`);
  await writeFile(promptPath, `${outcome.systemPrompt}\n`);
  await writeFile(geometryPath, `${JSON.stringify(outcome.capture.geometry, null, 2)}\n`);
  await writeFile(factsPath, renderDeterministicFacts(outcome.capture.deterministicFindings));

  return {
    paths: [reviewPath, promptPath, geometryPath, factsPath],
    factsPath,
    reviewPath,
    geometryPath,
    promptPath,
  };
}
