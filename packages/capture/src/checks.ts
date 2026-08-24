import type { MeasurementKind, MeasurementReport, Viewport, WireMeasurement, WireViewport } from "@apatureai/verdict-types";
import { VIEWPORT_SIZES } from "./browser-port.js";
import { compositeOver, isOpaque, parseCssColor } from "./color.js";

/**
 * Deterministic, code-computed UI checks (TRD §4.2/§6.3/§6.5). The model must
 * never read hex off pixels or guess element sizes. Contrast, overflow, and
 * touch-target violations are computed here from the captured computed styles +
 * geometry and handed to the critique prompt as FACTS, not questions. This is a
 * primary anti-hallucination lever (#30/#32).
 *
 * The browser-side extraction (a11y snapshot + computed styles) lives in the
 * Playwright worker (#11); these functions are pure so they are fully testable
 * without a browser and run identically on captured data.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Computed style + geometry for a single text node. */
export interface TextNodeStyle {
  route: string;
  viewport: Viewport;
  selector: string;
  /** Effective font size in CSS px. */
  fontSizePx: number;
  fontWeight: number;
  /** Foreground as a CSS color string; may be translucent (`rgba(…, .55)`). */
  color: string;
  /**
   * The FLATTENED, fully opaque backdrop behind the text: the element's own
   * background composited over its ancestors and the page canvas
   * (`toTextNodeStyles` resolves it). `null` when it could not be determined,
   * e.g. nothing in the stack is opaque and the canvas color is unknown. A null
   * backdrop makes the contrast check stay silent instead of guessing: an
   * invented ratio would be published as a measured fact.
   */
  backgroundColor: string | null;
  rect: Rect;
  /** scrollWidth of the node's content; > rect.width means horizontal overflow. */
  contentWidthPx: number;
  /**
   * Whether the element is animated, when the capture reported it.
   *
   * A marquee or a ticker is clipped by design and its affordance is the motion,
   * which no computed style can express and a single screenshot cannot show.
   * Without this the engine gated them as content loss. Optional: a capture
   * fleet that does not report it leaves the classification exactly as it was.
   */
  animated?: boolean;
  /**
   * The element's computed `overflow-x`, when the capture reported it.
   *
   * `contentWidthPx` alone cannot tell breakage from design: a `<pre>` with a
   * scrollbar, a horizontal carousel and a deliberately scrollable table all
   * have `scrollWidth > clientWidth` and are all working exactly as authored.
   *
   * Optional because the engine and the capture fleet deploy separately, and a
   * fleet that predates the field sends nothing. Absent is UNKNOWN, never
   * "visible": an unknown value is reported as a measurement and is never
   * block-eligible.
   */
  overflowX?: string;
  /**
   * Whether an ANCESTOR of this element scrolls horizontally.
   *
   * The scroller is usually not the element that overflows. A wide row inside a
   * `.table-wrap`, a long line inside a scrolling code shell: the text itself
   * computes `overflow-x: visible` and looks exactly like a page coming apart,
   * and the reader can reach every pixel of it.
   *
   * Optional for the same reason, and absent is UNKNOWN: the measurement is
   * reported and not block-eligible, because an unseen ancestor scroller could
   * be the whole explanation.
   */
  ancestorScrollsX?: boolean;
  /**
   * The element's computed `text-overflow`, when the capture reported it.
   *
   * This is what separates the two things `overflow-x: hidden` can mean. A
   * value other than `clip` paints a mark at the cut, so the reader can see
   * that the line was truncated; `clip` cuts mid-glyph and says nothing.
   *
   * Optional, and absent is UNKNOWN: a clip whose affordance was never
   * observed is reported and never block-eligible.
   */
  textOverflow?: string;
  /**
   * The element's computed `white-space`, when the capture reported it.
   *
   * `text-overflow` acts on content that overflows a line box, so it only
   * reliably renders where the line cannot wrap. A wrapping element with
   * `text-overflow: ellipsis` may show the mark or may not, depending on what
   * lands on the overflowing line, and that is one of the shapes this check
   * genuinely cannot decide.
   *
   * Optional, and absent is UNKNOWN, for the same reason.
   */
  whiteSpace?: string;
  /**
   * Whether anything in this element's background stack paints something
   * `resolvedBackground` cannot see: a `background-image` or a `backdrop-filter`.
   *
   * The contrast check flattens background COLORS onto the canvas. White text on
   * a photo sitting over a white base would therefore measure as a 1:1 failure
   * no reader experiences. A ratio against an image is not computable from a
   * flattened colour at all, so a KNOWN-obscured backdrop is declined rather
   * than measured, exactly like an unparseable colour: the check emits nothing.
   *
   * Optional for the same reason `overflowX` is, and absent is UNKNOWN, which
   * still yields a reported, non-block-eligible measurement.
   */
  backdropObscured?: boolean;
  /**
   * The FLATTENED, fully opaque backdrop at each stop of a background gradient,
   * when the gradient behind this text was computable (`resolvedGradientBackdrops`).
   *
   * `backdropObscured` says a background image is in the way; this says the
   * image was a `linear-gradient(#ffffff, #eaf2ff)` and here is exactly what it
   * paints. Declining every image treats those two as the same fact, which cost
   * the commonest computable case there is: white text on a pale gradient,
   * unreadable at one end and reported nowhere.
   *
   * A gradient has no single backdrop, so it is not one colour: it is the set
   * of stops, and the check measures the worst of them. Absent means the
   * backdrop is not a computable gradient, which is nearly every image, and the
   * check falls back to declining exactly as before.
   */
  backgroundGradient?: string[];
}

