import type { Viewport } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  contrastSeverity,
  contrastViolations,
  overflowSeverity,
  overflowViolations,
  toMeasurementReport,
  touchTargetSeverity,
  touchTargetViolations,
  type DeterministicFinding,
  type InteractiveElement,
  type TextNodeStyle,
} from "../src/index.js";

/**
 * The severity BAND, which is the field that lets a consumer tell a violation
 * that got worse from one that merely got re-measured.
 *
 * A consumer stores a band for a base commit and compares it to the band a pull
 * request measures. That comparison is only sound if two things hold, and both
 * are pinned here: the landmarks are where the contract says they are, so two
 * sides can agree on what a band means without exchanging a single raw number;
 * and a band that nothing computed is ABSENT rather than floored to a value,
 * because a floor is a claim and absent is the admission that there is none.
 *
 * The bands are ordinal and within-kind. Nothing here adds, averages or scales
 * one, and nothing compares a contrast band against a touch-target band.
 */

const rect = (width: number, height: number) => ({ x: 0, y: 0, width, height });

const textNode = (over: Partial<TextNodeStyle> = {}): TextNodeStyle => ({
  route: "/",
  viewport: "desktop",
  selector: "p",
  fontSizePx: 16,
  fontWeight: 400,
  color: "#000000",
  backgroundColor: "#ffffff",
  rect: rect(200, 20),
  contentWidthPx: 180,
  backdropObscured: false,
  ...over,
});

