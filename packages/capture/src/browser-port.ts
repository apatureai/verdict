import type { Viewport } from "@apatureai/verdict-types";

/**
 * The browser surface the live capture worker drives (TRD §4.1). Playwright's
 * own `Page`/`BrowserContext` types are large, overloaded and chromium-specific;
 * this port is the narrow subset capture actually uses, so:
 *
 * - `@apatureai/verdict-capture` has no compile-time coupling to a browser library, and
 * - the whole capture path is unit-testable against a fake page (no browser).
 *
 * `playwright-browser.ts` binds a real Chromium to this port.
 */

/** CSS-pixel viewport sizes captured for each named breakpoint (TRD §4: 3 viewports at DSF 2). */
export const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
};

/** Device scale factor every capture runs at. */
export const DEVICE_SCALE_FACTOR = 2;

/** Raw element record produced by the in-page extractor (pre-normalization). */
export interface ExtractedElement {
  tag: string;
  id: string | null;
  testId: string | null;
  role: string | null;
  cssPath: string;
  rect: { x: number; y: number; width: number; height: number };
  animated: boolean;
  /** Present for text-bearing elements; drives the deterministic contrast check. */
  text?: {
    fontSizePx: number;
    fontWeight: number;
    color: string;
    /**
     * `background-color` of the element and each ancestor, nearest first, up to
     * and including the first fully opaque one. Raw and unresolved on purpose:
     * flattening it is a pure decision made in `toTextNodeStyles`.
     */
    backgroundStack: string[];
    /**
     * The computed `background-image` of each layer in `backgroundStack`, same
     * order, `"none"` where a layer paints no image.
     *
     * Raw and unresolved for the same reason the colours are: whether an image
     * is a photograph or a `linear-gradient(#ffffff, #eaf2ff)` whose endpoints
     * are ordinary sRGB colours is a parsing question, and it is answered in
     * `toTextNodeStyles`, where it is testable without a browser.
     *
     * Optional for the deploy-skew reason, and absent is UNKNOWN: a capture
     * that reports an obscured backdrop without saying what obscured it gets
     * the old answer, which is that the backdrop is not computable.
     */
    backgroundImages?: string[];
    /**
     * True when anything in that stack applies a `backdrop-filter`.
     *
     * Split out from `backdropObscured` because it is the half that can never
     * be computed: a filter's output depends on the pixels it samples. A
     * gradient resolves to its stops; a blur resolves to nothing, so a filtered
     * backdrop is declined whatever else the stack paints.
     *
     * Optional and UNKNOWN-when-absent, which also declines.
     */
    backdropFiltered?: boolean;
    /**
     * True when anything in that stack paints a `background-image` or a
     * `backdrop-filter`, which a flattened colour cannot represent. Optional
     * because the capture fleet deploys separately from the engine; absent is
     * UNKNOWN, and an unknown backdrop is measured and reported without being
     * gateable. A KNOWN-obscured one is not measured at all: the ratio would be
     * wrong, and a wrong number published as a measurement is worse than none.
     */
    backdropObscured?: boolean;
    contentWidthPx: number;
    /**
     * Computed `overflow-x`. Optional for the same reason, and absent is
     * UNKNOWN, never `visible`: a deliberate scroll container must not become
     * gateable just because an older capture did not say what it was.
     */
    overflowX?: string;
    /**
     * True when some ANCESTOR of this element scrolls horizontally
     * (`overflow-x: auto | scroll | overlay`).
     *
     * The element's own `overflow-x` does not settle the question. The two
     * commonest scrollers in real markup wrap the text rather than carry it: a
     * `<div class="table-wrap">` around a wide row, and a code block inside a
     * scrolling shell. The overflowing paragraph inside one of those computes
     * `overflow-x: visible` and looks exactly like a page coming apart, while
     * the reader can reach every pixel of it.
     *
     * Optional for the same deploy-skew reason, and absent is UNKNOWN, which
     * costs block-eligibility rather than being read as `false`.
     */
    ancestorScrollsX?: boolean;
    /**
     * Computed `text-overflow`. `clip` (the initial value) means the excess is
     * cut with no mark; anything else (`ellipsis`, or a custom string) is an
     * affordance the reader can see, which is the signature of a deliberate
     * truncation rather than lost content.
     *
     * Optional for the deploy-skew reason, and absent is UNKNOWN, never `clip`:
     * a capture that cannot say whether an affordance was rendered must not
     * make a clip gateable.
     */
    textOverflow?: string;
    /**
     * Computed `white-space`. `text-overflow` only renders on content that does
     * not wrap, so `nowrap`/`pre` is the other half of the truncation signature.
     *
     * Optional and UNKNOWN-when-absent, for the same reason.
     */
    whiteSpace?: string;
  } | null;
  /** True for elements a pointer can target (button/a/input/[role=button]…). */
  interactive: boolean;
  /**
   * True when this pointer target is an inline element sitting in a run of
   * non-target text: a link inside a sentence.
   *
   * Both target-size criteria exempt exactly this shape (WCAG 2.2 SC 2.5.8 and
   * SC 2.5.5, "Inline"), because such a target's height is set by the
   * line-height of the prose around it and enlarging it would break the
   * paragraph. Measuring it against 24x24 reports a failure the criterion does
   * not describe.
   *
   * Only meaningful when `interactive` is true. Optional for the deploy-skew
   * reason, and absent is UNKNOWN: the finding is reported and not gateable,
   * because an unevaluated exception could be the whole of it.
   */
  inlineTarget?: boolean;
}