/** An interactive element whose hit target must meet the minimum size. */
export interface InteractiveElement {
  route: string;
  viewport: Viewport;
  selector: string;
  role: string | null;
  rect: Rect;
  /**
   * Whether this target is an inline element inside a run of non-target text,
   * i.e. a link in a sentence.
   *
   * Both target-size criteria exempt that shape by name ("Inline"), because
   * such a target's height is the line-height of the prose around it. Optional,
   * and absent is UNKNOWN: reported, never block-eligible, because an
   * unevaluated exception could be the entire finding.
   */
  inlineTarget?: boolean;
}

export type CheckKind = "contrast" | "overflow" | "touch_target";

/**
 * The check kinds that count as BREAKAGE: measured evidence that the page did
 * not render the way it was laid out, as opposed to measured evidence that it
 * rendered exactly as intended and the intent was wrong.
 *
 * Only `overflow` qualifies. Content wider than its container is the page coming
 * apart, and it is the same class of fact the triage pass already collects from
 * the model under `obviousBreakage` ("overlap, unstyled HTML, broken images, or
 * overflow"). A contrast failure and an undersized touch target are real
 * defects, measured just as reliably, but they are properties of a page that
 * rendered correctly, so they belong in the deep prompt's fact list (where they
 * already are, via `factsForRoute`) rather than in the signal that overrules a
 * triage pass declining to look.
 *
 * Kept as one named constant because the classification is a judgment call and
 * has to be reviewable in one place rather than inferred from a filter buried in
 * a caller.
 */
export const BREAKAGE_KINDS: readonly CheckKind[] = ["overflow"];

/** Whether a measured finding is breakage (see `BREAKAGE_KINDS`). */
export function isBreakage(finding: DeterministicFinding): boolean {
  return BREAKAGE_KINDS.includes(finding.kind);
}

