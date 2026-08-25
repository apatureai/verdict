import { describe, expect, it } from "vitest";
import {
  BREAKAGE_KINDS,
  classifyClip,
  contrastRatio,
  contrastViolations,
  deterministicChecks,
  isBreakage,
  overflowViolations,
  touchTargetViolations,
  type DeterministicFinding,
  type InteractiveElement,
  type TextNodeStyle,
} from "../src/index.js";

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
  ...over,
});

describe("contrast math", () => {
  it("computes the WCAG contrast ratio (black on white = 21:1)", () => {
    const ratio = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
    expect(ratio).toBeCloseTo(21, 0);
  });
});

describe("contrast violations", () => {
  it("flags low-contrast text and passes high-contrast text", () => {
    const low = textNode({ color: "#aaaaaa", backgroundColor: "#ffffff" }); // ~2.3:1
    const high = textNode({ color: "#000000", backgroundColor: "#ffffff" });
    expect(contrastViolations([low, high])).toHaveLength(1);
    expect(contrastViolations([low, high])[0]?.kind).toBe("contrast");
  });

  it("applies the relaxed large-text threshold", () => {
    // ratio ~3.3:1 fails for normal text but passes large text (>=24px).
    const color = "#949494";
    expect(contrastViolations([textNode({ color, fontSizePx: 16 })])).toHaveLength(1);
    expect(contrastViolations([textNode({ color, fontSizePx: 28 })])).toHaveLength(0);
  });

  it("stays silent when a color cannot be parsed (no guessing)", () => {
    expect(contrastViolations([textNode({ color: "var(--fg)" })])).toEqual([]);
    expect(contrastViolations([textNode({ color: "oklch(0.7 0.1 200)" })])).toEqual([]);
  });

  it("stays silent when the backdrop could not be determined", () => {
    // The regression this guards: an unresolved backdrop used to arrive as the
    // transparent string `rgba(0, 0, 0, 0)`, which parsed as opaque black and
    // reported black-on-white body text as 1.00:1.
    expect(contrastViolations([textNode({ backgroundColor: null })])).toEqual([]);
    expect(contrastViolations([textNode({ backgroundColor: "rgba(0, 0, 0, 0)" })])).toEqual([]);
  });

  it("composites translucent text onto the backdrop before measuring", () => {
    // rgba(0,0,0,.45) over white renders as rgb(140,140,140): 3.36:1, a real
    // violation. Read as opaque black it would be 21:1 and silently missed.
    const faded = textNode({ color: "rgba(0, 0, 0, 0.45)", backgroundColor: "#ffffff" });
    const [violation] = contrastViolations([faded]);
    expect(violation?.detail).toBe("text contrast 3.36:1 is below WCAG AA 4.5:1");
    // …and the same text at 55% clears the bar, so this is a measurement, not a
    // blanket "translucent text fails" rule.
    expect(contrastViolations([textNode({ color: "rgba(0, 0, 0, 0.55)" })])).toEqual([]);
  });

  it("ignores fully transparent text rather than measuring an invisible color", () => {
    expect(contrastViolations([textNode({ color: "rgba(0, 0, 0, 0)" })])).toEqual([]);
  });
});

/**
 * Text over a gradient, which is a backdrop with no single colour.
 *
 * The precision pass declined every `background-image`, which is right for a
 * photograph and took a computable `linear-gradient(#ffffff, #eaf2ff)` with it.
 * A gradient resolves to a SET of backdrops, and the measurement is the worst
 * of them, because a ratio that fails anywhere on the element is a real failure
 * somewhere on the element.
 */
