import type { Capture, CaptureContext, CaptureImage, GeometryRect, Viewport } from "@apatureai/verdict-types";
import {
  DEVICE_SCALE_FACTOR,
  VIEWPORT_SIZES,
  type CaptureBrowser,
  type CapturePage,
  type ExtractedPage,
  type ScreenshotSink,
} from "./browser-port.js";
import { runCaptureLifecycle, type CaptureLifecycleOps } from "./capture-lifecycle.js";
import {
  deterministicChecks,
  isBreakage,
  type DeterministicFinding,
  type PageMetrics,
} from "./checks.js";
import {
  DOM_EXTRACT_EXPRESSION,
  toInteractiveElements,
  toRawGeometryElements,
  toTextNodeStyles,
} from "./dom-extract.js";
import { serializeGeometry } from "./geometry.js";
import { buildPageHealth } from "./page-health.js";
import { pngDimensions } from "./png.js";

/**
 * The live capture worker (TRD §4, #11), the implementation of the
 * `captureInSandbox(url, ctx)` seam.
 *
 * It is deliberately thin, because every hard part of capture was already built
 * as a pure, tested module and only needed a browser bound to it:
 *
 *   - `runCaptureLifecycle` (#12/#13/#14/#102) owns the determinism ordering:
 *     reduced-motion + CSS freeze + clock install before navigation, then
 *     domcontentloaded → ready_selector → fonts.ready → layout-stable, then
 *     pin the clock, scroll for lazy content, re-check fonts, re-freeze, re-pin.
 *   - `serializeGeometry` (#18) turns the extracted rects into the geometry map
 *     the drop-and-count gate (#32) validates `element_ref`s against.
 *   - `deterministicChecks` (#19) turns computed styles into contrast, overflow
 *     and touch-target FACTS the deep prompt is told to trust over its own pixels.
 *   - `buildPageHealth` (#20/#83) aggregates console errors, failed requests and
 *     silently substituted web fonts into the footnote.
 *
 * What this module adds is the binding, one fresh browser context per
 * (route, viewport), required since Playwright's clock is per-context, plus
 * the screenshot write and the optional repeat-capture determinism check.
 *
 * The browser is INJECTED through the `CaptureBrowser` port, so the whole worker
 * is unit-tested against a fake page. `launchChromiumCaptureBrowser` binds the
 * real one.
 */

export const BROWSER_CAPTURE_VERSION = "chromium-playwright@1";

export interface BrowserCaptureDeps {
  browser: CaptureBrowser;
  /** Where PNG bytes are written. `InMemoryObjectStore` and `S3ObjectStore` both fit. */
  sink: ScreenshotSink;
  /** Object-key prefix for this run; defaults to `captures`. */
  keyPrefix?: string;
}

export interface BrowserCaptureOptions {
  /** `ready_selector` override awaited after navigation. */
  readySelector?: string;
  /** Navigation budget in ms; defaults to the readiness protocol's 30s. */
  gotoBudgetMs?: number;
  /**
   * Capture each page twice and compare the PNG bytes. Time is pinned and motion
   * frozen, so a deterministic page renders byte-identically; a difference means
   * something is still moving and the review must be treated as unstable (#15 →
   * the #70 confidence ceiling). Off by default: every page is screenshotted
   * twice, and the result is reported as `stability` so a clean check is
   * visible rather than merely implied by the absence of a complaint.
   *
   * This is the OPERATOR's switch: the CLI's `--verify-stability`, and the same
   * flag on `judgment-engine-serve`, where it applies to every job that server
   * runs. `CaptureContext.verifyStability` is the per-REQUEST form of the same
   * ask, and either one turns the check on for the capture it applies to.
   */
  verifyStability?: boolean;
  /** Max viewport advances during the lazy-load scroll. */
  maxScrollViewports?: number;
}

/** Did anything ask for the determinism check on this capture: the flag, or the request? */
export function stabilityRequested(
  ctx: Pick<CaptureContext, "verifyStability">,
  options: Pick<BrowserCaptureOptions, "verifyStability">,
): boolean {
  return options.verifyStability === true || ctx.verifyStability === true;
}

