export {
  relativeLuminance,
  contrastRatio,
  contrastViolations,
  overflowViolations,
  classifyClip,
  touchTargetViolations,
  deterministicChecks,
  pageOverflowViolations,
  isBreakage,
  toMeasurementReport,
  ALL_MEASUREMENT_KINDS,
  BREAKAGE_KINDS,
  TOUCH_TARGET_CRITERIA,
  DEFAULT_TOUCH_TARGET_CRITERION,
  checksRunFor,
  contrastSeverity,
  overflowSeverity,
  touchTargetSeverity,
  TOUCH_VIEWPORTS,
  AA_TOUCH_TARGET_PX,
  AAA_TOUCH_TARGET_PX,
} from "./checks.js";
export type {
  Rect,
  TextNodeStyle,
  InteractiveElement,
  CheckKind,
  ClipVerdict,
  DeterministicFinding,
  DeterministicCheckInput,
  PageMetrics,
  TouchTargetCriterion,
  TouchTargetOptions,
  DeclineOptions,
} from "./checks.js";

export {
  parseCssColor,
  isOpaque,
  compositeOver,
  flattenBackground,
  parseGradientStops,
  flattenGradientBackdrops,
} from "./color.js";
export type { Rgba } from "./color.js";

export {
  PATCH_SIZE,
  DIMENSION_MULTIPLE,
  PIXEL_BUDGETS,
  fitToPixelBudget,
  fitForDepth,
  rescalePoint,
  rescaleRect,
} from "./downscale.js";
export type { ScaledDimensions, Point } from "./downscale.js";

export {
  CHROMIUM_MAX_DEVICE_PX,
  DEFAULT_TILE_OVERLAP,
  planCaptureSegments,
  planTiles,
} from "./tiling.js";
export type { CaptureSegment, Tile } from "./tiling.js";

export {
  normalizeRole,
  isLandmark,
  isMeasured,
  measuredKeys,
  stableSelector,
  serializeGeometry,
  selectSignificant,
  significanceScore,
  sanitizeLabel,
  MAX_GEOMETRY_ENTRIES_PER_VIEWPORT,
  animatedExclusions,
} from "./geometry.js";
export type {
  RawGeometryElement,
  GeometryEntry,
  SelectSignificantOptions,
  SelectionResult,
} from "./geometry.js";

export {
  hammingDistance,
  hashesWithin,
  runStabilityGate,
} from "./stability.js";
export type { StabilityOptions, StabilitySample, StabilityResult } from "./stability.js";

export {
  BASELINE_SSIM_THRESHOLD,
  BASELINE_DIFF_RATIO_THRESHOLD,
  BASELINE_PHASH_THRESHOLD,
  detectBaselineChange,
  allRoutesConfirmedUnchanged,
} from "./change-detection.js";
export type {
  TileChangeScore,
  BaselineChangeInput,
  BaselineChangeOptions,
  BaselineChangeReason,
  BaselineChangeDecision,
} from "./change-detection.js";

export { CAPTURE_EPOCH_MS, PRELOAD_SKEW_MS, withDeterministicClock } from "./capture-clock.js";
export type { PageClock, CapturePhases } from "./capture-clock.js";

export {
  MOTION_FREEZE_STYLESHEET,
  REDUCED_MOTION_MEDIA,
  freezeMotionForCapture,
} from "./motion-freeze.js";
export type { MotionFreezeInjector, MotionFreezePhases } from "./motion-freeze.js";

export {
  GOTO_BUDGET_MS,
  READY_WAIT_UNTIL,
  awaitPageReady,
  recheckFontsAfterScroll,
} from "./page-readiness.js";
export type { ReadinessOps, ReadinessOptions, ReadyWaitUntil } from "./page-readiness.js";

export {
  LAZY_SETTLE_MS,
  MAX_SCROLL_VIEWPORTS,
  autoScrollForLazyLoad,
} from "./lazy-load.js";
export type { LazyLoadOps, LazyLoadOptions, LazyLoadResult } from "./lazy-load.js";

export { planColorSchemeContexts, capturesDarkMode } from "./dark-mode.js";
export type { ColorScheme, ColorSchemeContext } from "./dark-mode.js";

export { runCaptureLifecycle } from "./capture-lifecycle.js";
export type {
  CaptureLifecycleOps,
  CaptureLifecycleOptions,
  CaptureLifecycleResult,
} from "./capture-lifecycle.js";

export { isPrivateOrReservedIp, evaluateEgress, checkEgressForHost, DomainBudget } from "./egress.js";
export type { EgressPolicyOptions, EgressDecision, DomainCaps, Resolver } from "./egress.js";

export { buildPageHealth, pageHealthFootnote, blockedFonts } from "./page-health.js";
export type { ConsoleEvent, FailedRequest, PageHealthInput, FontFaceStatus } from "./page-health.js";

export {
  DETERMINISTIC_FONTS,
  FONTCONFIG_FALLBACK_ORDER,
  FONT_RENDER_HINTING_FLAG,
  fontStabilityLaunchFlags,
} from "./font-policy.js";

export { decideStorageState, scopeCookiesToOrigin, originHost } from "./storage-state.js";
export type { StorageStateDecisionInput, StorageStateDecision, Cookie } from "./storage-state.js";

export { DEVICE_SCALE_FACTOR, VIEWPORT_SIZES } from "./browser-port.js";
export type {
  CaptureBrowser,
  CaptureBrowserContext,
  CapturePage,
  ExtractedElement,
  ExtractedPage,
  ScreenshotSink,
} from "./browser-port.js";

export {
  DOM_EXTRACT_EXPRESSION,
  resolvedBackground,
  resolvedGradientBackdrops,
  toInteractiveElements,
  toRawGeometryElements,
  toTextNodeStyles,
} from "./dom-extract.js";

export { pngDimensions } from "./png.js";
export type { PngDimensions } from "./png.js";

/**
 * The capture sandbox seam (TRD §4). `captureWithBrowser` is the live
 * implementation, driven through the injected `CaptureBrowser` port;
 * `launchChromiumCaptureBrowser` (in `./playwright-browser.js`, imported
 * separately so the browser library stays lazily loaded) binds a real Chromium
 * to that port.
 */
export {
  BROWSER_CAPTURE_VERSION,
  captureWithBrowser,
  createBrowserCapture,
  defaultViewports,
  factsForRoute,
  declinedForRoute,
  breakageForRoute,
  routeSlug,
  routeUrl,
  stabilityRequested,
} from "./browser-capture.js";
export type {
  BrowserCaptureDeps,
  BrowserCaptureOptions,
  BrowserCaptureResult,
  StabilityCheck,
} from "./browser-capture.js";
