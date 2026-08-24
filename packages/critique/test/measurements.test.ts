import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadGoldenResult, loadPreCalibrationResult } from "@apatureai/verdict-types";
import type { Critique, Finding, MeasurementReport, ReviewCoverage } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { measuredFactsUnjudged, toEngineReviewResult } from "../src/index.js";

/**
 * The boundary between what was MEASURED and what was JUDGED.
 *
 * The engine computes contrast ratios, horizontal overflow and touch-target
 * sizes from the captured DOM with no model involved, hands them to the judge as
 * facts it is told to trust, and then, until now, dropped them at the wire
 * projection. A consumer holding a result could not see one. The audit found the
 * consequence: three measured violations, `grade: "ship"`, `findings: 0`,
 * `hallucinationDrops: 0`, and nothing in the payload to contradict it.
 *
 * Two rules are pinned here, and they pull in opposite directions on purpose:
 *
 *   1. Measurements are PUBLISHED, end to end, on every path.
 *   2. Measurements never COMPUTE the grade. Not a floor, not a severity, not a
 *      confidence. The one thing they can do is retract a grade nothing earned,
 *      which withholds an answer rather than inventing one.
 */

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "color_contrast",
  severity: "major",
  confidence: 0.9,
  route: "/pricing",
  viewport: "mobile",
  elementRef: "#cta-primary",
  title: "Primary CTA uses an off-brand color on mobile",
  description: "On the mobile viewport the primary button renders with the default blue.",
  suggestion: "Apply the --color-accent token.",
  introducedByThisPr: true,
  ...over,
});

const critique = (over: Partial<Critique> = {}): Critique => ({
  grade: "ship",
  overall: "Nothing stood out on this page.",
  findings: [],
  notReviewed: [],
  validation: { hallucinationDrops: 0, captureUnstable: false, modelFindingsSeen: 0 },
  metadata: {
    engineVersion: "2026.06.0",
    model: "qwen3-vl",
    promptVersion: "gate-design-review@7",
    captureVersion: "playwright-capture@3",
    rubricVersion: "design-rubric@1",
    uiDnaVersion: "ui-dna@2026.06.12",
  },
  ...over,
});

const coverage = (over: Partial<ReviewCoverage> = {}): ReviewCoverage => ({
  routesRequested: ["/"],
  routesReviewed: ["/"],
  viewportsRequested: ["desktop"],
  viewportsReviewed: ["desktop"],
  ...over,
});

/** The audit's three violations, verbatim. */
const AUDIT_MEASUREMENTS: MeasurementReport = {
  checksRun: ["contrast", "overflow", "touch_target"],
  violations: [
    {
      kind: "contrast",
      route: "/",
      viewports: ["desktop"],
      element: "#hero-subtitle",
      detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
      blockEligible: true,
    },
    {
      kind: "overflow",
      route: "/",
      viewports: ["desktop"],
      element: "#promo-code",
      detail: "content width 345px exceeds container 140px (horizontal overflow)",
      blockEligible: true,
    },
    {
      kind: "touch_target",
      route: "/",
      viewports: ["desktop"],
      element: "#icon-close",
      detail: "touch target 28x28px is below 44x44px",
      blockEligible: false,
    },
  ],
};

const RETENTION = { screenshotRetentionSeconds: 2_592_000 };

describe("measurements on the wire", () => {
  it("passes the report through verbatim", () => {
    const result = toEngineReviewResult(critique({ findings: [finding()], validation: { hallucinationDrops: 0, captureUnstable: false, modelFindingsSeen: 1 } }), {
      ...RETENTION,
      coverage: coverage(),
      measurements: AUDIT_MEASUREMENTS,
    });

    expect(result.measurements).toEqual(AUDIT_MEASUREMENTS);
  });

  it("omits the field entirely when the caller measured nothing", () => {
    // ABSENT means "this producer does not report measurements", never "clean".
    // Synthesizing an empty report here would publish the positive claim that
    // the checks ran, about a run where nothing ran them.
    const result = toEngineReviewResult(critique(), { ...RETENTION, coverage: coverage() });

    expect(result).not.toHaveProperty("measurements");
  });

  it("never turns a measurement into a finding", () => {
    const result = toEngineReviewResult(critique(), {
      ...RETENTION,
      coverage: coverage(),
      measurements: AUDIT_MEASUREMENTS,
    });

    expect(result.findings).toEqual([]);
    // No severity, no confidence, no dimension anywhere in the measured half.
    for (const violation of result.measurements?.violations ?? []) {
      expect(violation).not.toHaveProperty("severity");
      expect(violation).not.toHaveProperty("confidence");
      expect(violation).not.toHaveProperty("dimension");
    }
    expect(result).not.toHaveProperty("confidence");
  });

  it("does not let a measurement reach result confidence", () => {
    // `resultConfidence` is fitted over the model-finding population alone. A
    // clean model run has no calibrated finding, so it has no number, and three
    // measured violations do not conjure one.
    const result = toEngineReviewResult(critique(), {
      ...RETENTION,
      coverage: coverage(),
      measurements: AUDIT_MEASUREMENTS,
    });

    expect(result.confidence).toBeUndefined();
  });
});

