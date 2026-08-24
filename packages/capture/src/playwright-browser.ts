import type { Browser, BrowserContext, Page } from "playwright-core";
import type { CaptureBrowser, CaptureBrowserContext, CapturePage } from "./browser-port.js";
import { fontStabilityLaunchFlags } from "./font-policy.js";

/**
 * Binds a real Chromium (via `playwright-core`) to the `CaptureBrowser` port.
 * This is the ONLY module in the package that knows a browser library exists;
 * everything else (the lifecycle, the extraction, the checks) is driven
 * through the port and tested against a fake.
 *
 * `playwright-core` is imported dynamically so that merely importing
 * `@apatureai/verdict-capture` (which `@apatureai/verdict-critique` does, for the pixel budgets) never
 * loads a browser library. The browser BINARY is a separate, explicit install:
 *
 *   pnpm exec playwright-core install chromium
 *
 * Launch flags come from `fontStabilityLaunchFlags()` (#83): text rendering has
 * to be identical across runs or the perceptual-stability check churns.
 */

export interface LaunchCaptureBrowserOptions {
  /** Run with a visible window (debugging). Defaults to headless. */
  headed?: boolean;
  /** Extra Chromium flags appended after the font-stability flags. */
  args?: string[];
  /** Launch timeout in ms. */
  timeoutMs?: number;
}

/** Wait `ms` on the Node side, unaffected by the page's pinned clock. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * In-page layout-stability wait: resolve once no `layout-shift` entry has been
 * recorded for `quietMs`, or `timeoutMs` elapses. Never `networkidle` (#12).
 */
function layoutStableExpression(quietMs: number, timeoutMs: number): string {
  return `new Promise((resolve) => {
    let last = performance.now();
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) last = performance.now();
      });
      observer.observe({ type: "layout-shift", buffered: true });
    } catch (_) { /* layout-shift unsupported: fall back to the quiet window */ }
    const started = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - last >= ${quietMs} || now - started >= ${timeoutMs}) {
        if (observer) observer.disconnect();
        resolve(null);
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  })`;
}

function adaptPage(page: Page, context: BrowserContext): CapturePage {
  const consoleEvents: Array<{ level: string; text: string }> = [];
  const failedRequests: Array<{ url: string; status: number | null }> = [];

  page.on("console", (message) => {
    consoleEvents.push({ level: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => {
    consoleEvents.push({ level: "error", text: error.message });
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({ url: request.url(), status: null });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() });
  });

  return {
    clock: {
      install: (options) => page.clock.install({ time: options.time }),
      pauseAt: (time) => page.clock.pauseAt(time),
    },
    async goto(url, options) {
      await page.goto(url, { waitUntil: options.waitUntil, timeout: options.timeout });
    },
    async waitForSelector(selector, options) {
      await page.waitForSelector(selector, { timeout: options.timeout });
    },
    async addStyleTag(content) {
      // A page that navigated away mid-injection is not a capture failure; the
      // sheet is re-injected after the scroll anyway.
      await page.addStyleTag({ content }).catch(() => undefined);
    },
    async emulateReducedMotion() {
      await page.emulateMedia({ reducedMotion: "reduce" });
    },
    async freezeAnimations() {
      // Primary, specificity-proof freeze: pause the engine's animation timeline.
      try {
        const session = await context.newCDPSession(page);
        await session.send("Animation.enable");
        await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
        await session.detach();
      } catch {
        // Non-chromium or CDP unavailable; the Web Animations pause below still applies.
      }
      await page
        .evaluate("(document.getAnimations ? document.getAnimations().forEach((a) => a.pause()) : null, null)")
        .catch(() => undefined);
    },
    evaluate<R>(expression: string): Promise<R> {
      return page.evaluate(expression) as Promise<R>;
    },
    async waitForFontsReady() {
      await page.evaluate("document.fonts ? document.fonts.ready.then(() => null) : null").catch(() => undefined);
    },
    async waitForLayoutStable(options) {
      await page.evaluate(layoutStableExpression(options.quietMs, options.timeoutMs)).catch(() => undefined);
    },
    wait: delay,
    async screenshot(options) {
      return page.screenshot({ fullPage: options.fullPage, type: "png", animations: "disabled" });
    },
    consoleEvents: () => [...consoleEvents],
    failedRequests: () => [...failedRequests],
    close: () => page.close(),
  };
}

function adaptContext(context: BrowserContext): CaptureBrowserContext {
  return {
    async newPage() {
      return adaptPage(await context.newPage(), context);
    },
    close: () => context.close(),
  };
}

/** Adapt an already-launched Playwright browser to the capture port. */
export function adaptPlaywrightBrowser(browser: Browser): CaptureBrowser {
  return {
    async newContext(options) {
      return adaptContext(
        await browser.newContext({
          viewport: options.viewport,
          deviceScaleFactor: options.deviceScaleFactor,
          colorScheme: options.colorScheme,
          reducedMotion: "reduce",
        }),
      );
    },
    close: () => browser.close(),
  };
}

/**
 * Launch headless Chromium for capture. Throws a message naming the install
 * command when the browser binary has not been downloaded, the single most
 * common first failure.
 */
export async function launchChromiumCaptureBrowser(
  options: LaunchCaptureBrowserOptions = {},
): Promise<CaptureBrowser> {
  const { chromium } = await import("playwright-core");
  try {
    const browser = await chromium.launch({
      headless: options.headed !== true,
      args: [...fontStabilityLaunchFlags(), ...(options.args ?? [])],
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    });
    return adaptPlaywrightBrowser(browser);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
      throw new Error(
        "Could not launch Chromium. Install the browser binary first:\n  pnpm exec playwright-core install chromium",
        { cause: error },
      );
    }
    throw error;
  }
}