describe("contrast bands", () => {
  /**
   * 3.0 is WCAG AA for LARGE text, the lowest ratio any level-AA criterion
   * accepts: at or above it the text missed the 4.5 bar for its size and is
   * still read. 1.5 has no criterion behind it and is not pretending to have
   * one: below it the glyphs and their backdrop are close enough in luminance
   * that the text is discovered rather than read.
   */
  it("bands at the WCAG landmarks, on the exact boundary", () => {
    // At the landmark is the BETTER band, both times. A boundary that flipped
    // at 3.0 would put a ratio the criterion itself accepts for large text in
    // the same band as one nobody can see.
    expect(contrastSeverity(3.0)).toBe(1);
    expect(contrastSeverity(2.999)).toBe(2);
    expect(contrastSeverity(1.5)).toBe(2);
    expect(contrastSeverity(1.499)).toBe(3);
  });

  it("puts the whole legal range somewhere", () => {
    // 1.00:1 is text the same colour as its backdrop; 21:1 is black on white,
    // which no violation reaches but the function must still answer for.
    expect(contrastSeverity(21)).toBe(1);
    expect(contrastSeverity(4.49)).toBe(1);
    expect(contrastSeverity(1)).toBe(3);
  });

  it("emits no band at all when there is no ratio to band", () => {
    // Not zero. Zero is a band and would be read as one; this is the absence of
    // an answer, and a consumer must be able to see that it is.
    expect(contrastSeverity(Number.NaN)).toBeUndefined();
    expect(contrastSeverity(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("carries the band out of the check, on real colours", () => {
    // #949494 on white measures 3.03:1: a genuine AA failure for 16px text, and
    // still in the mildest band.
    const [mild] = contrastViolations([textNode({ color: "#949494" })]);
    expect(mild?.detail).toContain("3.03:1");
    expect(mild?.severity).toBe(1);

    // #d0d0d0 measures 1.54:1, and #d8d8d8 measures 1.43:1. The pull request
    // that takes the first to the second changed nothing a hash of the sentence
    // can see and moved the band.
    const [faint] = contrastViolations([textNode({ color: "#d0d0d0" })]);
    expect(faint?.detail).toContain("1.54:1");
    expect(faint?.severity).toBe(2);

    const [invisible] = contrastViolations([textNode({ color: "#d8d8d8" })]);
    expect(invisible?.detail).toContain("1.43:1");
    expect(invisible?.severity).toBe(3);
  });

  it("bands a measurement it will not gate on", () => {
    // The band is about the ratio; `blockEligible` is about the precision. A
    // gradient's worst stop is exact arithmetic that this engine still declines
    // to fail a build on, and the reader is owed the band either way.
    const [gradient] = contrastViolations([
      textNode({
        color: "#d8d8d8",
        backdropObscured: true,
        backgroundGradient: ["#ffffff", "#ffffff"],
      }),
    ]);
    expect(gradient?.blockEligible).toBe(false);
    expect(gradient?.severity).toBe(3);
  });
});

describe("touch-target bands", () => {
  /**
   * 24px is SC 2.5.8 Target Size (Minimum), level AA. 44px is SC 2.5.5 Target
   * Size (Enhanced), level AAA. 10px is neither: it is the point below which a
   * box has stopped being a control a finger can be aimed at.
   */
  it("bands off the smallest dimension, on the exact boundary", () => {
    expect(touchTargetSeverity(rect(24, 24))).toBe(1);
    expect(touchTargetSeverity(rect(24, 23.999))).toBe(2);
    expect(touchTargetSeverity(rect(10, 10))).toBe(2);
    expect(touchTargetSeverity(rect(10, 9.999))).toBe(3);
  });

  it("fails on the short side of a strip, not on its area", () => {
    // Both criteria are stated as a square minimum, so a 200x8px hit strip is
    // an 8px target and bands like one.
    expect(touchTargetSeverity(rect(200, 8))).toBe(3);
    expect(touchTargetSeverity(rect(8, 200))).toBe(3);
  });

  it("emits no band at all when the box has no size to measure", () => {
    expect(touchTargetSeverity(rect(Number.NaN, 20))).toBeUndefined();
    expect(touchTargetSeverity(rect(20, Number.POSITIVE_INFINITY))).toBe(2);
    expect(touchTargetSeverity(rect(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)))
      .toBeUndefined();
  });

  /** Two targets flush against each other, so the Spacing exception cannot excuse them. */
  const crowded = (w: number, h: number): InteractiveElement[] =>
    [0, h].map((y, index) => ({
      route: "/",
      viewport: "mobile" as const,
      selector: `button:nth-of-type(${index + 1})`,
      role: "button",
      rect: { x: 0, y, width: w, height: h },
      inlineTarget: false,
    }));

  it("carries the band out of the check", () => {
    expect(touchTargetViolations(crowded(23, 23))[0]?.severity).toBe(2);
    expect(touchTargetViolations(crowded(10, 10))[0]?.severity).toBe(2);
    expect(touchTargetViolations(crowded(9, 9))[0]?.severity).toBe(3);
  });

  it("bands the AA-to-AAA advisory at 1, rather than leaving it unbanded", () => {
    // A 32px control clears the AA line and misses the AAA one. "The least bad
    // band" is a measured answer; omitting it would say the engine had none.
    const [advisory] = touchTargetViolations(crowded(32, 32));
    expect(advisory?.detail).toContain("advisory:");
    expect(advisory?.blockEligible).toBe(false);
    expect(advisory?.severity).toBe(1);
  });

  it("bands off the box and not off the criterion the repository chose", () => {
    // The same 30px control, measured at AA and at AAA. The sentence changes,
    // the precision claim changes, and the band does not: it describes the
    // page, not the line the reader decided to hold.
    const [aa] = touchTargetViolations(crowded(30, 30));
    const [aaa] = touchTargetViolations(crowded(30, 30), { criterion: "AAA" });
    expect(aa?.blockEligible).toBe(false);
    expect(aaa?.blockEligible).toBe(true);
    expect(aa?.severity).toBe(1);
    expect(aaa?.severity).toBe(1);
  });
});

describe("overflow bands", () => {
  /**
   * A share of the viewport, because 40px off a 390px phone and 40px off a
   * 1440px desktop are not the same event.
   */
  it("bands the excess as a share of the viewport, on the exact boundary", () => {
    // Mobile is 390px wide: 39px is exactly a tenth, 195px exactly a half.
    expect(overflowSeverity(39, "mobile")).toBe(1);
    expect(overflowSeverity(39.1, "mobile")).toBe(2);
    expect(overflowSeverity(195, "mobile")).toBe(2);
    expect(overflowSeverity(195.1, "mobile")).toBe(3);
    // Desktop is 1440px, and the same pixel count lands in a different band.
    expect(overflowSeverity(144, "desktop")).toBe(1);
    expect(overflowSeverity(144.1, "desktop")).toBe(2);
    expect(overflowSeverity(720, "desktop")).toBe(2);
    expect(overflowSeverity(720.1, "desktop")).toBe(3);
  });

  it("emits no band at all for a viewport it has no width for", () => {
    // A real path, not a formality: `Viewport` arrives from a capture service
    // and this module validates nothing. Dividing by an unknown width would
    // manufacture a band, and a manufactured band gates.
    const unknown = "watch" as unknown as Viewport;
    expect(overflowSeverity(120, unknown)).toBeUndefined();
    expect(overflowSeverity(Number.NaN, "mobile")).toBeUndefined();
  });

  const wide = (over: Partial<TextNodeStyle> = {}) =>
    textNode({
      viewport: "mobile",
      rect: rect(300, 24),
      overflowX: "visible",
      ancestorScrollsX: false,
      ...over,
    });

  it("carries the band out of the check, for an escape and for a clip alike", () => {
    // 39px past the edge of a 390px phone: a word or two.
    expect(overflowViolations([wide({ contentWidthPx: 339 })])[0]?.severity).toBe(1);
    // 180px: most of the way across the phone, and still short of half of it.
    expect(overflowViolations([wide({ contentWidthPx: 480 })])[0]?.severity).toBe(2);
    // 400px: more than the viewport itself, the page laid out for a width it
    // was never given.
    expect(overflowViolations([wide({ contentWidthPx: 700 })])[0]?.severity).toBe(3);

    // A clip spills the same pixels past the same viewport. The band says how
    // far the page came apart, not what the box did about it.
    const clipped = overflowViolations([
      wide({ contentWidthPx: 700, overflowX: "hidden", textOverflow: "clip", whiteSpace: "nowrap" }),
    ]);
    expect(clipped[0]?.detail).toContain("clipped away");
    expect(clipped[0]?.severity).toBe(3);
  });

  it("leaves the field absent when the check could not band it", () => {
    const [unbanded] = overflowViolations([
      wide({ contentWidthPx: 700, viewport: "watch" as unknown as Viewport }),
    ]);
    expect(unbanded).toBeDefined();
    expect(unbanded).not.toHaveProperty("severity");
    // The measurement itself is unaffected: a band nobody could compute costs
    // the band, never the violation.
    expect(unbanded?.detail).toContain("horizontal overflow");
  });
});

describe("a group speaks for its worst part", () => {
  const finding = (over: Partial<DeterministicFinding> = {}): DeterministicFinding => ({
    kind: "contrast",
    route: "/",
    viewport: "mobile",
    selector: "#hero",
    detail: "text contrast 2.31:1 is below WCAG AA 4.5:1",
    blockEligible: true,
    severity: 1,
    ...over,
  });

  it("takes the WORST member's band, whichever order they arrive in", () => {
    // The opposite rule to `blockEligible`, on purpose. That one asks "may this
    // fail a build", where one doubt is enough to say no; this one asks "how
    // bad does this get", where the answer is the maximum. A row that reported
    // band 1 while one of its viewports sat at band 3 would understate the page
    // and hide a real worsening from a consumer comparing bands across commits.
    const worstLast = toMeasurementReport([
      finding({ viewport: "mobile", severity: 1 }),
      finding({ viewport: "tablet", severity: 3 }),
    ]);
    expect(worstLast.violations[0]?.viewports).toEqual(["mobile", "tablet"]);
    expect(worstLast.violations[0]?.severity).toBe(3);

    const worstFirst = toMeasurementReport([
      finding({ viewport: "mobile", severity: 3 }),
      finding({ viewport: "tablet", severity: 1 }),
    ]);
    expect(worstFirst.violations[0]?.severity).toBe(3);
  });

  it("keeps a band a member did measure when another member has none", () => {
    // Silence from one member is not a reason to throw away the only answer
    // anyone has. Absent survives only when NOTHING knew.
    const { severity: _unbanded, ...withoutBand } = finding({ viewport: "tablet" });
    const bandedFirst = toMeasurementReport([finding({ viewport: "mobile", severity: 2 }), withoutBand]);
    expect(bandedFirst.violations[0]?.severity).toBe(2);

    const bandedSecond = toMeasurementReport([withoutBand, finding({ viewport: "mobile", severity: 2 })]);
    expect(bandedSecond.violations[0]?.severity).toBe(2);
  });

  it("leaves the field absent when no member has a band, rather than emitting a zero", () => {
    // The whole reason the field is optional. A group of unbanded measurements
    // knows nothing about how bad it is, and `severity: 0` would be a claim
    // that it is the least bad there is.
    const { severity: _a, ...mobile } = finding({ viewport: "mobile" });
    const { severity: _b, ...tablet } = finding({ viewport: "tablet" });
    const report = toMeasurementReport([mobile, tablet]);
    const [group] = report.violations;
    expect(group?.viewports).toEqual(["mobile", "tablet"]);
    expect(group).not.toHaveProperty("severity");
    // And it survives the trip a consumer actually makes it take.
    expect(JSON.parse(JSON.stringify(group))).not.toHaveProperty("severity");
  });

  it("keeps a zero band, which is a band", () => {
    // Zero is a band; absent is not a band. Conflating them would let an
    // unknown gate, so the grouping has to be able to carry a zero through.
    const report = toMeasurementReport([
      finding({ viewport: "mobile", severity: 0 }),
      finding({ viewport: "tablet", severity: 0 }),
    ]);
    expect(report.violations[0]).toHaveProperty("severity", 0);
  });

  it("never mixes bands across kinds", () => {
    // Two kinds are two groups, and their bands never meet. A contrast 1 and an
    // overflow 3 are not comparable and the grouping key is what guarantees the
    // comparison is never attempted.
    const report = toMeasurementReport([
      finding({ kind: "contrast", severity: 1 }),
      finding({ kind: "overflow", detail: "content width 520px exceeds container 375px", severity: 3 }),
    ]);
    expect(report.violations).toHaveLength(2);
    expect(report.violations.map((violation) => violation.severity)).toEqual([1, 3]);
  });

  it("bands a group independently of whether it may gate", () => {
    // A group that one inconclusive viewport made non-gateable still reports
    // how bad it is. Precision and badness are different questions.
    const report = toMeasurementReport([
      finding({ viewport: "mobile", blockEligible: true, severity: 1 }),
      finding({ viewport: "tablet", blockEligible: false, severity: 3 }),
    ]);
    expect(report.violations[0]?.blockEligible).toBe(false);
    expect(report.violations[0]?.severity).toBe(3);
  });
});