describe("contrast against a computable gradient", () => {
  const overGradient = (over: Partial<TextNodeStyle> = {}) =>
    textNode({
      color: "#ffffff",
      backgroundColor: null,
      backdropObscured: true,
      backgroundGradient: ["rgb(27, 58, 107)", "rgb(234, 242, 255)"],
      ...over,
    });

  it("measures the worst stop and says that is what it measured", () => {
    const [violation] = contrastViolations([overGradient()]);
    // 1.13:1 at the #eaf2ff end. At the other end the same text is 10:1, and
    // reporting THAT would be a true number about the wrong half of the element.
    expect(violation?.detail).toBe(
      "advisory: text contrast 1.13:1 at the worst stop of the background gradient " +
        "is below WCAG AA 4.5:1",
    );
  });

  it("never gates on a gradient, however exact the stops are", () => {
    // The arithmetic is exact; the geometry is not. The engine knows what the
    // element paints and not where inside it the glyphs sit, so the worst stop
    // may be off to one side of the text measured against it.
    expect(contrastViolations([overGradient()])[0]?.blockEligible).toBe(false);
  });

  it("says nothing when the text clears the bar at every stop", () => {
    // The guard is a measurement, not a rule that a gradient is a defect.
    const readable = overGradient({
      color: "#14243d",
      backgroundGradient: ["rgb(255, 255, 255)", "rgb(234, 242, 255)"],
    });
    expect(contrastViolations([readable])).toEqual([]);
    // …and the SAME text over the dark end of the original gradient does fail,
    // which is what "worst stop" means: both ends are measured, not the last.
    expect(contrastViolations([overGradient({ color: "#14243d" })])[0]?.detail).toContain(
      "1.38:1 at the worst stop",
    );
  });

  it("still declines a backdrop that resolved to no stops at all", () => {
    // A photograph, a backdrop-filter, a stop in a colour space this engine
    // does not read: all of them arrive here as an obscured backdrop with no
    // resolved gradient, and all of them stay silent.
    expect(contrastViolations([overGradient({ backgroundGradient: undefined })])).toEqual([]);
    expect(contrastViolations([overGradient({ backgroundGradient: [] })])).toEqual([]);
  });

  it("ignores a resolved gradient once the backdrop is known to be a flat fill", () => {
    // `backdropObscured: false` is the extractor saying there is no image. A
    // stale gradient field must not overrule it, and the flat measurement keeps
    // its block-eligibility.
    const [violation] = contrastViolations([
      overGradient({
        backdropObscured: false,
        backgroundColor: "#ffffff",
        color: "#aaaaaa",
      }),
    ]);
    expect(violation?.detail).toBe("text contrast 2.32:1 is below WCAG AA 4.5:1");
    expect(violation?.blockEligible).toBe(true);
  });
});

describe("overflow violations", () => {
  const wide = (over: Partial<TextNodeStyle> = {}) =>
    textNode({ contentWidthPx: 260, rect: rect(200, 20), ...over });

  it("flags content wider than its container", () => {
    expect(overflowViolations([wide()])).toHaveLength(1);
    expect(overflowViolations([textNode({ contentWidthPx: 190, rect: rect(200, 20) })])).toHaveLength(0);
  });

  it("does not flag a fractional box whose content rounds up to the same width", () => {
    // Chromium rounds scrollWidth to an integer while the box keeps its fraction,
    // so a three-column flex row reports contentWidthPx 234 against a 233.66px
    // box and every column looks clipped by 0.34px. Without the rounding
    // allowance this engine blocks merges on ordinary layouts, and the sentence
    // it prints contradicts itself: "234px exceeds 234px and 0.34px is clipped".
    for (const width of [233.66, 233.01, 233.999, 100.5]) {
      const content = Math.ceil(width);
      expect(
        overflowViolations([
          textNode({ contentWidthPx: content, rect: rect(width, 20), overflowX: "hidden" }),
        ]),
      ).toHaveLength(0);
    }
  });

  it("does not gate an animated clip, whose affordance is the motion", () => {
    // A marquee or ticker is clipped on purpose and the content scrolls into
    // view on its own. No computed style says so and a single screenshot cannot
    // show it, so this was gating as content loss while the extractor already
    // knew the element was animated.
    const marquee = textNode({
      contentWidthPx: 900,
      rect: rect(200, 20),
      overflowX: "hidden",
      textOverflow: "clip",
      whiteSpace: "nowrap",
      animated: true,
    });
    const found = overflowViolations([marquee]);
    expect(found).toHaveLength(1);
    // Still reported, because a clipped marquee may genuinely be broken. Not
    // gated, because nothing in computed style can tell the two apart.
    expect(found[0]!.blockEligible).toBe(false);
    expect(found[0]!.detail).toContain("animated");
  });

  it("still gates the same clip when nothing reported it as animated", () => {
    const still = textNode({
      contentWidthPx: 900,
      rect: rect(200, 20),
      overflowX: "hidden",
      textOverflow: "clip",
      whiteSpace: "nowrap",
    });
    expect(overflowViolations([still])[0]!.blockEligible).toBe(true);
  });

  it("still flags a fractional box clipped by more than the rounding allowance", () => {
    // The allowance is one rounding step, not a general tolerance: real content
    // loss on a fractional box has to survive it.
    expect(
      overflowViolations([
        textNode({ contentWidthPx: 260, rect: rect(233.66, 20), overflowX: "hidden" }),
      ]),
    ).toHaveLength(1);
  });

  it("says nothing about an element that scrolls on purpose", () => {
    // The `<pre>` with a scrollbar, the carousel, the scrollable table. All
    // three have scrollWidth wider than the box on every render, forever.
    for (const overflowX of ["auto", "scroll", "overlay"]) {
      expect(overflowViolations([wide({ overflowX })])).toEqual([]);
    }
  });

  it("says nothing when an ancestor is the scroller", () => {
    // The commonest shape in real markup: a wide row inside a .table-wrap. The
    // row itself computes `overflow-x: visible` and is entirely reachable.
    expect(overflowViolations([wide({ overflowX: "visible", ancestorScrollsX: true })])).toEqual([]);
  });

  it("still reports clipped content, which no reader can reach", () => {
    // `hidden` and `clip` also declare what happens to the excess, and what
    // happens is that it is cut off. That stays worth reporting.
    for (const overflowX of ["hidden", "clip"]) {
      expect(overflowViolations([wide({ overflowX })])).toHaveLength(1);
    }
  });
});