export interface DeterministicFinding {
  kind: CheckKind;
  route: string;
  viewport: Viewport;
  selector: string;
  /** A factual statement for the prompt, e.g. "contrast 2.31:1 (needs 4.5:1)". */
  detail: string;
  /**
   * Whether this measurement is precise enough for a consumer to gate a merge
   * on. Set by the check that produced it, from the precision inputs only the
   * check can see (`overflow-x`, the viewport, an obscured backdrop).
   *
   * The engine owns PRECISION; a consumer owns POLICY. `false` never means the
   * measurement is wrong, only that acting on it automatically would be. The
   * violation is reported either way.
   *
   * Optional so a capture service that predates the flag still parses, and
   * absent is read as `false` everywhere: an unknown precision must never
   * authorize a merge block.
   */
  blockEligible?: boolean;
  /**
   * Which BAND of badness this measurement falls in. An ordinal, higher is
   * worse, owned by the check that produced it (see `contrastSeverity`,
   * `overflowSeverity`, `touchTargetSeverity` for the landmarks and why they
   * sit where they do).
   *
   * Comparable only WITHIN a `kind`. A contrast 2 and a touch-target 2 are not
   * the same amount of anything, there is no ordering across kinds, and the
   * number is not a magnitude: it is never subtracted, averaged, scaled or
   * summed. It answers "which band of badness", never "how bad".
   *
   * The bands are COARSE on purpose. A consumer stores a band for a base commit
   * and compares it to the band measured on a pull request, so ordinary
   * re-measurement noise must not move it: a contrast ratio drifting 2.91 to
   * 2.87 on an untouched page stays in the same band, and a band that DID move
   * is by construction a material change rather than a re-render. The raw
   * ratio, the raw pixel count and the raw excess are exactly what must not
   * cross this boundary, which is why none of them do.
   *
   * Optional, for the same reason `blockEligible` is and with the same rule: a
   * capture service that predates the field sends nothing, an older stored band
   * is not there to compare against, and a check that cannot compute one emits
   * nothing rather than a number. Absent is UNKNOWN, and unknown never gates.
   * Zero is a band; absent is not a band, and the two must never be conflated.
   */
  severity?: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function channelLuminance(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA threshold: 3.0 for large text (>=24px, or >=18.66px bold), else 4.5. */
function contrastThreshold(node: TextNodeStyle): number {
  const isLarge = node.fontSizePx >= 24 || (node.fontSizePx >= 18.66 && node.fontWeight >= 700);
  return isLarge ? 3.0 : 4.5;
}

/**
 * The two WCAG target-size criteria, with the level each one belongs to.
 *
 * This table exists because the emitted text has to name the criterion it
 * actually applied. The check used to measure against 44 and cite "2.5.5"
 * without its level, which reads as a conformance failure and is not one: 2.5.5
 * Target Size (Enhanced) is level AAA, a line almost no product commits to. The
 * level **AA** criterion, the one a repository plausibly conforms to, is 2.5.8
 * Target Size (Minimum) at 24x24 CSS px.
 *
 * So AA is the default, and 44 stays available for a team that has chosen the
 * stricter line. Whichever is applied, its number, id, name and level go into
 * the sentence, so a reader can check the claim against the spec.
 */
export const TOUCH_TARGET_CRITERIA = {
  AA: { sc: "2.5.8", name: "Target Size (Minimum)", level: "AA", minPx: 24 },
  AAA: { sc: "2.5.5", name: "Target Size (Enhanced)", level: "AAA", minPx: 44 },
} as const;

/** Which target-size criterion to measure against. */
export type TouchTargetCriterion = keyof typeof TOUCH_TARGET_CRITERIA;

/**
 * AA, not AAA. The engine measures what a team is likely to have committed to,
 * and reports it as what it is.
 */
export const DEFAULT_TOUCH_TARGET_CRITERION: TouchTargetCriterion = "AA";

/** WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA. */
export const AA_TOUCH_TARGET_PX = TOUCH_TARGET_CRITERIA.AA.minPx;

/** WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA. Also the iOS/Android HIG number. */
export const AAA_TOUCH_TARGET_PX = TOUCH_TARGET_CRITERIA.AAA.minPx;

/**
 * The viewports where a target-size criterion applies.
 *
 * Both criteria are about POINTER targets, and the hazard they describe is a
 * finger. A 1440px desktop capture is driven with a mouse, where a 20px control
 * is a design note and not an accessibility failure, so the check does not run
 * there at all. Measuring it and then quietly refusing to gate on it would
 * still put a sentence in front of a reader claiming a WCAG failure that the
 * criterion does not assert.
 *
 * Tablet counts: it is an 834px touch surface, and a finger on it is the same
 * finger.
 */
export const TOUCH_VIEWPORTS: readonly Viewport[] = ["mobile", "tablet"];

/**
 * The band an undersized pointer target has stopped being a control at all.
 *
 * 24px is the level AA line (SC 2.5.8) and 44px the AAA one, so anything the
 * check reports is already under 24. What the second landmark separates is a
 * target that is merely small, a 20px icon button a careful finger still lands
 * on, from one at 8px, which is not a control a finger can be aimed at and is
 * usually a decorative glyph that was made clickable by accident.
 */
const VESTIGIAL_TOUCH_TARGET_PX = 10;

/**
 * The ratio below which text has effectively stopped being visible.
 *
 * The upper landmark is a WCAG one: 3.0 is the AA line for large text, the
 * lowest ratio any level-AA criterion accepts, so a violation at or above it is
 * text that missed the 4.5 bar for its size and is still text a reader reads.
 * 1.5 has no criterion behind it and does not pretend to: it is the point where
 * the glyphs and their backdrop are close enough in luminance that the text is
 * not read so much as discovered.
 */
const NEAR_INVISIBLE_CONTRAST_RATIO = 1.5;

/** The AA line for large text; see `NEAR_INVISIBLE_CONTRAST_RATIO`. */
const LARGE_TEXT_AA_CONTRAST_RATIO = 3.0;

/**
 * How much of the viewport an overflow has to spill before it changes band.
 *
 * A share of the viewport rather than a pixel count, because 40px off the edge
 * of a 390px phone and 40px off the edge of a 1440px desktop are not the same
 * event. A tenth of the viewport is a word or two past the edge; half of it is
 * the page laid out for a width it was not given.
 */
const OVERFLOW_MINOR_SHARE = 0.1;
const OVERFLOW_MAJOR_SHARE = 0.5;

/**
 * The contrast band for a measured ratio, or `undefined` when there is no ratio
 * to band.
 *
 * `undefined` rather than a floor value: a band nothing computed must be absent,
 * because a consumer reads absent as unknown and reads any number, zero
 * included, as a claim the engine made.
 */
export function contrastSeverity(ratio: number): number | undefined {
  if (!Number.isFinite(ratio)) return undefined;
  if (ratio >= LARGE_TEXT_AA_CONTRAST_RATIO) return 1;
  if (ratio >= NEAR_INVISIBLE_CONTRAST_RATIO) return 2;
  return 3;
}

/**
 * The touch-target band for a measured box, from its SMALLEST dimension.
 *
 * Smallest, because both target-size criteria are stated as a square minimum
 * and a 200x8px strip fails on the 8. `undefined` when the box has no finite
 * size to measure, for the reason `contrastSeverity` returns it.
 */
export function touchTargetSeverity(rect: Rect): number | undefined {
  const smallest = Math.min(rect.width, rect.height);
  if (!Number.isFinite(smallest)) return undefined;
  if (smallest >= AA_TOUCH_TARGET_PX) return 1;
  if (smallest >= VESTIGIAL_TOUCH_TARGET_PX) return 2;
  return 3;
}

/**
 * The overflow band for a measured excess, as a share of the viewport width.
 *
 * `undefined` when the viewport is not one this capture has a width for. That
 * is a real path and not a formality: `Viewport` is a string that arrives from
 * a capture service, this module is pure and validates nothing, and dividing by
 * an unknown width would produce a band out of nothing. Absent instead.
 */
export function overflowSeverity(excessPx: number, viewport: Viewport): number | undefined {
  const width = VIEWPORT_SIZES[viewport]?.width;
  if (width === undefined || !Number.isFinite(width) || width <= 0) return undefined;
  if (!Number.isFinite(excessPx)) return undefined;
  const share = excessPx / width;
  if (share <= OVERFLOW_MINOR_SHARE) return 1;
  if (share <= OVERFLOW_MAJOR_SHARE) return 2;
  return 3;
}

/**
 * What the text is measured against: one colour for a flat fill, one colour per
 * stop for a computable gradient, `null` when the backdrop is not knowable.
 *
 * `null` is the same decision everywhere it is returned: the true ratio cannot
 * be derived from what was captured, so no fact is emitted. Silence, never a
 * guess; a wrong number here is published as a measurement.
 */
function measurableBackdrop(
  node: TextNodeStyle,
): { backdrops: readonly string[]; gradient: boolean } | null {
  // A background-image or a backdrop-filter paints something no flattened
  // colour represents. White text on a photograph over a white page flattens to
  // 1.00:1, a number that is not merely imprecise but false.
  if (node.backdropObscured === true) {
    // …unless the image was a gradient whose stops are plain colours, in which
    // case the backdrop IS known: not as one colour, as the set of stops.
    const stops = node.backgroundGradient;
    return stops !== undefined && stops.length > 0 ? { backdrops: stops, gradient: true } : null;
  }
  return node.backgroundColor === null
    ? null
    : { backdrops: [node.backgroundColor], gradient: false };
}

/**
 * The LOWEST contrast ratio the text reaches over the given backdrops, or
 * `null` when any of them is unparseable or translucent.
 *
 * Lowest, because a ratio that fails anywhere on the element is a real failure
 * somewhere on the element. For a flat fill there is one backdrop and the
 * lowest is the only one.
 *
 * Between two adjacent gradient stops the rendered backdrop is an sRGB
 * interpolation, and relative luminance is monotone in every channel, so no
 * point in between is lighter or darker than the stops that bound it. The
 * worst stop is therefore an upper bound on the worst ratio the reader meets:
 * where the text's own luminance falls BETWEEN two stops there is a point along
 * the run whose contrast is lower still, down to 1.00:1. Reporting the worst
 * stop understates that case, which is the safe direction and a deliberate
 * choice: an understated ratio can only cost a finding, never invent one.
 */
function worstContrastRatio(color: string, backdrops: readonly string[]): number | null {
  const rawFg = parseCssColor(color);
  if (rawFg === null || rawFg.a === 0) return null;
  let worst: number | null = null;
  for (const css of backdrops) {
    const bg = parseCssColor(css);
    if (bg === null || !isOpaque(bg)) return null;
    // Translucent text is composited onto the resolved backdrop; its rendered
    // color is what a reader actually sees, and what WCAG is defined over.
    const ratio = contrastRatio(compositeOver(rawFg, bg), bg);
    if (worst === null || ratio < worst) worst = ratio;
  }
  return worst;
}

export function contrastViolations(nodes: TextNodeStyle[]): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const node of nodes) {
    const backdrop = measurableBackdrop(node);
    if (backdrop === null) continue;
    const ratio = worstContrastRatio(node.color, backdrop.backdrops);
    if (ratio === null) continue;
    const threshold = contrastThreshold(node);
    if (ratio >= threshold) continue;
    const severity = contrastSeverity(ratio);
    out.push({
      kind: "contrast",
      route: node.route,
      viewport: node.viewport,
      selector: node.selector,
      // Two different statements, and the sentence says which one it is. A flat
      // fill is the ratio the reader meets everywhere on the element; a
      // gradient is the ratio at its worst stop, which is a fact about the
      // backdrop and not yet a fact about the glyphs.
      detail: backdrop.gradient
        ? `advisory: text contrast ${ratio.toFixed(2)}:1 at the worst stop of the background ` +
          `gradient is below WCAG AA ${threshold.toFixed(1)}:1`
        : `text contrast ${ratio.toFixed(2)}:1 is below WCAG AA ${threshold.toFixed(1)}:1`,
      // Exact when the extractor confirmed a flat colour backdrop. A capture
      // that never reported the field could be sitting on an image nobody
      // looked for, so it is reported and not gated on.
      //
      // A gradient is never gateable, and the reason is not the arithmetic: the
      // stops are exact. It is that the engine knows what the ELEMENT paints and
      // not where the glyphs sit inside it, so the worst stop may be off to one
      // side of the text that was measured against it. Establishing that would
      // take glyph-level geometry this capture does not collect, and a merge
      // must not fail on a bound the code cannot close.
      blockEligible: !backdrop.gradient && node.backdropObscured === false,
      // The band is about the RATIO and not about the precision: a gradient's
      // worst stop is still measured, and a consumer that will not gate on it
      // may still want to know the text went from readable to invisible.
      ...(severity === undefined ? {} : { severity }),
    });
  }
  return out;
}

