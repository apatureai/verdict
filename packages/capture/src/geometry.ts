import type { StyleDigest, Viewport } from "@apatureai/verdict-types";
import { VIEWPORT_SIZES } from "./browser-port.js";
import type { DeterministicFinding, Rect } from "./checks.js";

/**
 * DOM geometry map (TRD §4.2/§6.5; judge-unlock spec §2.4). Element rects are
 * serialized as stable `{selector, role, rect, style, label, overflowsX}` entries
 * so the model picks an `element_ref` and CODE draws the annotation box from the
 * real rect; we never trust VLM pixel coordinates. Animated elements are flagged
 * so the phash stability gate (#15) can exclude them.
 *
 * The historic map carried LANDMARKS ∪ MEASURED elements only. That was the F3
 * failure the judge-unlock diagnosed: `table`, `section`, `header`, `footer`,
 * `main` and every card/bar whose padding is off-scale were never in the map, so
 * five of the six real defect classes were physically underivable. The selection
 * rule below (`selectSignificant`) replaces the landmark-or-measured filter with
 * SIGNIFICANCE TIERS, so a table wider than the viewport, a nav, a heading, or an
 * interactive control can never be silently omitted, while a pathological DOM is
 * still bounded by a deterministic, documented budget.
 *
 * The grounding invariant is unchanged and strengthened: every selector the map
 * carries was really extracted and rect-recorded, so the gate (#32) still deletes
 * anything the model invents. The map is wider; the gate is not looser.
 *
 * The browser-side `getBoundingClientRect` extraction is the worker seam; this
 * module is the pure selection/serialization, fully testable without a browser.
 */

/** Raw element as captured by the in-page extractor. */
export interface RawGeometryElement {
  route: string;
  viewport: Viewport;
  /** Lowercased tagName. */
  tag: string;
  id?: string | null;
  testId?: string | null;
  /** Explicit ARIA role, if any. */
  role?: string | null;
  /** Deterministic CSS path from the extractor, used when id/testId are absent. */
  cssPath?: string | null;
  rect: Rect;
  /** Flagged by the extractor (CSS animation/transition or known carousel). */
  animated?: boolean;
  /** Exact computed-style digest (spec §2.2); absent leaves the entry style-less. */
  style?: StyleDigest;
  /** The element's OWN text, raw; sanitized into `GeometryEntry.label` here (§2.6). */
  ownText?: string;
  /** True when the element's own or ancestor box escapes the viewport (§2.4 T1). */
  overflowsX?: boolean;
  /** True when this element is a pointer target (spec §2.4 T2). */
  interactive?: boolean;
}

export interface GeometryEntry {
  route: string;
  viewport: Viewport;
  selector: string;
  role: string;
  rect: Rect;
  animated: boolean;
  /** Exact computed-style digest (spec §2.2), when the extractor reported one. */
  style?: StyleDigest;
  /** Sanitized own-text label (spec §2.6), when the element bears its own text. */
  label?: string;
  /** True when the element contributes to a horizontal overflow (spec §2.4 T1). */
  overflowsX?: boolean;
}

const LANDMARK_TAGS = new Set([
  "nav",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "button",
  "input",
  "select",
  "textarea",
  "a",
]);

const LANDMARK_ROLES = new Set(["navigation", "heading", "button", "textbox", "link"]);

/**
 * The structural landmark tags the significance selector treats as a mandatory
 * tier (spec §2.4 T3). Superset of `LANDMARK_TAGS`: the historic landmark set was
 * the navigation vocabulary, this adds the page-structure vocabulary (`main`,
 * `header`, `footer`, `section`, `article`, `aside`, `form`, `table`, `dialog`,
 * `figure`, `img`) that the F3 failure omitted.
 */
const STRUCTURAL_LANDMARK_TAGS = new Set([
  ...LANDMARK_TAGS,
  "main",
  "header",
  "footer",
  "section",
  "article",
  "aside",
  "form",
  "table",
  "dialog",
  "figure",
  "img",
]);