/**
 * What a clip MEANS, which is the question that kept the commonest real
 * overflow defect at advisory forever.
 *
 * `overflow-x: hidden` with content wider than the box is a truncated card
 * title and a lost invoice number at the same measurement, so the check used to
 * report both the same way and gate on neither. These are the three answers,
 * and the third one is not a rounding error to be pushed into one of the other
 * two: an affordance that cannot be established is not an affordance that is
 * absent.
 */
describe("clip intent", () => {
  const clipped = (over: Partial<TextNodeStyle> = {}) =>
    textNode({
      contentWidthPx: 460,
      rect: rect(220, 24),
      overflowX: "hidden",
      textOverflow: "clip",
      whiteSpace: "nowrap",
      ...over,
    });

  it("says nothing about a line the author truncated with an ellipsis", () => {
    // The card title, the table cell, the file name: cut on purpose, and the
    // ellipsis at the edge is the reader being told so.
    const truncated = clipped({ textOverflow: "ellipsis" });
    expect(classifyClip(truncated)).toEqual({ verdict: "deliberate_truncation" });
    expect(overflowViolations([truncated])).toEqual([]);
    // `clip` is the initial value; any other value paints a mark. A custom
    // string is `text-overflow: "…"`, which is the same intent spelled out.
    expect(classifyClip(clipped({ textOverflow: '"…"' })).verdict).toBe("deliberate_truncation");
    // `pre` does not wrap either, so the mark renders there too.
    expect(classifyClip(clipped({ textOverflow: "ellipsis", whiteSpace: "pre" })).verdict).toBe(
      "deliberate_truncation",
    );
  });

  it("gates a clip that cut the content with nothing to show for it", () => {
    const [violation] = overflowViolations([clipped()]);
    expect(classifyClip(clipped())).toEqual({ verdict: "content_loss" });
    expect(violation?.blockEligible).toBe(true);
    // The sentence names the properties the decision was made from, and how
    // much content the clip took.
    expect(violation?.detail).toBe(
      "content width 460px exceeds container 220px and 240px of it is clipped away with no " +
        "truncation affordance (overflow-x: hidden, text-overflow: clip, white-space: nowrap)",
    );
    // `overflow-x: clip` cuts exactly the same way.
    expect(overflowViolations([clipped({ overflowX: "clip" })])[0]?.blockEligible).toBe(true);
  });

  it("reports without gating when the affordance cannot be established, and says why", () => {
    // Wrapping content: `text-overflow` acts on a line that overflows its box,
    // and whether one does here depends on what lands on it.
    const wrapping = clipped({ textOverflow: "ellipsis", whiteSpace: "normal" });
    expect(classifyClip(wrapping)).toEqual({
      verdict: "indeterminate",
      reason: "a truncation mark on wrapping content may not be rendered at all",
    });
    const [reported] = overflowViolations([wrapping]);
    expect(reported?.blockEligible).toBe(false);
    expect(reported?.detail).toBe(
      "content width 460px exceeds container 220px and is clipped (overflow-x: hidden, " +
        "text-overflow: ellipsis, white-space: normal); not gated because a truncation mark on " +
        "wrapping content may not be rendered at all",
    );
  });

  it("does not gate the visually-hidden idiom, whose whole purpose is to clip", () => {
    // `width: 1px; height: 1px; overflow: hidden` is what every design system
    // ships for screen-reader-only text. Its content really is clipped away,
    // and failing a build on it would fail a build on an accessibility feature.
    const srOnly = clipped({ rect: { x: 0, y: 0, width: 1, height: 1 }, contentWidthPx: 365 });
    const [reported] = overflowViolations([srOnly]);
    expect(reported?.blockEligible).toBe(false);
    expect(reported?.detail).toContain(
      "not gated because a 1x1px box is the visually-hidden idiom, not a box content is rendered in",
    );
  });

  it("does not gate a clip whose text-overflow the capture never reported", () => {
    // Deploy skew: the capture fleet ships separately from the engine, and a
    // fleet that predates these fields says nothing. Reading that silence as
    // the initial value `clip` would make every truncated card title on every
    // page a merge blocker on the day this shipped.
    const older = clipped({ textOverflow: undefined, whiteSpace: undefined });
    const [reported] = overflowViolations([older]);
    expect(reported?.blockEligible).toBe(false);
    expect(reported?.detail).toContain(
      "not gated because the capture did not report text-overflow",
    );
    expect(reported?.detail).toContain("text-overflow: not reported");
    // An empty string is the same absence by another route.
    expect(classifyClip(clipped({ textOverflow: "" })).verdict).toBe("indeterminate");
  });

  it("does not let an ancestor scroller excuse a clip the element made itself", () => {
    // A wrapper that scrolls brings its OWN overflow into reach. It does
    // nothing for content this element already cut at its own edge, and the
    // check used to drop the finding entirely on that rescue.
    const inScroller = clipped({ ancestorScrollsX: true });
    const [violation] = overflowViolations([inScroller]);
    expect(violation?.blockEligible).toBe(true);
    // …while an element that does not clip is still rescued by that ancestor.
    expect(
      overflowViolations([clipped({ overflowX: "visible", ancestorScrollsX: true })]),
    ).toEqual([]);
  });
});