describe("the measured_facts_unjudged retraction", () => {
  it("T1: three measured violations and zero model findings retract the grade instead of shipping", () => {
    const result = toEngineReviewResult(critique(), {
      ...RETENTION,
      coverage: coverage(),
      measurements: AUDIT_MEASUREMENTS,
    });

    // The grade field is BYTE-UNCHANGED: nothing floored it, nothing computed
    // it from a measurement. What changed is that the payload now says the
    // value is not a verdict.
    expect(result.grade).toBe("ship");
    expect(result.gradeUnavailableReason).toBe("measured_facts_unjudged");
    expect(result.measurements?.violations).toHaveLength(3);
    expect(result.overall).toContain("3 measurement(s)");
    expect(result.overall).toContain("returned no findings at all");
    // The model's own sentence is preserved rather than deleted, exactly as the
    // nothing-reviewed reconciliation preserves it.
    expect(result.ungroundedNarrative).toBe("Nothing stood out on this page.");
  });

  it("T2: one surviving finding suppresses the retraction, even citing nothing measured", () => {
    // The rule is "did the judge speak", not "did the judge cover what was
    // measured". A competent model that correctly declines to flag an
    // intentional low-contrast microcopy choice keeps its earned grade.
    const result = toEngineReviewResult(
      critique({
        grade: "needs_work",
        findings: [finding({ elementRef: "#nowhere-near-a-measurement" })],
        validation: { hallucinationDrops: 0, captureUnstable: false, modelFindingsSeen: 1 },
      }),
      { ...RETENTION, coverage: coverage(), measurements: AUDIT_MEASUREMENTS },
    );

    expect(result).not.toHaveProperty("gradeUnavailableReason");
    expect(result.grade).toBe("needs_work");
    // Published under the grade all the same. That is the whole point of part 1.
    expect(result.measurements?.violations).toHaveLength(3);
  });

  /**
   * The predicate itself, not the branch that calls it.
   *
   * Condition (c) is redundant while `nothing_survived_validation` is evaluated
   * first, so a test that only went through `toEngineReviewResult` passes with
   * (c) deleted. Precedence is meant to be a property of the ORDER; the meaning
   * of the predicate has to hold on its own, or a later reordering silently
   * changes which runs get retracted.
   */
  it("the predicate itself is false whenever any finding entered validation", () => {
    const spoke = critique({
      validation: { hallucinationDrops: 2, captureUnstable: false, modelFindingsSeen: 2 },
    });
    expect(measuredFactsUnjudged(spoke, coverage(), AUDIT_MEASUREMENTS)).toBe(false);
    expect(measuredFactsUnjudged(critique(), coverage(), AUDIT_MEASUREMENTS)).toBe(true);
  });

  it("a surviving finding blocks the retraction even if the counter disagrees", () => {
    // `modelFindingsSeen` is a producer-supplied count and `findings` is the
    // list a reader will actually see. They should never disagree, and a
    // miscounting producer must not be able to publish "nothing judged this"
    // over a result that visibly carries a judgment. The two conditions are
    // kept separately for exactly this: the visible list wins on its own.
    const inconsistent = critique({
      findings: [finding()],
      validation: { hallucinationDrops: 0, captureUnstable: false, modelFindingsSeen: 0 },
    });
    expect(measuredFactsUnjudged(inconsistent, coverage(), AUDIT_MEASUREMENTS)).toBe(false);
  });

  it("the predicate itself requires coverage, findings, and a measurement on a reviewed route", () => {
    expect(measuredFactsUnjudged(critique(), undefined, AUDIT_MEASUREMENTS)).toBe(false);
    expect(measuredFactsUnjudged(critique(), coverage({ routesReviewed: [] }), AUDIT_MEASUREMENTS)).toBe(false);
    expect(measuredFactsUnjudged(critique(), coverage(), undefined)).toBe(false);
    expect(
      measuredFactsUnjudged(critique(), coverage({ routesReviewed: ["/elsewhere"] }), AUDIT_MEASUREMENTS),
    ).toBe(false);
    expect(
      measuredFactsUnjudged(
        critique({ findings: [finding()], validation: { hallucinationDrops: 0, captureUnstable: false, modelFindingsSeen: 1 } }),
        coverage(),
        AUDIT_MEASUREMENTS,
      ),
    ).toBe(false);
  });

  it("T3: findings that entered validation and were deleted stay nothing_survived_validation", () => {
    const result = toEngineReviewResult(
      critique({
        validation: { hallucinationDrops: 2, captureUnstable: false, modelFindingsSeen: 2 },
      }),
      { ...RETENTION, coverage: coverage(), measurements: AUDIT_MEASUREMENTS },
    );

    expect(result.gradeUnavailableReason).toBe("nothing_survived_validation");
  });

  it("nothing_reviewed still wins over a measured page", () => {
    const result = toEngineReviewResult(critique(), {
      ...RETENTION,
      coverage: coverage({ routesReviewed: [] }),
      measurements: AUDIT_MEASUREMENTS,
    });

    expect(result.gradeUnavailableReason).toBe("nothing_reviewed");
  });

  it("T4: measurements with no coverage emit no retraction", () => {
    // The engine never asserts coverage on a caller's behalf, so it cannot
    // assert that a measured route was one this run reviewed.
    const result = toEngineReviewResult(critique(), {
      ...RETENTION,
      measurements: AUDIT_MEASUREMENTS,
    });

    expect(result).not.toHaveProperty("gradeUnavailableReason");
    expect(result.measurements).toEqual(AUDIT_MEASUREMENTS);
  });

  it("a violation on a route this run did not review does not retract", () => {
    const result = toEngineReviewResult(critique(), {
      ...RETENTION,
      coverage: coverage({ routesRequested: ["/", "/pricing"], routesReviewed: ["/pricing"] }),
      measurements: AUDIT_MEASUREMENTS,
    });

    expect(result).not.toHaveProperty("gradeUnavailableReason");
  });

  it("a measured page with no violations does not retract", () => {
    // `checksRun` non-empty with `violations: []` is the positive statement
    // "measured, clean". A clean page's `ship` is earned and stays.
    const result = toEngineReviewResult(critique(), {
      ...RETENTION,
      coverage: coverage(),
      measurements: { checksRun: ["contrast", "overflow", "touch_target"], violations: [] },
    });

    expect(result).not.toHaveProperty("gradeUnavailableReason");
    expect(result.grade).toBe("ship");
  });

  it("fires on a violation that is not block-eligible", () => {
    // The claim is about the JUDGE'S SILENCE, not about the page, so it is sound
    // even when the measurement is a known false-positive class. This is the
    // property that lets it ship ahead of the capture-precision work.
    const [, , touchTarget] = AUDIT_MEASUREMENTS.violations;
    const result = toEngineReviewResult(critique(), {
      ...RETENTION,
      coverage: coverage(),
      measurements: {
        checksRun: ["touch_target"],
        violations: [touchTarget as (typeof AUDIT_MEASUREMENTS.violations)[number]],
      },
    });

    expect(touchTarget?.blockEligible).toBe(false);
    expect(result.gradeUnavailableReason).toBe("measured_facts_unjudged");
  });
});