/** Everything one `page.evaluate` round-trip brings back. */
export interface ExtractedPage {
  elements: ExtractedElement[];
  fonts: Array<{ family: string; status: string }>;
  documentHeight: number;
  /**
   * Visible body text, truncated. UNTRUSTED (#53): it is fenced in the prompt
   * and governed by the instruction-hierarchy rule, never treated as instructions.
   */
  bodyText: string;
  /**
   * The color the root element composites over: white for the default UA canvas,
   * `null` when the page opted into a dark color-scheme and the shade is a UA
   * implementation detail. `null` propagates to "unknown backdrop", which makes
   * the contrast check stay silent instead of publishing a guess.
   */
  canvasBackground: string | null;
}

export interface CapturePage {
  /** Playwright's `page.clock`: install before navigation, pause after readiness. */
  clock: {
    install(options: { time: number }): Promise<void>;
    pauseAt(time: number): Promise<void>;
  };
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<void>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<void>;
  addStyleTag(content: string): Promise<void>;
  emulateReducedMotion(): Promise<void>;
  /** Pause every running animation (CDP playback rate 0 + Web Animations pause). */
  freezeAnimations(): Promise<void>;
  /** Evaluate a JS expression in the page and return its (JSON-serializable) value. */
  evaluate<R>(expression: string): Promise<R>;
  /** Resolve when `document.fonts.ready` resolves. */
  waitForFontsReady(): Promise<void>;
  /** Resolve after no layout shift for `quietMs`, or at `timeoutMs`. */
  waitForLayoutStable(options: { quietMs: number; timeoutMs: number }): Promise<void>;
  wait(ms: number): Promise<void>;
  screenshot(options: { fullPage: boolean }): Promise<Uint8Array>;
  /** Console messages seen so far, in order. */
  consoleEvents(): Array<{ level: string; text: string }>;
  /** Requests that failed or returned >= 400. */
  failedRequests(): Array<{ url: string; status: number | null }>;
  close(): Promise<void>;
}

export interface CaptureBrowserContext {
  newPage(): Promise<CapturePage>;
  close(): Promise<void>;
}

export interface CaptureBrowser {
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    colorScheme: "light" | "dark";
  }): Promise<CaptureBrowserContext>;
  close(): Promise<void>;
}

/** Where captured PNG bytes are written. `ObjectStore` from `@apatureai/verdict-storage` satisfies it. */
export interface ScreenshotSink {
  put(key: string, body: Uint8Array, options?: { contentType?: string }): Promise<void>;
}