/** Interactive tags/roles (spec §2.4 T2). */
const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "summary"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "checkbox",
  "switch",
  "slider",
]);

const LAYOUT_DISPLAYS = new Set(["flex", "inline-flex", "grid", "inline-grid"]);

/** Map a tag to its implicit ARIA role; explicit role wins. */
export function normalizeRole(el: RawGeometryElement): string {
  if (el.role) return el.role;
  if (el.tag === "nav") return "navigation";
  if (/^h[1-6]$/.test(el.tag)) return "heading";
  if (el.tag === "button") return "button";
  if (el.tag === "input" || el.tag === "select" || el.tag === "textarea") return "textbox";
  if (el.tag === "a") return "link";
  return "generic";
}

export function isLandmark(el: RawGeometryElement): boolean {
  return LANDMARK_TAGS.has(el.tag) || (el.role !== null && el.role !== undefined && LANDMARK_ROLES.has(el.role));
}

/** Build a stable selector: id > data-testid > extractor cssPath > tag. */
export function stableSelector(el: RawGeometryElement): string {
  if (el.id) return `#${el.id}`;
  if (el.testId) return `[data-testid="${el.testId}"]`;
  if (el.cssPath) return el.cssPath;
  return el.tag;
}

/**
 * Identity of one measurement target: a selector is only groundable on the
 * (route, viewport) it was actually measured on. An overflow measured on
 * `/pricing` at desktop says nothing about the same selector on `/` at mobile,
 * so the key carries all three and the widening cannot leak across pages.
 */
function measurementKey(route: string, viewport: Viewport, selector: string): string {
  return `${route}\n${viewport}\n${selector}`;
}

/**
 * Whether a deterministic check measured this exact element on this exact page.
 * Such an element is groundable whether or not it is a landmark: the engine has
 * already published a measured fact naming it. `page_overflow` uses the reserved
 * `"document"` ref and is deliberately NOT a per-element measurement, so it never
 * pins an element into the map.
 */
export function isMeasured(el: RawGeometryElement, measuredKeys: ReadonlySet<string>): boolean {
  return measuredKeys.has(measurementKey(el.route, el.viewport, stableSelector(el)));
}

/** The measurement keys of a set of deterministic findings (#19). */
export function measuredKeys(findings: readonly DeterministicFinding[]): Set<string> {
  const keys = new Set<string>();
  for (const f of findings) {
    if (f.selector === "document") continue; // page-level, not a per-element pin
    keys.add(measurementKey(f.route, f.viewport, f.selector));
  }
  return keys;
}