describe("touch-target violations", () => {
  const el = (w: number, h: number, y: number, n: number): InteractiveElement => ({
    route: "/",
    viewport: "mobile",
    selector: `button:nth-of-type(${n})`,
    role: "button",
    rect: { x: 0, y, width: w, height: h },
    inlineTarget: false,
  });

  /**
   * Two targets stacked 2px apart: close enough that a 24px circle centred on
   * one reaches the other, which is the crowding SC 2.5.8 is about. Without it
   * the Spacing exception applies and neither is a failure.
   */
  const crowded = (w: number, h: number): InteractiveElement[] => [
    el(w, h, 0, 1),
    el(w, h, h + 2, 2),
  ];

  it("flags sub-24px targets and passes large enough ones", () => {
    expect(touchTargetViolations(crowded(20, 20))).toHaveLength(2);
    expect(touchTargetViolations(crowded(48, 48))).toHaveLength(0);
    // One dimension too small is still a violation.
    expect(touchTargetViolations(crowded(48, 20))).toHaveLength(2);
  });

  it("measures AA by default and names the criterion it applied", () => {
    const [violation] = touchTargetViolations(crowded(20, 20));
    expect(violation?.detail).toBe(
      "touch target 20x20px is below the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA",
    );
  });

  it("measures 2.5.5 as a failure only when asked, and says so", () => {
    // A 30x30 control clears AA and fails the AAA line. Under the default that
    // is never phrased as a 2.5.8 failure, because it is not one.
    const [banded] = touchTargetViolations(crowded(30, 30));
    expect(banded?.detail).not.toContain("below the 24x24px minimum");
    const [strict] = touchTargetViolations(crowded(30, 30), { criterion: "AAA" });
    expect(strict?.detail).toBe(
      "touch target 30x30px is below the 44x44px minimum in WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA",
    );
    expect(strict?.blockEligible).toBe(true);
  });

  it("reports the band between the two criteria as an advisory, on touch only", () => {
    // The gap the move from 44 to 24 opened. A 32px control is comfortable
    // under a mouse and mis-tapped on a phone, and for a while it was reported
    // nowhere at all. It is reported now, naming both bars and gating nothing,
    // because the repository never committed to AAA.
    const [advisory, second] = touchTargetViolations(crowded(32, 32));
    expect(advisory?.detail).toBe(
      "advisory: touch target 32x32px meets the 24x24px minimum in WCAG 2.2 SC 2.5.8 " +
        "Target Size (Minimum), level AA, and is below the 44x44px minimum in " +
        "WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA",
    );
    expect(advisory?.blockEligible).toBe(false);
    expect(second?.blockEligible).toBe(false);

    // A pointer criterion, still only where a finger is.
    const desktop = crowded(32, 32).map((target) => ({ ...target, viewport: "desktop" as const }));
    expect(touchTargetViolations(desktop)).toEqual([]);

    // Above the AAA line there is no band left to report.
    expect(touchTargetViolations(crowded(48, 48))).toEqual([]);
  });

  it("does not re-report a target the AA spacing exception already excused", () => {
    // A 20x20 control with clear space around it passes 2.5.8 through the
    // exception the criterion grants it. Reporting it one line lower as an AAA
    // advisory would take that exception back through a side door, and it is
    // one of the pages the precision pass made silent.
    const isolated: InteractiveElement = {
      route: "/",
      viewport: "mobile",
      selector: "#isolated",
      role: "button",
      rect: { x: 0, y: 0, width: 20, height: 20 },
      inlineTarget: false,
    };
    expect(touchTargetViolations([isolated])).toEqual([]);
  });

  it("keeps the Inline exception across both tiers", () => {
    // A 32px link inside a sentence is in the advisory band by size, and both
    // criteria exempt exactly that shape by name.
    const inline = crowded(32, 32).map((target) => ({ ...target, inlineTarget: true }));
    expect(touchTargetViolations(inline)).toEqual([]);
  });
});

