import type { Viewport } from "./findings.js";

/**
 * Capture sandbox contract (TRD §4, §5). Everything runs behind
 * `captureInSandbox(url, ctx)`: one Firecracker microVM per job; the in-VPC
 * path runs the same interface in the customer cloud. Implementations own
 * Playwright, the readiness/stability protocol, egress policy, and storageState.
 */
export interface CaptureContext {
  installationId: string;
  /** Viewports to capture (TRD §4: 3 viewports at DSF 2 by default). */
  viewports: Viewport[];
  darkMode: boolean;
  /** Name of the KMS-stored storageState secret; decrypted in-VM only. */
  authStateSecretName?: string | null;
  /** Name of the KMS-stored protection-bypass secret. */
  protectionBypassSecretName?: string | null;
  /** storageState/auth is disabled when true (fork PRs). */
  isFork: boolean;
  /** Routes to capture. */
  routes: string[];
  /**
   * Capture each page twice and compare the PNG bytes (#15).
   *
   * This is the per-request form of the CLI's `--verify-stability`. It travels
   * on the capture CONTEXT because the context is the capture request body, so
   * a caller can now ask for the determinism check on one review instead of it
   * being an operator flag that applies to every job a server runs or to
   * nothing at all.
   *
   * Optional and additive in both directions. A capture service that predates
   * the field ignores it and reports no `pageHealth.stability`, which reads as
   * "not checked" rather than "verified stable"; a caller that never sets it
   * sends the same request body it always sent.
   */
  verifyStability?: boolean;
}

/**
 * What the repeat-capture determinism check actually compared (#15).
 *
 * Counts rather than a boolean, because the boolean already exists: a check
 * that ran and found nothing has to be distinguishable from a check that never
 * ran, and `unstable: false` cannot tell those apart on its own.
 */
export interface CaptureStability {
  pagesCompared: number;
  unstablePages: number;
}

export interface CaptureImage {
  route: string;
  viewport: Viewport;
  /** Object-storage key for the screenshot (engine-owned bucket). */
  objectKey: string;
  width: number;
  height: number;
}

/**
 * Compact computed-style digest for one element (judge-unlock, spec §2.2). Every
 * value is EXACT — read from `getComputedStyle` at capture time, never estimated
 * from pixels. This is the evidence the model needs to make a judgment the
 * deterministic checker cannot: a font-family violation, an off-scale spacing
 * value, an off-token colour. Optional/additive throughout: a capture service
 * too old to report it leaves the prompt byte-identical and the model is told the
 * styles are unavailable.
 */
export interface StyleDigest {
  /** First resolved family, quotes stripped, e.g. `Helvetica Neue`, `Georgia`, `SF Mono`. */
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  /** null when `normal`. */
  lineHeightPx: number | null;
  /** `#rrggbb` or `rgba(...)` when translucent. */
  color: string;
  /** The element's OWN background-color, `transparent` when none. Not the flattened stack. */
  backgroundColor: string;
  /** [top, right, bottom, left] in CSS px. */
  paddingPx: [number, number, number, number];
  marginPx: [number, number, number, number];
  /** `column-gap`/`row-gap` when the element is a flex/grid container, else null. */
  gapPx: [number, number] | null;
  /** Largest corner radius in CSS px. */
  borderRadiusPx: number;
  /** Only when it is not `block`/`inline` (i.e. flex, grid, inline-flex, …); else null. */
  display: string | null;
}

/** Recorded DOM geometry; element refs are grounded in real rects, not VLM pixels. */
export interface GeometryRect {
  route: string;
  viewport: Viewport;
  selector: string;
  role: string | null;
  rect: { x: number; y: number; width: number; height: number };
  /**
   * Exact computed-style digest for this element (judge-unlock, spec §2.2).
   * Absent on a capture-service too old to report it; absent leaves the prompt
   * byte-identical to today, and the model is told the styles are unavailable.
   */
  style?: StyleDigest;
  /**
   * First 48 chars of the element's OWN text, sanitized. Page-derived DATA
   * (spec §2.6), fenced as untrusted and never treated as instructions.
   */
  label?: string;
  /**
   * True when this element's border-box right edge exceeds the viewport width,
   * or its scrollWidth exceeds its clientWidth. Drives mandatory inclusion in
   * the geometry map (spec §2.4 T1). Absent is UNKNOWN, never `false`.
   */
  overflowsX?: boolean;
}

export interface PageHealth {
  consoleErrors: number;
  failedRequests: number;
  /** True when perceptual + structural hashes flag the page as unstable. */
  unstable: boolean;
  /**
   * Web fonts that did not finish loading after `document.fonts.ready` (#83).
   * The browser silently substituted a fallback, which `fonts.ready` can't
   * distinguish from a real font bug. Recorded so a substituted font is a
   * footnote, not a hallucinated "broken text" finding. Defaults to 0.
   */
  blockedFonts?: number;
  /**
   * The repeat-capture determinism check's own counts, or ABSENT when the check
   * did not run (`ctx.verifyStability` unset, or a capture service that does not
   * implement it).
   *
   * Absent means "not checked", never "checked and clean". `unstable: false`
   * with no `stability` beside it is only "nothing contradicted this"; the same
   * flag with `stability: { pagesCompared: 6, unstablePages: 0 }` is the
   * positive statement that six pages were captured twice and matched byte for
   * byte.
   */
  stability?: CaptureStability;
}

export interface Capture {
  images: CaptureImage[];
  geometry: GeometryRect[];
  pageHealth: PageHealth;
  captureVersion: string;
}

/** The capture seam (TRD §4). */
export type CaptureInSandbox = (url: string, ctx: CaptureContext) => Promise<Capture>;