/** Sanitize page-derived own-text into a prompt-safe label (spec §2.6). */
export function sanitizeLabel(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const neutralized = text
    // Strip the untrusted-content fence tokens so a label cannot forge the boundary.
    .replace(/<\/?untrusted_page_content>/gi, "")
    // Collapse all whitespace (incl. CR/LF/TAB) to single spaces.
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    // Strip backticks/quotes that could forge the geometry line's own format.
    .replace(/[`"']/g, "")
    .trim();
  if (neutralized.length === 0) return undefined;
  return neutralized.slice(0, 48);
}

/** The default per-viewport entry budget for the capture-time selection (spec §2.4). */
export const MAX_GEOMETRY_ENTRIES_PER_VIEWPORT = 160;

/** A stable signature for a style digest, so a rare digest can be scored (spec §2.4). */
function styleSignature(style: StyleDigest | undefined): string | null {
  if (!style) return null;
  return JSON.stringify([
    style.fontFamily,
    style.fontSizePx,
    style.fontWeight,
    style.color,
    style.backgroundColor,
    style.paddingPx,
    style.marginPx,
    style.borderRadiusPx,
  ]);
}

/** Depth proxy from the css path: deeper elements are less structural (spec §2.4). */
function depthOf(el: RawGeometryElement): number {
  if (!el.cssPath) return 0;
  return el.cssPath.split(" > ").length - 1;
}

const TIER_MEASURED = 0;
const TIER_OVERFLOW = 1;
const TIER_INTERACTIVE = 2;
const TIER_LANDMARK = 3;
const TIER_TEXT = 4;
const TIER_LAYOUT = 5;
/** Anything with a positive discretionary significance score. */
const TIER_DISCRETIONARY = 6;

function isInteractiveEl(el: RawGeometryElement): boolean {
  if (el.interactive === true) return true;
  if (INTERACTIVE_TAGS.has(el.tag)) return true;
  return el.role !== null && el.role !== undefined && INTERACTIVE_ROLES.has(el.role);
}

function isStructuralLandmark(el: RawGeometryElement): boolean {
  return (
    STRUCTURAL_LANDMARK_TAGS.has(el.tag) ||
    (el.role !== null && el.role !== undefined && LANDMARK_ROLES.has(el.role))
  );
}

function isLayoutContainer(el: RawGeometryElement, viewport: Viewport): boolean {
  const display = el.style?.display;
  if (display === undefined || display === null || !LAYOUT_DISPLAYS.has(display)) return false;
  const size = VIEWPORT_SIZES[viewport];
  if (!size) return false;
  const area = el.rect.width * el.rect.height;
  return area >= 0.02 * size.width * size.height;
}

/** The mandatory tier an element belongs to, or `TIER_DISCRETIONARY` when none. */
function tierOf(el: RawGeometryElement, keys: ReadonlySet<string>): number {
  if (isMeasured(el, keys)) return TIER_MEASURED;
  if (el.overflowsX === true) return TIER_OVERFLOW;
  if (isInteractiveEl(el)) return TIER_INTERACTIVE;
  if (isStructuralLandmark(el)) return TIER_LANDMARK;
  if (el.ownText !== undefined && el.ownText.trim().length > 0) return TIER_TEXT;
  if (isLayoutContainer(el, el.viewport)) return TIER_LAYOUT;
  return TIER_DISCRETIONARY;
}

/**
 * A pure, deterministic significance score for the discretionary fill (spec §2.4).
 * Only elements the extractor RICHLY captured (a style digest is present) are
 * discretionary-eligible: an element with no digest carries no design signal a
 * reviewer can act on, and admitting it would only spend the budget. In
 * production every extracted element carries a digest, so "discretionary" is
 * "everything else" exactly as the spec states.
 */
export function significanceScore(el: RawGeometryElement, rareSignatures: ReadonlySet<string>): number {
  const size = VIEWPORT_SIZES[el.viewport];
  const areaShare = size
    ? Math.min(1, (el.rect.width * el.rect.height) / (size.width * size.height))
    : 0;
  const textBearing = el.ownText !== undefined && el.ownText.trim().length > 0 ? 1 : 0;
  const sig = styleSignature(el.style);
  const rare = sig !== null && rareSignatures.has(sig) ? 1 : 0;
  return 3 * areaShare + 1.0 * textBearing + 0.5 * rare - 0.15 * depthOf(el);
}

function toEntry(el: RawGeometryElement): GeometryEntry {
  const label = sanitizeLabel(el.ownText);
  return {
    route: el.route,
    viewport: el.viewport,
    selector: stableSelector(el),
    role: normalizeRole(el),
    rect: el.rect,
    animated: el.animated ?? false,
    ...(el.style !== undefined ? { style: el.style } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(el.overflowsX !== undefined ? { overflowsX: el.overflowsX } : {}),
  };
}

export interface SelectSignificantOptions {
  /** Per-viewport entry cap. Defaults to `MAX_GEOMETRY_ENTRIES_PER_VIEWPORT`. */
  maxEntriesPerViewport?: number;
}

export interface SelectionResult {
  entries: GeometryEntry[];
  /** Discretionary entries dropped because a viewport hit its budget. */
  omittedByBudget: number;
}

/**
 * The significance-tier selection (spec §2.4). Mandatory tiers (measured,
 * overflow contributors, interactive, landmarks, text-bearing, layout
 * containers) are NEVER trimmed; discretionary elements fill the remaining budget
 * ordered by `significanceScore`. If the mandatory tiers alone exceed a
 * viewport's budget, every mandatory entry is kept and all discretionary ones are
 * dropped — the map never silently loses a significant element, and the count of
 * dropped discretionary entries is returned so a caller can disclose it.
 *
 * Deterministic: ties break by tier, then document (input) order.
 */
export function selectSignificant(
  elements: RawGeometryElement[],
  measured: readonly DeterministicFinding[] = [],
  options: SelectSignificantOptions = {},
): SelectionResult {
  const budget = options.maxEntriesPerViewport ?? MAX_GEOMETRY_ENTRIES_PER_VIEWPORT;
  const keys = measuredKeys(measured);

  // Census of style signatures for the rare-digest score.
  const signatureCounts = new Map<string, number>();
  for (const el of elements) {
    const sig = styleSignature(el.style);
    if (sig !== null) signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);
  }
  const rareSignatures = new Set<string>();
  for (const [sig, count] of signatureCounts) if (count <= 2) rareSignatures.add(sig);

  // Annotate each element with its tier + input index (for stable ordering).
  const annotated = elements.map((el, index) => ({ el, index, tier: tierOf(el, keys) }));

  // Group by viewport, preserving first-seen viewport order across the output.
  const viewportOrder: Viewport[] = [];
  const byViewport = new Map<Viewport, typeof annotated>();
  for (const a of annotated) {
    let bucket = byViewport.get(a.el.viewport);
    if (!bucket) {
      bucket = [];
      byViewport.set(a.el.viewport, bucket);
      viewportOrder.push(a.el.viewport);
    }
    bucket.push(a);
  }

  const entries: GeometryEntry[] = [];
  let omittedByBudget = 0;

  for (const viewport of viewportOrder) {
    const bucket = byViewport.get(viewport) ?? [];
    const mandatory = bucket.filter((a) => a.tier !== TIER_DISCRETIONARY);
    const discretionary = bucket
      .filter((a) => a.tier === TIER_DISCRETIONARY && a.el.style !== undefined)
      .map((a) => ({ ...a, score: significanceScore(a.el, rareSignatures) }))
      .filter((a) => a.score > 0)
      .sort((x, y) => y.score - x.score || x.index - y.index);

    // Mandatory first, always, in input order (which is capture order: landmarks
    // then measured, both deterministic given a deterministic capture).
    const kept = mandatory.sort((x, y) => x.index - y.index).map((a) => a.el);

    let remaining = Math.max(0, budget - kept.length);
    for (const cand of discretionary) {
      if (remaining <= 0) {
        omittedByBudget += 1;
        continue;
      }
      kept.push(cand.el);
      remaining -= 1;
    }

    // Re-sort the viewport's kept set back into input order so the block reads
    // top-to-bottom of the document.
    const orderIndex = new Map(bucket.map((a) => [a.el, a.index] as const));
    kept.sort((x, y) => (orderIndex.get(x) ?? 0) - (orderIndex.get(y) ?? 0));
    for (const el of kept) entries.push(toEntry(el));
  }

  return { entries, omittedByBudget };
}

/**
 * Serialize the significant elements into stable geometry entries (spec §2.4).
 * Thin wrapper over `selectSignificant` that keeps the historic signature every
 * existing caller uses; the budget and discretionary-fill semantics live in
 * `selectSignificant`.
 */
export function serializeGeometry(
  elements: RawGeometryElement[],
  measured: readonly DeterministicFinding[] = [],
): GeometryEntry[] {
  return selectSignificant(elements, measured).entries;
}

/** The animated subset, for the phash exclusion list (#15). */
export function animatedExclusions(entries: GeometryEntry[]): GeometryEntry[] {
  return entries.filter((e) => e.animated);
}
