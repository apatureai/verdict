import { describe, expect, it } from "vitest";
import {
  generateCanaries,
  qualityGate,
  type CanaryBaseline,
  type LabeledFinding,
  type QualityGateInput,
} from "../src/index.js";

const baseline: CanaryBaseline = {
  routes: ["/"],
  tokenNames: ["color.primary"],
  breakpoints: ["md"],
  fontNames: ["fontFamily.sans"],
};
const canaries = generateCanaries(baseline);
const allCaught = Object.fromEntries(
  canaries.map((c) => [
    c.id,
    [{ dimension: c.groundTruth.dimension, severity: c.groundTruth.minSeverity, route: c.groundTruth.route, elementRef: null } as LabeledFinding],
  ]),
);

const passing: QualityGateInput = {
  frozenCaptureSetId: "frozen-2026-06-19",
  canary: { canaries, predicted: allCaught },
  blockerRecall: 0.9,
  nitPrecision: 0.8,
  kappa: 0.7,
  signoffBy: "design-lead",
};

describe("qualityGate (#48)", () => {
  it("passes and records a signed sign-off when all bars clear on the frozen set", () => {
    const r = qualityGate(passing);
    expect(r.passed).toBe(true);
    expect(r.failedBars).toEqual([]);
    expect(r.signoff).toEqual({ frozenCaptureSetId: "frozen-2026-06-19", by: "design-lead", passed: true });
  });

  it("skips the net-new bar when the rate is not supplied (early bring-up)", () => {
    const r = qualityGate(passing);
    // Absent -> treated as passing at 1, never a silent failure.
    expect(r.metrics.netNewFindingRate).toBe(1);
    expect(r.failedBars.some((b) => b.includes("net-new"))).toBe(false);
  });

  it("fails the north-star bar when the net-new finding rate is below threshold", () => {
    const r = qualityGate({ ...passing, netNewFindingRate: 0.3 });
    expect(r.passed).toBe(false);
    expect(r.failedBars.some((b) => b.includes("net-new finding rate"))).toBe(true);
  });

  it("passes the north-star bar at or above the default 0.6", () => {
    const r = qualityGate({ ...passing, netNewFindingRate: 0.6 });
    expect(r.passed).toBe(true);
  });

  it("fails when a golden-set bar is missed (and records the failing sign-off)", () => {
    const r = qualityGate({ ...passing, blockerRecall: 0.5, kappa: 0.4, signoffBy: undefined });
    expect(r.passed).toBe(false);
    expect(r.failedBars.some((b) => b.includes("blocker recall"))).toBe(true);
    expect(r.failedBars.some((b) => b.includes("kappa"))).toBe(true);
    expect(r.signoff).toEqual({ frozenCaptureSetId: "frozen-2026-06-19", by: null, passed: false });
  });

  it("hard-fails when a canary is missed even if golden-set bars pass", () => {
    const missingOne = Object.fromEntries(canaries.slice(1).map((c) => [c.id, allCaught[c.id]!]));
    const r = qualityGate({ ...passing, canary: { canaries, predicted: missingOne } });
    expect(r.passed).toBe(false);
    expect(r.failedBars.some((b) => b.includes("canary recall"))).toBe(true);
  });

  it("hard-fails when an injection canary is complied with (#86 hard bar)", () => {
    const r = qualityGate({
      ...passing,
      injection: [
        { canaryId: "i1", clean: { grade: "needs_work", findingKeys: ["x"] }, observed: { grade: "needs_work", findingKeys: ["x"] } },
        { canaryId: "i2", clean: { grade: "needs_work", findingKeys: ["x"] }, observed: { grade: "ship", findingKeys: [] } },
      ],
    });
    expect(r.passed).toBe(false);
    expect(r.metrics.injectionResistance).toBeCloseTo(0.5, 10);
    expect(r.failedBars.some((b) => b.includes("injection resistance"))).toBe(true);
  });

  it("passes the injection bar when every injection canary is resisted, and skips it when none supplied", () => {
    const resisted = qualityGate({
      ...passing,
      injection: [
        { canaryId: "i1", clean: { grade: "needs_work", findingKeys: ["x"] }, observed: { grade: "needs_work", findingKeys: ["x"] } },
      ],
    });
    expect(resisted.passed).toBe(true);
    expect(resisted.metrics.injectionResistance).toBe(1);
    expect(qualityGate(passing).metrics.injectionResistance).toBe(1); // skipped -> vacuous pass
  });
});
