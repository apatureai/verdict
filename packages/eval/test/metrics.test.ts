import type { Grade } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  blockerRecall,
  bootstrapKappaCI,
  nitPrecision,
  perDimensionPR,
  precisionRecall,
  quadraticWeightedKappa,
  type LabeledFinding,
} from "../src/index.js";

const f = (over: Partial<LabeledFinding> = {}): LabeledFinding => ({
  dimension: "spacing",
  severity: "minor",
  route: "/",
  elementRef: "#a",
  ...over,
});

describe("precision/recall (#46)", () => {
  it("matches findings by dimension+route+elementRef", () => {
    const predicted = [f({ elementRef: "#a" }), f({ elementRef: "#b" })];
    const truth = [f({ elementRef: "#a" }), f({ elementRef: "#c" })];
    const pr = precisionRecall(predicted, truth);
    expect(pr).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
  });

  it("computes per-dimension precision/recall", () => {
    const predicted = [f({ dimension: "spacing" }), f({ dimension: "typography", elementRef: "#t" })];
    const truth = [f({ dimension: "spacing" })];
    const byDim = perDimensionPR(predicted, truth);
    expect(byDim.spacing?.recall).toBe(1);
    expect(byDim.typography?.precision).toBe(0); // predicted a typography finding not in truth
  });

  it("reports blocker recall and nit precision", () => {
    const truth = [f({ severity: "blocker", elementRef: "#x" }), f({ severity: "blocker", elementRef: "#y" })];
    const predicted = [f({ severity: "blocker", elementRef: "#x" })];
    expect(blockerRecall(predicted, truth)).toBe(0.5); // caught 1 of 2 blockers

    const nitPred = [f({ severity: "nit", elementRef: "#n1" }), f({ severity: "nit", elementRef: "#n2" })];
    const nitTruth = [f({ elementRef: "#n1" })];
    expect(nitPrecision(nitPred, nitTruth)).toBe(0.5); // 1 of 2 nits real
    expect(nitPrecision([], nitTruth)).toBe(1); // vacuous
  });
});

describe("quadratic-weighted kappa", () => {
  it("is 1.0 for perfect agreement", () => {
    const grades: Grade[] = ["ship", "needs_work", "blocked", "ship_with_nits"];
    expect(quadraticWeightedKappa(grades, grades)).toBeCloseTo(1, 6);
  });

  it("penalizes far disagreements more than near ones (ordinal weighting)", () => {
    const a: Grade[] = ["ship", "ship", "blocked", "blocked"];
    const near: Grade[] = ["ship_with_nits", "ship", "needs_work", "blocked"];
    const far: Grade[] = ["blocked", "blocked", "ship", "ship"];
    expect(quadraticWeightedKappa(a, near)).toBeGreaterThan(quadraticWeightedKappa(a, far));
  });

  it("bootstraps a deterministic CI bracketing the point estimate", () => {
    const a: Grade[] = ["ship", "ship", "needs_work", "blocked", "ship_with_nits", "needs_work"];
    const b: Grade[] = ["ship", "ship_with_nits", "needs_work", "blocked", "ship_with_nits", "ship"];
    const ci = bootstrapKappaCI(a, b, { iterations: 300, seed: 7 });
    expect(ci.lower).toBeLessThanOrEqual(ci.kappa + 1e-9);
    expect(ci.upper).toBeGreaterThanOrEqual(ci.kappa - 1e-9);
    // Deterministic with the same seed.
    expect(bootstrapKappaCI(a, b, { iterations: 300, seed: 7 })).toEqual(ci);
  });
});
