import type { Grade } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  blockerRecall,
  bootstrapKappaCI,
  netNewFindingRate,
  nitPrecision,
  perDimensionPR,
  precisionRecall,
  quadraticWeightedKappa,
  type LabeledFinding,
  type NetNewLedger,
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

describe("netNewFindingRate (judge-unlock north star, §4.4)", () => {
  const ledger: NetNewLedger = {
    entries: [
      { claimClass: "contrast", route: "/", selector: "#nav", reported: true },
      { claimClass: "element_overflow", route: "/", selector: "#p", reported: true },
      // A DECLINED target-size measurement must never suppress a finding.
      { claimClass: "target_size", route: "/", selector: "#bell", reported: false },
    ],
  };

  it("counts a finding restating a reported measurement as NOT net-new", () => {
    const published: LabeledFinding[] = [
      { dimension: "color_contrast", severity: "major", route: "/", elementRef: "#nav" },
    ];
    expect(netNewFindingRate(published, ledger)).toBe(0);
  });

  it("counts a design-system finding on a reported element as net-new", () => {
    // spacing has no deterministic claim class, so it can never be a restatement.
    const published: LabeledFinding[] = [
      { dimension: "spacing", severity: "minor", route: "/", elementRef: "#nav" },
    ];
    expect(netNewFindingRate(published, ledger)).toBe(1);
  });

  it("counts a repo-rule finding on a DECLINED element as net-new", () => {
    const published: LabeledFinding[] = [
      { dimension: "accessibility", severity: "major", route: "/", elementRef: "#bell" },
    ];
    expect(netNewFindingRate(published, ledger)).toBe(1);
  });

  it("is the share of published findings that made a novel claim", () => {
    const published: LabeledFinding[] = [
      { dimension: "color_contrast", severity: "major", route: "/", elementRef: "#nav" }, // restatement
      { dimension: "responsiveness", severity: "major", route: "/", elementRef: "#p" }, // restatement
      { dimension: "accessibility", severity: "major", route: "/", elementRef: "#bell" }, // net-new
      { dimension: "visual_hierarchy", severity: "minor", route: "/", elementRef: "#h1" }, // net-new
    ];
    expect(netNewFindingRate(published, ledger)).toBe(0.5);
  });

  // C4: zero published findings must NOT score a vacuous 1.0 — that let an EMPTY
  // JUDGE (today's precise failure) pass the release gate.
  it("scores 0 for an EMPTY JUDGE: nothing published on a page the checker measured", () => {
    // The ledger has measured facts (a non-trivial page), so publishing nothing is
    // a failure, not a clean bill of health.
    expect(netNewFindingRate([], ledger)).toBe(0);
  });

  it("scores 1 for a genuinely CLEAN page: nothing published, nothing measured", () => {
    expect(netNewFindingRate([], { entries: [] })).toBe(1);
  });

  it("uses an explicit measured-facts count to distinguish clean from empty", () => {
    // Even with an empty ledger view, an explicit measured-facts count > 0 means the
    // page was non-trivial: an empty judge there scores 0.
    expect(netNewFindingRate([], { entries: [] }, 5)).toBe(0);
    expect(netNewFindingRate([], { entries: [] }, 0)).toBe(1);
  });

  it("does NOT count a reworded page-overflow claim pinned to the widest element as net-new (C4 leak)", () => {
    // `page_overflow` is keyed to the reserved `document` selector; a paraphrase
    // attached to the widest ELEMENT (a different selector) must still be caught.
    const pageLedger: NetNewLedger = {
      entries: [{ claimClass: "page_overflow", route: "/", selector: "document", reported: true }],
    };
    const paraphrase: LabeledFinding[] = [
      { dimension: "responsiveness", severity: "major", route: "/", elementRef: "body > div.container" },
    ];
    expect(netNewFindingRate(paraphrase, pageLedger)).toBe(0);
  });

  it("still counts a DISTINCT element-overflow finding on a page-overflow route as net-new", () => {
    // A per-element overflow with its OWN measurement is a different, genuine fact.
    const mixed: NetNewLedger = {
      entries: [
        { claimClass: "page_overflow", route: "/", selector: "document", reported: true },
        { claimClass: "element_overflow", route: "/", selector: "#wide", reported: true },
      ],
    };
    // A responsiveness finding on an element with NO overflow measurement, on a page
    // that overflows, is a restatement of the page overflow (not net-new)…
    expect(
      netNewFindingRate([{ dimension: "responsiveness", severity: "major", route: "/", elementRef: "#other" }], mixed),
    ).toBe(0);
    // …but a spacing finding on the same route is genuinely net-new.
    expect(
      netNewFindingRate([{ dimension: "spacing", severity: "minor", route: "/", elementRef: "#other" }], mixed),
    ).toBe(1);
  });
});