/** A capture plus the by-products the orchestrator threads into the prompt. */
export interface BrowserCaptureResult extends Capture {
  /** Contrast / overflow / touch-target / page-overflow facts (#19) for the deep-pass prompt. */
  deterministicFindings: DeterministicFinding[];
  /**
   * Measurements the checks LOOKED AT and DECLINED because an exception applied
   * (judge-unlock §4.1): a WCAG-excused touch target, a deliberate truncation.
   * They are NOT published to the reviewer and never enter the wire report, but
   * they are surfaced to the model as "measured, declined, here is why" so it can
   * judge them against this repository's stricter rule, and they pin their
   * element into the geometry map. Excluded from the duplicate-of-measurement
   * gate. Empty when nothing was declined.
   */
  declinedFindings: DeterministicFinding[];
  /** Object keys written to the sink, in capture order. */
  objectKeys: string[];
  /**
   * Visible page text per route (#53). UNTRUSTED: the caller passes it as
   * `pageText` so the deep pass fences it inside `<untrusted_page_content>`.
   */
  pageText: Record<string, string>;
  /**
   * Result of the repeat-capture determinism check, or `null` when
   * `verifyStability` was off. A check that ran and found nothing is a real
   * result, so callers report it and "I verified this" is distinguishable from
   * "I never looked".
   */
  stability: StabilityCheck | null;
}

/** How many pages were captured twice, and how many differed (#15). */
export interface StabilityCheck {
  pagesCompared: number;
  unstablePages: number;
}

/** Filesystem- and URL-safe fragment for a route path. */
export function routeSlug(route: string): string {
  const cleaned = route.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return cleaned.length > 0 ? cleaned : "index";
}

/** Resolve a route against the preview base URL. */
export function routeUrl(baseUrl: string, route: string): string {
  return new URL(route, baseUrl).toString();
}

/** Bind the injected page to the lifecycle's four op bundles. */
function lifecycleOps(page: CapturePage, url: string, options: BrowserCaptureOptions): CaptureLifecycleOps {
  return {
    clock: page.clock,
    freeze: {
      freezeAnimations: () => page.freezeAnimations(),
      addStyleSheet: (content) => page.addStyleTag(content),
      emulateMedia: () => page.emulateReducedMotion(),
    },
    readiness: {
      goto: ({ waitUntil, timeoutMs }) =>
        page.goto(url, { waitUntil, timeout: options.gotoBudgetMs ?? timeoutMs }),
      waitForSelector: (selector) => page.waitForSelector(selector, { timeout: 10_000 }),
      waitForFontsReady: () => page.waitForFontsReady(),
      waitForLayoutStable: (opts) => page.waitForLayoutStable(opts),
    },
    lazyLoad: {
      measureHeight: () =>
        page.evaluate<number>(
          "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
        ),
      scrollTo: async (y) => {
        await page.evaluate<null>(`(window.scrollTo(0, ${y}), null)`);
      },
      wait: (ms) => page.wait(ms),
    },
  };
}

interface PageCaptureOutcome {
  png: Uint8Array;
  extracted: ExtractedPage;
  unstable: boolean;
  console: Array<{ level: string; text: string }>;
  failedRequests: Array<{ url: string; status: number | null }>;
}

