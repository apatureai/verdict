import { describe, expect, it } from "vitest";
import {
  AA_TOUCH_TARGET_PX,
  AAA_TOUCH_TARGET_PX,
  DEFAULT_TOUCH_TARGET_CRITERION,
  TOUCH_TARGET_CRITERIA,
  TOUCH_VIEWPORTS,
  contrastViolations,
  overflowViolations,
  toMeasurementReport,
  touchTargetViolations,
  type DeterministicFinding,
  type InteractiveElement,
  type TextNodeStyle,
} from "../src/index.js";

/**
 * What each check will and will not stand behind.
 *
 * The engine owns PRECISION and a consumer owns POLICY, and there are three
 * distinct answers a check can give, not two:
 *
 *   - DECLINED. The number is not computable from what was captured, so no
 *     measurement is emitted at all. Contrast over a photograph and the
 *     scrollable `<pre>` are here: one would publish a false ratio, the other a
 *     false claim of breakage.
 *   - REPORTED. Measured and true, but something the capture could not evaluate
 *     leaves room for the finding to be explained away. `blockEligible` false.
 *   - GATEABLE. Measured, and every question the check knows how to ask was
 *     answered. `blockEligible` true.
 *
 * Each of the three checks had a false-positive class that put real pages in
 * the wrong bucket, and each one is pinned below.
 */

const rect = (width: number, height: number) => ({ x: 0, y: 0, width, height });

const textNode = (over: Partial<TextNodeStyle> = {}): TextNodeStyle => ({
  route: "/",
  viewport: "desktop",
  selector: "#promo-code",
  fontSizePx: 16,
  fontWeight: 400,
  color: "#000000",
  backgroundColor: "#ffffff",
  rect: rect(140, 20),
  contentWidthPx: 345,
  ...over,
});

const interactive = (over: Partial<InteractiveElement> = {}): InteractiveElement => ({
  route: "/",
  viewport: "mobile",
  selector: "#icon-close",
  role: null,
  rect: rect(20, 20),
  inlineTarget: false,
  ...over,
});

/** A neighbour 2px away, so no target under test wins the spacing exception. */
const crowd = (el: InteractiveElement): InteractiveElement[] => [
  el,
  {
    ...el,
    selector: `${el.selector}-neighbour`,
    rect: { ...el.rect, x: el.rect.x + el.rect.width + 2 },
  },
];

describe("overflow: scroll containers (P1)", () => {
  it("T8: an element that scrolls on purpose produces no measurement at all", () => {
    // It used to produce one, marked advisory. Advisory was still wrong: the
    // sentence "content width 734px exceeds container 480px" is put in front of
    // a reader as a measured fact about a `<pre>` that is working perfectly,
    // and `overflow` is the one kind that overrules a triage pass.
    expect(overflowViolations([textNode({ overflowX: "auto" })])).toEqual([]);
    expect(overflowViolations([textNode({ overflowX: "scroll" })])).toEqual([]);
  });

  it("an ancestor scroller silences it too", () => {
    expect(
      overflowViolations([textNode({ overflowX: "visible", ancestorScrollsX: true })]),
    ).toEqual([]);
  });

  it("only an escape from every scroller is gateable", () => {
    const [gateable] = overflowViolations([
      textNode({ overflowX: "visible", ancestorScrollsX: false }),
    ]);
    expect(gateable?.kind).toBe("overflow");
    expect(gateable?.detail).toContain("exceeds container");
    expect(gateable?.blockEligible).toBe(true);
  });

  it("a clipped element is reported and not gated", () => {
    for (const overflowX of ["hidden", "clip"]) {
      const [violation] = overflowViolations([textNode({ overflowX, ancestorScrollsX: false })]);
      expect(violation).toBeDefined();
      expect(violation?.blockEligible).toBe(false);
    }
  });

  it("a capture that did not report either field is reported, not gated", () => {
    // A pre-upgrade capture fleet. Unknown is never read as `visible`, and it is
    // never read as "no ancestor scrolls" either.
    const [unknownBoth] = overflowViolations([textNode()]);
    expect(unknownBoth).toBeDefined();
    expect(unknownBoth?.blockEligible).toBe(false);

    const [unknownAncestor] = overflowViolations([textNode({ overflowX: "visible" })]);
    expect(unknownAncestor?.blockEligible).toBe(false);
  });
});