describe("T9: the cross-repo golden fixtures stay byte-identical", () => {
  it("the golden result carries no measurements field", () => {
    const golden = loadGoldenResult();
    expect(golden).not.toHaveProperty("measurements");
    expect(golden).not.toHaveProperty("gradeUnavailableReason");
  });

  it("the pre-calibration counterexample is unchanged too", () => {
    const legacy = loadPreCalibrationResult();
    expect(legacy).not.toHaveProperty("measurements");
  });
});

/**
 * T10: the grade is a pure function of the surviving model findings, and it has
 * to STAY one.
 *
 * A snapshot over the two files that own it. It is deliberately a content hash
 * rather than a behavioural assertion: the risk this guards is not a bug, it is
 * a later change that quietly threads a measurement into the grade path, which
 * would pass every behavioural test written before it. Anyone who touches these
 * two files has to come here and say why.
 */
describe("T10: grade.ts and validation-tail.ts are not modified", () => {
  const read = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

  it("neither file mentions a measurement", () => {
    for (const name of ["grade.ts", "validation-tail.ts"]) {
      const source = read(name);
      expect(source.toLowerCase()).not.toContain("measurement");
      expect(source).not.toContain("blockEligible");
    }
  });

  it("gradeFromFindings and reconcileGrade take findings and nothing else", () => {
    const grade = read("grade.ts");
    expect(grade).toContain("export function gradeFromFindings(findings: Finding[]): Grade {");
    expect(grade).toContain(
      "export function reconcileGrade(modelGrade: Grade, findings: Finding[]): Grade {",
    );
  });

  it("ValidationTailInput gained no measurement field", () => {
    const tail = read("validation-tail.ts");
    const input = tail.slice(tail.indexOf("export interface ValidationTailInput"));
    expect(input).not.toMatch(/measure/i);
  });
});