/**
 * The computed `overflow-x` values that make an element a scroll container: the
 * excess is reachable, by wheel, swipe, drag or keyboard.
 */
const SCROLLABLE_OVERFLOW_X: readonly string[] = ["auto", "scroll", "overlay"];

/**
 * The computed `overflow-x` values that CUT the excess off: no wheel, no swipe,
 * no scrollbar reaches it. What the cut MEANS is a separate question, and
 * `classifyClip` is where it is answered.
 *
 * `hidden` is still a scroll container, so a script CAN scroll it, which is how
 * a tab strip with arrow buttons is usually built. Nothing in a computed style
 * says whether such a control exists, so a clip with no affordance in its own
 * style is read as content loss and that residual shape is stated in the
 * README's limitations rather than guessed at here. `clip` is not scrollable at
 * all, by script or otherwise.
 */
const CLIPPING_OVERFLOW_X: readonly string[] = ["hidden", "clip"];

/**
 * The computed `white-space` values under which inline content does not wrap,
 * so a line runs past the box edge and `text-overflow` has something to act on.
 * `normal`, `pre-wrap`, `pre-line` and `break-spaces` all wrap.
 */
const NON_WRAPPING_WHITE_SPACE: readonly string[] = ["nowrap", "pre"];

/**
 * A box this small in either dimension is not a rendered box. It is the
 * visually-hidden idiom (`width: 1px; height: 1px; overflow: hidden`, usually
 * with a `clip-path`), which every design system ships for screen-reader-only
 * text, and whose whole purpose is that the content is clipped away from sight
 * while assistive technology still reads it.
 */