describe("touch targets: the criterion actually applied (P2)", () => {
  it("defaults to the AA criterion, with AAA available", () => {
    expect(DEFAULT_TOUCH_TARGET_CRITERION).toBe("AA");
    expect(AA_TOUCH_TARGET_PX).toBe(24);
    expect(AAA_TOUCH_TARGET_PX).toBe(44);
    expect(TOUCH_TARGET_CRITERIA.AA).toMatchObject({ sc: "2.5.8", level: "AA", minPx: 24 });
    expect(TOUCH_TARGET_CRITERIA.AAA).toMatchObject({ sc: "2.5.5", level: "AAA", minPx: 44 });
  });

  it("T7: a 28x28 target is not an AA failure and is never reported as one", () => {
    // The case the old text called a violation "below 44x44px" while citing
    // 2.5.5 without its level, which reads as a conformance failure and is not.
    const [advisory] = touchTargetViolations(crowd(interactive({ rect: rect(28, 28) })));
    expect(advisory?.detail).not.toContain("below the 24x24px minimum");
    expect(advisory?.detail).toContain("meets the 24x24px minimum in WCAG 2.2 SC 2.5.8");
    // …and it is not silent either, which is the other half of the same claim.
    // 28px is inside the range 2.5.5 exists because of, so it is reported as a
    // suggestion, said so in the sentence, and it gates nothing.
    expect(advisory?.detail).toMatch(/^advisory: /);
    expect(advisory?.detail).toContain("below the 44x44px minimum in WCAG 2.2 SC 2.5.5");
    expect(advisory?.blockEligible).toBe(false);

    // Asked for AAA explicitly, the same target is a failure of the criterion
    // the repository chose: phrased as a failure, and gateable.
    const [strict] = touchTargetViolations(crowd(interactive({ rect: rect(28, 28) })), {
      criterion: "AAA",
    });
    expect(strict?.detail).toBe(
      "touch target 28x28px is below the 44x44px minimum in WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA",
    );
    expect(strict?.blockEligible).toBe(true);
  });

  it("a 20x20 crowded mobile target fails AA, and says which criterion", () => {
    const [violation] = touchTargetViolations(crowd(interactive()));
    expect(violation?.detail).toContain("WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA");
    expect(violation?.blockEligible).toBe(true);
  });

  it("does not run on a desktop pointer surface", () => {
    // 2.5.8 is about a finger. Measuring a mouse-driven 1440px page against it
    // and then declining to gate would still put a false WCAG claim on screen.
    expect([...TOUCH_VIEWPORTS]).toEqual(["mobile", "tablet"]);
    expect(touchTargetViolations(crowd(interactive({ viewport: "desktop" })))).toEqual([]);
    expect(touchTargetViolations(crowd(interactive({ viewport: "tablet" })))).toHaveLength(2);
  });

  it("honours the Spacing exception, which is part of 2.5.8", () => {
    // A 20x20 control with clear space around it does not fail 2.5.8. Citing
    // the criterion while ignoring its exceptions is citing it incorrectly.
    expect(touchTargetViolations([interactive()])).toEqual([]);
    // …and 2.5.5 has no spacing relief, so the same element fails the AAA line.
    expect(touchTargetViolations([interactive()], { criterion: "AAA" })).toHaveLength(1);
  });

  it("the Spacing exception is broken by a large neighbour, not only a small one", () => {
    // 2.5.8 says the circle must not intersect ANOTHER TARGET, and separately
    // must not intersect another undersized target's circle. A 12x12 icon
    // tucked 2px from a 200x48 Save button has its circle inside that button
    // while the two centres are over 100px apart, so the centre rule alone
    // misses it entirely.
    const icon = interactive({ selector: "#icon-pin", rect: rect(12, 12) });
    const save: InteractiveElement = {
      ...icon,
      selector: "#save",
      rect: { x: 14, y: 0, width: 200, height: 48 },
    };
    expect(touchTargetViolations([icon, save]).map((f) => f.selector)).toEqual(["#icon-pin"]);

    // Move the same button clear of the circle and the exception applies again.
    const clear = { ...save, rect: { ...save.rect, x: 20 } };
    expect(touchTargetViolations([icon, clear])).toEqual([]);
  });

  it("honours the Inline exception for a link in a sentence", () => {
    const link = interactive({ selector: "#terms", rect: rect(42, 18), inlineTarget: true });
    expect(touchTargetViolations(crowd(link))).toEqual([]);
    expect(touchTargetViolations(crowd(link), { criterion: "AAA" })).toEqual([]);
  });

  it("a capture that never evaluated the Inline exception is reported, not gated", () => {
    const [violation] = touchTargetViolations(
      crowd(interactive()).map(({ inlineTarget: _dropped, ...rest }) => rest),
    );
    expect(violation).toBeDefined();
    expect(violation?.blockEligible).toBe(false);
  });
});