/** Run the deterministic lifecycle on one page and take its screenshot. */
async function capturePage(
  page: CapturePage,
  url: string,
  viewportHeight: number,
  options: BrowserCaptureOptions,
): Promise<PageCaptureOutcome> {
  await runCaptureLifecycle(lifecycleOps(page, url, options), {
    viewportHeight,
    ...(options.readySelector !== undefined ? { readiness: { readySelector: options.readySelector } } : {}),
    ...(options.maxScrollViewports !== undefined ? { maxScrollViewports: options.maxScrollViewports } : {}),
  });

  const extracted = await page.evaluate<ExtractedPage>(DOM_EXTRACT_EXPRESSION);
  const png = await page.screenshot({ fullPage: true });

  let unstable = false;
  if (options.verifyStability === true) {
    const second = await page.screenshot({ fullPage: true });
    unstable = !bytesEqual(png, second);
  }

  return {
    png,
    extracted,
    unstable,
    console: page.consoleEvents(),
    failedRequests: page.failedRequests(),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Capture every (route, viewport) of a preview deployment. Each pair runs in a
 * FRESH browser context: Playwright's clock pin is per-context, and a shared
 * context would leak one route's storage/state into the next.
 */
export async function captureWithBrowser(
  baseUrl: string,
  ctx: CaptureContext,
  deps: BrowserCaptureDeps,
  options: BrowserCaptureOptions = {},
): Promise<BrowserCaptureResult> {
  const prefix = deps.keyPrefix ?? "captures";
  // The operator's flag and the request's ask are the same instruction, so they
  // are resolved once, here, and every read below is of the resolved answer.
  const verifyStability = stabilityRequested(ctx, options);
  const pageOptions: BrowserCaptureOptions = { ...options, verifyStability };
  const images: CaptureImage[] = [];
  const geometry: GeometryRect[] = [];
  const deterministicFindings: DeterministicFinding[] = [];
  const declinedFindings: DeterministicFinding[] = [];
  const objectKeys: string[] = [];
  const consoleEvents: Array<{ level: string; text: string }> = [];
  const failedRequests: Array<{ url: string; status: number | null }> = [];
  const fonts: Array<{ family: string; status: string }> = [];
  const pageText: Record<string, string> = {};
  let unstable = false;
  let pagesCompared = 0;
  let unstablePages = 0;

  for (const route of ctx.routes) {
    for (const viewport of ctx.viewports) {
      const size = VIEWPORT_SIZES[viewport];
      const context = await deps.browser.newContext({
        viewport: size,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        colorScheme: ctx.darkMode ? "dark" : "light",
      });
      try {
        const page = await context.newPage();
        const outcome = await capturePage(page, routeUrl(baseUrl, route), size.height, pageOptions);

        const key = `${prefix}/${routeSlug(route)}/${viewport}.png`;
        await deps.sink.put(key, outcome.png, { contentType: "image/png" });
        objectKeys.push(key);

        const dimensions = pngDimensions(outcome.png);
        images.push({ route, viewport, objectKey: key, ...dimensions });

        // The checks run BEFORE the geometry map is serialized, because the map
        // has to contain every element they measured. The check set is wider
        // than the landmark set (overflow and contrast run over text nodes), and
        // an element the engine published a measured fact about has to be
        // citable, or the grounding gate (#32) deletes the model's finding about
        // the very measurement this run handed it. See `serializeGeometry`.
        const pageMetrics = buildPageMetrics(outcome.extracted, route, viewport);
        const allFindings = deterministicChecks({
          textNodes: toTextNodeStyles(outcome.extracted, route, viewport),
          interactive: toInteractiveElements(outcome.extracted, route, viewport),
          ...(pageMetrics ? { pages: [pageMetrics] } : {}),
          // Judge-unlock (§4.1): also collect the measurements the checks looked
          // at and declined, split out below.
          includeDeclined: true,
        });
        // A declined measurement (`reported: false`) is byte-invisible to today's
        // callers: `deterministicFindings` stays the REPORTED set, so the prompt
        // fact list, the wire report and every consumer that counts findings are
        // unchanged. The declined set travels on its own field.
        const pageFindings = allFindings.filter((f) => f.reported !== false);
        const pageDeclined = allFindings.filter((f) => f.reported === false);
        deterministicFindings.push(...pageFindings);
        declinedFindings.push(...pageDeclined);

        const rawElements = toRawGeometryElements(outcome.extracted, route, viewport);
        // The map pins every measured element, INCLUDING the declined ones (§2.4
        // T0), so a repo-rule finding on a WCAG-excused control is groundable.
        for (const entry of serializeGeometry(rawElements, [...pageFindings, ...pageDeclined])) {
          geometry.push({
            route: entry.route,
            viewport: entry.viewport,
            selector: entry.selector,
            role: entry.role,
            rect: entry.rect,
            ...(entry.style !== undefined ? { style: entry.style } : {}),
            ...(entry.label !== undefined ? { label: entry.label } : {}),
            ...(entry.overflowsX !== undefined ? { overflowsX: entry.overflowsX } : {}),
          });
        }

        consoleEvents.push(...outcome.console);
        failedRequests.push(...outcome.failedRequests);
        fonts.push(...outcome.extracted.fonts);
        // Page text is viewport-independent; the first captured viewport wins.
        pageText[route] ??= outcome.extracted.bodyText;
        unstable = unstable || outcome.unstable;
        if (verifyStability) {
          pagesCompared += 1;
          if (outcome.unstable) unstablePages += 1;
        }
      } finally {
        await context.close();
      }
    }
  }

  const stability = verifyStability ? { pagesCompared, unstablePages } : null;
  return {
    images,
    geometry,
    // The counts go INSIDE page health as well as beside the capture, because
    // page health is the part of a capture that crosses every wire this engine
    // has: the capture-service response, and the footnote a consumer reads.
    // Left only on the result, a check that ran would still be invisible to
    // anyone who did not capture in this process.
    pageHealth: buildPageHealth({
      console: consoleEvents,
      failedRequests,
      unstable,
      fonts,
      ...(stability ? { stability } : {}),
    }),
    captureVersion: BROWSER_CAPTURE_VERSION,
    deterministicFindings,
    declinedFindings,
    objectKeys,
    pageText,
    stability,
  };
}

/**
 * Build the `page_overflow` input for one captured page (judge-unlock §3.5), or
 * `null` when the capture did not report the page-level fields (a service too old
 * to measure them, which reads as "not measured", never "clean").
 */
function buildPageMetrics(
  extracted: ExtractedPage,
  route: string,
  viewport: Viewport,
): PageMetrics | null {
  if (extracted.documentWidth === undefined || extracted.viewportWidth === undefined) return null;
  return {
    route,
    viewport,
    viewportWidthPx: extracted.viewportWidth,
    documentScrollWidthPx: extracted.documentWidth,
    ...(extracted.rootScrollsX !== undefined ? { rootScrollsX: extracted.rootScrollsX } : {}),
    ...(extracted.overflowOffenders !== undefined ? { offenders: extracted.overflowOffenders } : {}),
  };
}

/** Partially apply the deps, yielding the `captureInSandbox(url, ctx)` seam. */
export function createBrowserCapture(
  deps: BrowserCaptureDeps,
  options: BrowserCaptureOptions = {},
): (url: string, ctx: CaptureContext) => Promise<BrowserCaptureResult> {
  return (url, ctx) => captureWithBrowser(url, ctx, deps, options);
}

/** Render deterministic findings for one route as prompt fact lines (#19). */
export function factsForRoute(findings: DeterministicFinding[], route: string): string[] {
  return findings
    // A declined measurement is not a reported fact; it travels on its own block.
    .filter((f) => f.route === route && f.reported !== false)
    .map((f) => `- [${f.kind}] ${f.selector} (${f.viewport}): ${f.detail}`);
}

/**
 * Render the DECLINED measurements for one route as the prompt's "MEASURED AND
 * DECLINED" lines (judge-unlock §3.3/§4.1). These are the checks that looked at
 * an element and did not report a violation because a universal-standard
 * exception applied; the repository's own rule may be stricter, so they are the
 * model's territory. Kept off the wire and out of the duplicate gate.
 */
export function declinedForRoute(declined: DeterministicFinding[], route: string): string[] {
  return declined
    .filter((f) => f.route === route && f.reported === false)
    .map(
      (f) =>
        `- [${f.kind}] ${f.selector} (${f.viewport}): ${f.detail}` +
        (f.declineReason ? ` [declined: ${f.declineReason}]` : ""),
    );
}

/**
 * The measured BREAKAGE for one route, as the triage pass's
 * `deterministicBreakage` lines (#19).
 *
 * Same source as `factsForRoute` and a strict subset of it: these are the
 * measurements that mean the page came apart (see `BREAKAGE_KINDS`), and the
 * triage pass treats them as grounds to run a deep review whatever the cheap
 * model thought. Deduplicated across viewports, because the same overflowing
 * element measured at three widths is one broken element, and the reason a deep
 * review has to happen does not get three times truer for being restated.
 * Deterministic order: first measurement wins.
 */
export function breakageForRoute(findings: DeterministicFinding[], route: string): string[] {
  const lines = new Set<string>();
  for (const finding of findings) {
    if (finding.route !== route || finding.reported === false || !isBreakage(finding)) continue;
    lines.add(`[${finding.kind}] ${route} ${finding.selector}: ${finding.detail}`);
  }
  return [...lines];
}

/** Viewports captured for a route, for callers building `CaptureContext`. */
export function defaultViewports(): Viewport[] {
  return ["mobile", "tablet", "desktop"];
}
