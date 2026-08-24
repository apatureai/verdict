import type { Grade } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  bootstrapAgreementCI,
  gradeRatingsMatrix,
  gwetAC2,
  krippendorffAlpha,
  quadraticWeightedKappa,
  type RatingsMatrix,
} from "../src/index.js";

/**
 * Reference values are hand-derived from the published formulas (Krippendorff's
 * coincidence-matrix alpha; Gwet 2014 AC1/AC2) on small fixtures, computed with
 * independent arithmetic so a coding error in the implementation is caught.
 */
describe("krippendorffAlpha (#84)", () => {
  it("matches a hand-worked ordinal example to 1e-6", () => {
    // 2 raters, 2 units, categories {0,1,2}: [[0,0],[1,2]] -> alpha_ordinal = 5/6.
    const ratings: RatingsMatrix = [
      [0, 0],
      [1, 2],
    ];
    expect(krippendorffAlpha(ratings, "ordinal")).toBeCloseTo(5 / 6, 6);
  });

  it("is 1 on perfect agreement and handles missing labels (>=2 raters)", () => {
    expect(krippendorffAlpha([[0, 0, 0], [1, 1, null], [2, null, 2]], "ordinal")).toBe(1);
  });

  it("ordinal/interval reward near-misses that nominal penalizes fully", () => {
    // All disagreements are off-by-one; ordinal/interval treat them as small
    // distances, nominal counts each as a full disagreement.
    const ratings: RatingsMatrix = [
      [0, 1],
      [1, 0],
      [1, 2],
      [2, 1],
    ];
    const nominal = krippendorffAlpha(ratings, "nominal");
    expect(krippendorffAlpha(ratings, "interval")).toBeGreaterThan(nominal);
    expect(krippendorffAlpha(ratings, "ordinal")).toBeGreaterThan(nominal);
  });
});

describe("gwetAC2 (#84)", () => {
  // 2 raters, units [[0,0],[0,1],[1,1],[2,2]] over categories {0,1,2}.
  const ratings: RatingsMatrix = [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 2],
  ];

  it("with identity weights reduces to Gwet AC1 (hand-worked, 1e-6)", () => {
    expect(gwetAC2(ratings, "identity")).toBeCloseTo(0.627906976744186, 6);
  });

  it("with quadratic ordinal weights matches the hand-worked AC2 = 9/11 (1e-6)", () => {
    expect(gwetAC2(ratings, "quadratic")).toBeCloseTo(9 / 11, 6);
  });

  it("returns 1 when only one category is present", () => {
    expect(gwetAC2([[0, 0], [0, 0]], "quadratic")).toBe(1);
  });
});

describe("the kappa paradox on a skewed grade distribution (#84)", () => {
  // 10 PRs, 2 raters, heavily 'ship'-skewed with high observed agreement
  // (8 exact 'ship', 2 adjacent 'ship' vs 'ship_with_nits').
  const raterA: Grade[] = [
    "ship", "ship", "ship", "ship", "ship", "ship", "ship", "ship", "ship", "ship_with_nits",
  ];
  const raterB: Grade[] = [
    "ship", "ship", "ship", "ship", "ship", "ship", "ship", "ship", "ship_with_nits", "ship",
  ];
  const grades = gradeRatingsMatrix(raterA.map((g, i) => [g, raterB[i] ?? null]));

  it("weighted kappa is depressed while AC2 stays high (read the headline from AC2)", () => {
    const kappa = quadraticWeightedKappa(raterA, raterB);
    const ac2 = gwetAC2(grades, "quadratic", { categories: 4 });
    const alpha = krippendorffAlpha(grades, "ordinal", { categories: 4 });

    expect(kappa).toBeLessThan(0.1); // prevalence-deflated (here negative)
    expect(ac2).toBeGreaterThan(0.9); // robust to the skew
    expect(ac2).toBeGreaterThan(kappa);
    expect(alpha).toBeGreaterThan(kappa);
  });
});

describe("bootstrapAgreementCI (#84)", () => {
  it("brackets the point estimate and is deterministic for a fixed seed", () => {
    const ratings: RatingsMatrix = [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 2],
      [1, 1],
      [0, 0],
    ];
    const ci1 = bootstrapAgreementCI(ratings, (m) => gwetAC2(m, "quadratic", { categories: 3 }), { seed: 7, iterations: 200 });
    const ci2 = bootstrapAgreementCI(ratings, (m) => gwetAC2(m, "quadratic", { categories: 3 }), { seed: 7, iterations: 200 });
    expect(ci1).toEqual(ci2); // seeded determinism
    expect(ci1.lower).toBeLessThanOrEqual(ci1.value);
    expect(ci1.upper).toBeGreaterThanOrEqual(ci1.value);
  });
});