describe("contrast: a backdrop no colour can represent (P3)", () => {
  it("text over a flat colour backdrop is gateable", () => {
    const [violation] = contrastViolations([
      textNode({ color: "#8f8f8f", backgroundColor: "#ffffff", backdropObscured: false }),
    ]);
    expect(violation?.detail).toContain("below WCAG AA");
    expect(violation?.blockEligible).toBe(true);
  });

  it("T9: text over a background image is not measurable, so nothing is emitted", () => {
    // White text on a photograph over a white page flattens to 1.00:1. That is
    // not an imprecise number, it is a false one, and this engine publishes its
    // measurements as facts. Declining is the only honest answer.
    expect(
      contrastViolations([
        textNode({ color: "#ffffff", backgroundColor: "#ffffff", backdropObscured: true }),
      ]),
    ).toEqual([]);
    expect(
      contrastViolations([
        textNode({ color: "#8f8f8f", backgroundColor: "#ffffff", backdropObscured: true }),
      ]),
    ).toEqual([]);
  });

  it("a capture that did not say is reported, not gated", () => {
    const [violation] = contrastViolations([
      textNode({ color: "#8f8f8f", backgroundColor: "#ffffff" }),
    ]);
    expect(violation).toBeDefined();
    expect(violation?.blockEligible).toBe(false);
  });
});

describe("toMeasurementReport", () => {
  const finding = (over: Partial<DeterministicFinding> = {}): DeterministicFinding => ({
    kind: "contrast",
    route: "/",
    viewport: "desktop",
    selector: "#hero-subtitle",
    detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
    blockEligible: true,
    ...over,
  });

  it("collapses one defect measured at three viewports into one row", () => {
    const report = toMeasurementReport([
      finding({ viewport: "mobile" }),
      finding({ viewport: "tablet" }),
      finding({ viewport: "desktop" }),
    ]);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.viewports).toEqual(["mobile", "tablet", "desktop"]);
    expect(report.violations[0]?.element).toBe("#hero-subtitle");
  });

  it("keeps distinct elements, routes and details apart", () => {
    const report = toMeasurementReport([
      finding(),
      finding({ selector: "#footer-note" }),
      finding({ route: "/pricing" }),
      finding({ detail: "text contrast 2.10:1 is below WCAG AA 4.5:1" }),
    ]);

    expect(report.violations).toHaveLength(4);
  });

  it("one inconclusive viewport makes the whole group inconclusive", () => {
    // The group is one row a reader acts on once, so it inherits the weakest
    // precision claim in it rather than the strongest.
    const report = toMeasurementReport([
      finding({ viewport: "mobile", blockEligible: true }),
      finding({ viewport: "desktop", blockEligible: false }),
    ]);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.blockEligible).toBe(false);
  });

  it("reads an absent blockEligible as not gateable", () => {
    const { blockEligible: _dropped, ...withoutFlag } = finding();
    const report = toMeasurementReport([withoutFlag]);

    expect(report.violations[0]?.blockEligible).toBe(false);
  });

  it("states which checks ran, so an empty violations list means something", () => {
    const measuredClean = toMeasurementReport([]);
    expect(measuredClean).toEqual({
      checksRun: ["contrast", "overflow", "touch_target", "page_overflow"],
      violations: [],
    });

    const measuredNothing = toMeasurementReport([], []);
    expect(measuredNothing).toEqual({ checksRun: [], violations: [] });
  });
});