const DEGENERATE_BOX_PX = 1;

/**
 * What a clip MEANS, which is the question `overflow-x: hidden` alone cannot
 * answer and the reason the overflow measurement could not gate anything.
 *
 * `overflow-x: hidden` with content wider than the box is either a deliberate
 * truncation, where the author cut the line and left the reader a mark saying
 * so, or content loss, where a word ends mid-glyph and nothing on screen
 * indicates that anything is missing. They are the same measurement and
 * opposite facts, so the check used to report both at advisory forever, and
 * content loss under a clip is the commonest real overflow defect there is.
 *
 * There is a third answer, and collapsing it into either of the other two to
 * make the numbers look better would be the whole bug again. `indeterminate`
 * carries the reason, which is emitted in the finding: a reader who is told a
 * measurement is not gateable is owed the sentence explaining why.
 */
export type ClipVerdict =
  | { verdict: "content_loss" }
  | { verdict: "deliberate_truncation" }
  | { verdict: "indeterminate"; reason: string };

/**
 * Decide what a clipping element's clip means, from computed style only.
 *
 * The signature of a deliberate truncation is a truncation AFFORDANCE that
 * actually renders: `text-overflow` set to something other than `clip`, on
 * content that cannot wrap. That is the shape of every truncated table cell,
 * card title and file name in every design system, and the reader can see the
 * ellipsis sitting at the cut.
 *
 * Everything that follows is a reason the affordance cannot be established, and
 * each one lands in `indeterminate` rather than in either verdict.
 */
export function classifyClip(node: TextNodeStyle): ClipVerdict {
  // Deploy skew: a capture fleet older than these fields sends nothing, and
  // "no text-overflow reported" must not be read as "text-overflow: clip".
  if (node.textOverflow === undefined || node.textOverflow === "" || node.whiteSpace === undefined) {
    return {
      verdict: "indeterminate",
      reason: "the capture did not report text-overflow, so a deliberate truncation cannot be ruled out",
    };
  }
  const affordance = node.textOverflow !== "clip";
  const wraps = !NON_WRAPPING_WHITE_SPACE.includes(node.whiteSpace);
  if (affordance && !wraps) return { verdict: "deliberate_truncation" };
  if (affordance) {
    return {
      verdict: "indeterminate",
      reason: "a truncation mark on wrapping content may not be rendered at all",
    };
  }
  if (node.rect.width <= DEGENERATE_BOX_PX || node.rect.height <= DEGENERATE_BOX_PX) {
    return {
      verdict: "indeterminate",
      reason:
        `a ${Math.round(node.rect.width)}x${Math.round(node.rect.height)}px box is the ` +
        "visually-hidden idiom, not a box content is rendered in",
    };
  }
  if (node.animated === true) {
    return {
      verdict: "indeterminate",
      reason:
        "the element is animated, so the content may scroll into view on its own and the " +
        "affordance is the motion rather than anything in its computed style",
    };
  }
  return { verdict: "content_loss" };
}