describe("deterministicChecks", () => {
  it("aggregates all check kinds as facts for the prompt", () => {
    const findings = deterministicChecks({
      textNodes: [
        textNode({ color: "#bbbbbb", backgroundColor: "#ffffff" }), // contrast
        textNode({ contentWidthPx: 300, rect: rect(200, 20) }), // overflow
      ],
      interactive: [
        {
          route: "/",
          viewport: "mobile",
          selector: "a",
          role: "link",
          rect: { x: 0, y: 0, width: 20, height: 20 },
        },
        {
          route: "/",
          viewport: "mobile",
          selector: "a:nth-of-type(2)",
          role: "link",
          rect: { x: 22, y: 0, width: 20, height: 20 },
        },
      ],
    });
    const kinds = [...new Set(findings.map((f) => f.kind))].sort();
    expect(kinds).toEqual(["contrast", "overflow", "touch_target"]);
  });

  it("passes the requested target-size criterion through to the touch check", () => {
    const interactive: InteractiveElement[] = [
      { route: "/", viewport: "mobile", selector: "a", role: "link", rect: rect(30, 30) },
    ];
    // Same 30x30 target, two different statements about it: a suggestion under
    // the default, a gateable failure for a repository that chose AAA.
    const [byDefault] = deterministicChecks({ textNodes: [], interactive });
    expect(byDefault?.blockEligible).toBe(false);
    expect(byDefault?.detail).toMatch(/^advisory: /);

    const strict = deterministicChecks({
      textNodes: [],
      interactive,
      touchTargetCriterion: "AAA",
    });
    expect(strict).toHaveLength(1);
    expect(strict[0]?.detail).toContain("is below the 44x44px minimum");
  });
});

/**
 * Which measurements count as BREAKAGE (#2).
 *
 * The distinction is load-bearing rather than cosmetic: breakage is what
 * overrules a triage pass that declined to look, so widening it changes what
 * gets a deep model call and narrowing it silently loses one.
 */
describe("BREAKAGE_KINDS", () => {
  const measured = (kind: "contrast" | "overflow" | "touch_target"): DeterministicFinding => ({
    kind,
    route: "/",
    viewport: "mobile",
    selector: "#x",
    detail: "detail",
  });

  it("counts overflow: content wider than its container is the page coming apart", () => {
    expect(isBreakage(measured("overflow"))).toBe(true);
  });

  it("does NOT count contrast or touch targets", () => {
    // Both are real, reliably measured defects, and both are already threaded
    // into the deep prompt as facts. Neither is evidence the page rendered
    // wrong: they are properties of a page that rendered exactly as laid out.
    expect(isBreakage(measured("contrast"))).toBe(false);
    expect(isBreakage(measured("touch_target"))).toBe(false);
  });

  it("counts page_overflow: a page that does not fit its viewport is coming apart", () => {
    expect(isBreakage({ ...measured("overflow"), kind: "page_overflow" })).toBe(true);
  });

  it("keeps the classification in one reviewable place", () => {
    expect([...BREAKAGE_KINDS]).toEqual(["overflow", "page_overflow"]);
  });
});
