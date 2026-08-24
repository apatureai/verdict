import type { Viewport } from "@apatureai/verdict-types";
import type { DeterministicFinding, Rect } from "./checks.js";

/**
 * DOM geometry map (TRD §4.2/§6.5). Element rects are serialized as stable
 * `{selector, role, rect}` entries so the model picks an `element_ref` and CODE
 * draws the annotation box from the real rect; we never trust VLM pixel
 * coordinates. Animated elements are flagged so the phash stability gate (#15)
 * can exclude them.
 *
 * TWO kinds of element are in the map, and the second exists because the first
 * alone made the grounding gate (#32) delete true findings:
 *
 *   - LANDMARKS: the structural elements a reviewer navigates by. Keeping the
 *     map to these is what stops it from being a 400-entry dump of every node
 *     on the page.
 *   - MEASURED elements: anything a deterministic check (#19) produced a fact
 *     about. The check set is wider than the landmark set on purpose (overflow
 *     and contrast run over text nodes, so `p`, `li` and `span` are measured but
 *     are not landmarks), so the engine could measure an overflow on a `<p>`,
 *     hand the model that measurement as a FACT it is told to trust, force a
 *     deep review BECAUSE of it, and then have the gate delete the model's
 *     finding about it as "citing a route or element that was never captured".
 *     That sentence was false: the element was captured, and measured, which is
 *     strictly more capture than a landmark that was only ever rect-recorded.
 *
 * An element the engine measured is groundable by construction, so it belongs
 * in the map. This widens what the gate accepts by exactly the elements the
 * engine itself vouched for, and by nothing else: an element that was never
 * extracted has no rect and no measurement, is in neither set, and is still
 * deleted. The gate's guarantee is unchanged.
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
}

export interface GeometryEntry {
  route: string;
  viewport: Viewport;
  selector: string;
  role: string;
  rect: Rect;
  animated: boolean;
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
 * already published a measured fact naming it.
 */
export function isMeasured(el: RawGeometryElement, measuredKeys: ReadonlySet<string>): boolean {
  return measuredKeys.has(measurementKey(el.route, el.viewport, stableSelector(el)));
}

/** The measurement keys of a set of deterministic findings (#19). */
export function measuredKeys(findings: readonly DeterministicFinding[]): Set<string> {
  return new Set(findings.map((f) => measurementKey(f.route, f.viewport, f.selector)));
}

/**
 * Serialize the groundable elements into stable geometry entries: every landmark,
 * plus every element `measured` names (see the module comment). Passing no
 * measurements yields the landmark-only map.
 */
export function serializeGeometry(
  elements: RawGeometryElement[],
  measured: readonly DeterministicFinding[] = [],
): GeometryEntry[] {
  const keys = measuredKeys(measured);
  return elements
    .filter((el) => isLandmark(el) || isMeasured(el, keys))
    .map((el) => ({
      route: el.route,
      viewport: el.viewport,
      selector: stableSelector(el),
      role: normalizeRole(el),
      rect: el.rect,
      animated: el.animated ?? false,
    }));
}

/** The animated subset, for the phash exclusion list (#15). */
export function animatedExclusions(entries: GeometryEntry[]): GeometryEntry[] {
  return entries.filter((e) => e.animated);
}