export function overflowViolations(nodes: TextNodeStyle[]): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const node of nodes) {
    // The tolerance for sub-pixel layout: `contentWidthPx` and the box width
    // are rounded from the same layout, and a fractional box rounds up. Probed
    // against Chromium across the boundary, a box narrower than its content by
    // up to about one pixel reports no excess at all, so this ceiling is the
    // rounding allowance and no second one is invented below.
    const clippedPx = node.contentWidthPx - Math.ceil(node.rect.width);
    if (clippedPx <= 0) continue;
    const container = Math.round(node.rect.width);
    const measured = `content width ${node.contentWidthPx}px exceeds container ${container}px`;
    // One band for both shapes below: a clipped overflow and an escaping one
    // spill the same number of pixels past the same viewport, and the band says
    // how far the page came apart, not what the box did about it.
    const severity = overflowSeverity(clippedPx, node.viewport);
    // A scroll container has content wider than its box by definition and on
    // purpose. Every `<pre>` with a scrollbar and every horizontal carousel
    // measured as breakage before this line existed, and `overflow` is the one
    // kind that overrules a triage pass declining to look, so the noisiest
    // measurement was also the loudest.
    if (node.overflowX !== undefined && SCROLLABLE_OVERFLOW_X.includes(node.overflowX)) continue;
    if (node.overflowX !== undefined && CLIPPING_OVERFLOW_X.includes(node.overflowX)) {
      // Checked BEFORE the ancestor-scroller rescue below, because that rescue
      // does not apply here: an ancestor that scrolls moves its own content
      // into view and does nothing whatever for content this element already
      // cut off at its own edge.
      const clip = classifyClip(node);
      if (clip.verdict === "deliberate_truncation") continue;
      const applied = `overflow-x: ${node.overflowX}, text-overflow: ${node.textOverflow ?? "not reported"}, white-space: ${node.whiteSpace ?? "not reported"}`;
      out.push({
        kind: "overflow",
        route: node.route,
        viewport: node.viewport,
        selector: node.selector,
        detail:
          clip.verdict === "content_loss"
            ? `${measured} and ${clippedPx}px of it is clipped away with no truncation affordance (${applied})`
            : `${measured} and is clipped (${applied}); not gated because ${clip.reason}`,
        // Content loss is the one clip this engine will stand behind: the
        // excess is cut, nothing above can reveal it, and no affordance tells
        // the reader that anything was cut.
        blockEligible: clip.verdict === "content_loss",
        ...(severity === undefined ? {} : { severity }),
      });
      continue;
    }
    // The scroller is frequently the wrapper, not the text: a wide row inside a
    // `.table-wrap` computes `overflow-x: visible` on the row itself. The
    // reader can still reach all of it, so it is not the page coming apart.
    if (node.ancestorScrollsX === true) continue;
    out.push({
      kind: "overflow",
      route: node.route,
      viewport: node.viewport,
      selector: node.selector,
      detail: `${measured} (horizontal overflow)`,
      // Gateable only when the capture affirmatively established both halves:
      // the box does not scroll, and nothing above it does either. A capture
      // that did not report a field leaves the question open, and an open
      // question must not fail a build.
      blockEligible: node.overflowX === "visible" && node.ancestorScrollsX === false,
      ...(severity === undefined ? {} : { severity }),
    });
  }
  return out;
}

/** Centre of a rect, in the same coordinate space. */
function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Whether a circle overlaps a rect (touching is not overlapping). */
function circleOverlapsRect(
  centre: { x: number; y: number },
  radius: number,
  rect: Rect,
): boolean {
  const nearestX = Math.min(Math.max(centre.x, rect.x), rect.x + rect.width);
  const nearestY = Math.min(Math.max(centre.y, rect.y), rect.y + rect.height);
  const dx = centre.x - nearestX;
  const dy = centre.y - nearestY;
  return dx * dx + dy * dy < radius * radius;
}

function isUndersized(rect: Rect, minPx: number): boolean {
  return rect.width < minPx || rect.height < minPx;
}

/**
 * The "Spacing" exception in WCAG 2.2 SC 2.5.8: an undersized target does not
 * fail the criterion when a 24 CSS px diameter circle centred on it touches no
 * other target, and no other undersized target's circle.
 *
 * This is the difference between a 20px icon button crammed against its
 * neighbour, which is the hazard the criterion describes, and a 20px icon
 * button with clear space around it, which is not. Citing 2.5.8 while ignoring
 * its exceptions would be citing it incorrectly, which is the bug this check
 * had in the first place.
 *
 * The exception belongs to 2.5.8 only; 2.5.5 (AAA) has no spacing relief.
 */
