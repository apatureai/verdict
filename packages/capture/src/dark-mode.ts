import type { CaptureContext, Viewport } from "@apatureai/verdict-types";

/**
 * Dark-mode capture planning (TRD §4.1/§4.2, #21). Dark mode must be captured
 * from a FRESH browser context with `emulateMedia({ colorScheme: "dark" })` set
 * BEFORE `goto`: CSS-in-JS (and `matchMedia` listeners that read the scheme at
 * mount) snapshot the scheme on first render and do NOT react to a post-load
 * toggle, so flipping the scheme after navigation captures a half-themed page.
 * Each scheme therefore gets its own context + its own navigation; light and
 * dark are never the same context re-emulated.
 *
 * Dark is captured ONLY when the repo declares dark-mode support
 * (`CaptureContext.darkMode`). Capturing a forced dark scheme on a light-only
 * site just renders the light theme under a dark OS hint and doubles the cost
 * for no signal.
 *
 * This module is the PURE plan: which `{viewport, colorScheme}` contexts to open
 * and in what order. Creating the context, `emulateMedia`, and the screenshot
 * are the live worker seam (#11); this is fully unit-testable with no browser.
 */

/** The two color schemes Playwright's `emulateMedia` can pin. */
export type ColorScheme = "light" | "dark";

/** One planned capture context: a fresh browser context per (viewport, scheme). */
export interface ColorSchemeContext {
  viewport: Viewport;
  colorScheme: ColorScheme;
  /**
   * Always true here as a contract reminder: the scheme is emulated on the fresh
   * context BEFORE goto. The worker (#11) must honor this: a post-goto toggle
   * misses mount-time CSS-in-JS.
   */
  emulateBeforeGoto: true;
}

/**
 * Plan the color-scheme capture contexts for a review. Light is always captured
 * for every viewport; dark is added for every viewport only when the repo
 * declares dark-mode support. Light precedes dark so the default theme is
 * captured first. Each entry is a SEPARATE fresh context (no re-emulation).
 */
export function planColorSchemeContexts(ctx: Pick<CaptureContext, "viewports" | "darkMode">): ColorSchemeContext[] {
  const schemes: ColorScheme[] = ctx.darkMode ? ["light", "dark"] : ["light"];
  const contexts: ColorSchemeContext[] = [];
  for (const colorScheme of schemes) {
    for (const viewport of ctx.viewports) {
      contexts.push({ viewport, colorScheme, emulateBeforeGoto: true });
    }
  }
  return contexts;
}

/** Whether a dark pass runs for this repo (repo must declare dark-mode support). */
export function capturesDarkMode(ctx: Pick<CaptureContext, "darkMode">): boolean {
  return ctx.darkMode === true;
}