function meetsSpacingException(
  target: InteractiveElement,
  peers: readonly InteractiveElement[],
): boolean {
  const radius = AA_TOUCH_TARGET_PX / 2;
  const centre = centreOf(target.rect);
  for (const peer of peers) {
    if (peer === target) continue;
    if (peer.route !== target.route || peer.viewport !== target.viewport) continue;
    if (circleOverlapsRect(centre, radius, peer.rect)) return false;
    if (isUndersized(peer.rect, AA_TOUCH_TARGET_PX)) {
      const peerCentre = centreOf(peer.rect);
      const dx = centre.x - peerCentre.x;
      const dy = centre.y - peerCentre.y;
      if (Math.hypot(dx, dy) < AA_TOUCH_TARGET_PX) return false;
    }
  }
  return true;
}

export interface TouchTargetOptions {
  /**
   * Which criterion to measure against. Defaults to AA (SC 2.5.8, 24x24). Pass
   * `"AAA"` for SC 2.5.5 (44x44) if the repository has committed to it.
   */
  criterion?: TouchTargetCriterion;
}

/** `WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA`, for the emitted text. */
function cite(criterion: (typeof TOUCH_TARGET_CRITERIA)[TouchTargetCriterion]): string {
  return `WCAG 2.2 SC ${criterion.sc} ${criterion.name}, level ${criterion.level}`;
}

export function touchTargetViolations(
  elements: InteractiveElement[],
  options: TouchTargetOptions = {},
): DeterministicFinding[] {
  const name = options.criterion ?? DEFAULT_TOUCH_TARGET_CRITERION;
  const criterion = TOUCH_TARGET_CRITERIA[name];
  const out: DeterministicFinding[] = [];
  for (const el of elements) {
    // A pointer-target criterion, on the surfaces it is about.
    if (!TOUCH_VIEWPORTS.includes(el.viewport)) continue;
    // "Inline": a link in a sentence is sized by the line-height around it, and
    // both criteria exempt it. Enlarging it would damage the paragraph.
    if (el.inlineTarget === true) continue;
    const size = `${Math.round(el.rect.width)}x${Math.round(el.rect.height)}px`;
    // Banded off the BOX, not off the criterion in force, so the same 20px
    // control lands in the same band whether a repository measures at AA or at
    // AAA. A band that moved because the reader changed their mind about which
    // criterion to hold would be a band about the config, not about the page.
    const severity = touchTargetSeverity(el.rect);

    if (isUndersized(el.rect, criterion.minPx)) {
      if (name === "AA" && meetsSpacingException(el, elements)) continue;
      out.push({
        kind: "touch_target",
        route: el.route,
        viewport: el.viewport,
        selector: el.selector,
        detail:
          `touch target ${size} is below the ${criterion.minPx}x${criterion.minPx}px minimum ` +
          `in ${cite(criterion)}`,
        // Every exception this check can evaluate has already been applied
        // above. What is left is the one it cannot: a capture that never
        // reported `inlineTarget` leaves the Inline exception unevaluated, and
        // an unevaluated exception could be the whole finding.
        blockEligible: el.inlineTarget === false,
        ...(severity === undefined ? {} : { severity }),
      });
      continue;
    }

    // The band between the two criteria: a target that clears AA and does not
    // clear AAA. A 32px control is comfortable under a mouse and mis-tapped on
    // a phone, which is why 2.5.5 exists, and after the check moved from 44 to
    // the 24 the criterion for level AA actually states, it was reported
    // nowhere at all. It is reported here, as what it is: not a conformance
    // failure for a repository that never committed to AAA, so never
    // block-eligible, and never phrased as one.
    //
    // Only the band. A target the AA check already looked at and excused, by
    // the Spacing exception it is entitled to, is not re-reported one line
    // lower under a stricter criterion; that would take back the exception
    // through a side door. A repository that wants the AAA line held asks for
    // it, and then it is measured as a failure and gates like one.
    if (name !== "AA") continue;
    if (!isUndersized(el.rect, AAA_TOUCH_TARGET_PX)) continue;
    const enhanced = TOUCH_TARGET_CRITERIA.AAA;
    out.push({
      kind: "touch_target",
      route: el.route,
      viewport: el.viewport,
      selector: el.selector,
      // Both halves in one sentence: which bar it cleared and which it did not.
      // The terminal report prints this line and nothing else about the row, so
      // a reader who cannot tell a hard failure from a suggestion here cannot
      // tell anywhere.
      detail:
        `advisory: touch target ${size} meets the ${criterion.minPx}x${criterion.minPx}px ` +
        `minimum in ${cite(criterion)}, and is below the ` +
        `${enhanced.minPx}x${enhanced.minPx}px minimum in ${cite(enhanced)}`,
      blockEligible: false,
      // A target in this band cleared 24px, so the box bands at 1. Emitted
      // rather than omitted, because "the least bad band" is a measured answer
      // and omitting it would say the engine did not have one.
      ...(severity === undefined ? {} : { severity }),
    });
  }
  return out;
}

export interface DeterministicCheckInput {
  textNodes: TextNodeStyle[];
  interactive: InteractiveElement[];
  /** Target-size criterion for the touch-target check. Defaults to AA. */
  touchTargetCriterion?: TouchTargetCriterion;
}

/** Run all deterministic checks, returning the facts for the critique prompt. */
export function deterministicChecks(input: DeterministicCheckInput): DeterministicFinding[] {
  return [
    ...contrastViolations(input.textNodes),
    ...overflowViolations(input.textNodes),
    ...touchTargetViolations(input.interactive, { criterion: input.touchTargetCriterion }),
  ];
}

/** Every check this module implements, in the order the report lists them. */
export const ALL_MEASUREMENT_KINDS: readonly MeasurementKind[] = [
  "contrast",
  "overflow",
  "touch_target",
];

/**
 * Project the per-(route, viewport) measurements into the wire report a
 * consumer receives.
 *
 * The same 3.23:1 contrast measured at three viewports is ONE defect a reader
 * fixes once, so the grouping key is (kind, route, element, detail) and the
 * viewports accumulate in first-encounter order. That rule is not new: it is
 * exactly what the terminal report's `groupFacts` has always done, and
 * `groupFacts` now delegates here so the sentence a reader sees in a terminal
 * and the sentence a consumer parses off the wire cannot drift apart.
 *
 * `blockEligible` on a group is true only when EVERY measurement in it is
 * block-eligible. A violation that is precise at mobile and inconclusive at
 * desktop is not something to fail a build on, and the group is one row.
 *
 * `severity` on a group is the WORST band any member reached: a group speaks
 * for its worst part. It is one row a reader fixes once, and the row that says
 * band 1 while one of its viewports is at band 3 understates the page to the
 * reader and, worse, hides a real worsening from a consumer comparing bands
 * across commits. It is the opposite rule to `blockEligible` on purpose: that
 * one asks "may this fail a build", where one doubt is enough to say no; this
 * one asks "how bad does this get", where the answer is the maximum.
 *
 * The comparison is safe because the group key includes `kind`, so every member
 * of a group is the same kind and bands are only ever compared within one.
 *
 * `checksRun` defaults to every check this module implements, because that is
 * what `deterministicChecks` runs. A caller that ran a subset says so, and a
 * caller that measured nothing passes an empty list, which is the difference
 * between "measured, clean" and "not measured".
 */
/**
 * Which checks a capture could actually run, given the viewports it captured.
 *
 * `touch_target` is scoped to touch viewports, so a desktop-only capture never
 * evaluates it. Reporting it in `checksRun` told a consumer "touch targets were
 * measured and were clean" for a check that structurally refused to run, and
 * neither gate nor bastion could tell that apart from a genuine clean result.
 * The distinction the report exists to carry is "measured, clean" against "not
 * measured", so it has to be derived from the capture rather than asserted.
 */
export function checksRunFor(viewports: readonly Viewport[]): MeasurementKind[] {
  const touchable = viewports.some((viewport) => TOUCH_VIEWPORTS.includes(viewport));
  return ALL_MEASUREMENT_KINDS.filter((kind) => kind !== "touch_target" || touchable);
}

/**
 * The worse of two bands, either of which may be unknown.
 *
 * A known band beats an unknown one rather than erasing it: a member that
 * carries no band says nothing about how bad the group is, and treating that
 * silence as a reason to drop a band another member did measure would throw
 * away the only answer anyone has. Unknown only survives when NOTHING knew.
 */
function worseSeverity(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  // An order comparison over an ordinal, which is the only operation this
  // number permits. Never a sum, a mean or a difference.
  return a >= b ? a : b;
}

export function toMeasurementReport(
  findings: readonly DeterministicFinding[],
  checksRun: readonly MeasurementKind[] = ALL_MEASUREMENT_KINDS,
): MeasurementReport {
  const groups = new Map<string, WireMeasurement>();
  for (const finding of findings) {
    // JSON, so no separator character can collide with a selector or detail.
    const key = JSON.stringify([finding.kind, finding.route, finding.selector, finding.detail]);
    const existing = groups.get(key);
    if (existing) {
      if (!existing.viewports.includes(finding.viewport as WireViewport)) {
        existing.viewports.push(finding.viewport as WireViewport);
      }
      // One inconclusive viewport makes the whole group inconclusive.
      existing.blockEligible = existing.blockEligible && finding.blockEligible === true;
      // A group speaks for its worst part; see the note above this function.
      const worst = worseSeverity(existing.severity, finding.severity);
      // Assigned only when something knew, so a group no member banded keeps
      // the field ABSENT rather than gaining an `undefined` that a serializer
      // would drop anyway and a reader would have to guess at.
      if (worst !== undefined) existing.severity = worst;
      continue;
    }
    groups.set(key, {
      kind: finding.kind,
      route: finding.route,
      viewports: [finding.viewport as WireViewport],
      element: finding.selector,
      detail: finding.detail,
      blockEligible: finding.blockEligible === true,
      ...(finding.severity === undefined ? {} : { severity: finding.severity }),
    });
  }
  return { checksRun: [...checksRun], violations: [...groups.values()] };
}
