import type { Dimension, Finding } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { postFilter } from "../src/index.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence: 0.8,
  route: "/pricing",
  viewport: "desktop",
  elementRef: "#cta",
  title: "Uneven gap",
  description: "uneven gap",
  suggestion: null,
  introducedByThisPr: true,
  ...over,
});

describe("postFilter (#33)", () => {
  it("drops findings below the 0.55 confidence floor", () => {
    const out = postFilter(
      [finding({ confidence: 0.9 }), finding({ confidence: 0.4, elementRef: "#x" })],
      { minConfidence: 0.55, useConfidence: true },
    ).findings;
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.9);
  });

  it("dedupes by elementRef + dimension across viewports, keeping the highest confidence", () => {
    const out = postFilter(
      [finding({ viewport: "mobile", confidence: 0.6 }), finding({ viewport: "desktop", confidence: 0.85 })],
      { useConfidence: true },
    ).findings;
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.85);
  });

  it("dedup never downgrades severity: a blocker is kept over a same-key higher-confidence minor", () => {
    // Same element+dimension across viewports, different severities: a mobile
    // blocker (0.7) and a desktop minor (0.95). Dedup must keep the blocker; a
    // raw-confidence swap would silently drop it and let a should-block PR pass.
    const out = postFilter(
      [
        finding({ viewport: "mobile", severity: "blocker", confidence: 0.7 }),
        finding({ viewport: "desktop", severity: "minor", confidence: 0.95 }),
      ],
      { useConfidence: true },
    ).findings;
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("blocker");
    expect(out[0]?.confidence).toBe(0.7);
  });

  it("caps at 1 blocker + 6 others with deterministic severity ordering", () => {
    const findings: Finding[] = [
      ...Array.from({ length: 3 }, (_, i) => finding({ severity: "blocker", elementRef: `#b${i}`, confidence: 0.9 - i * 0.01 })),
      ...Array.from({ length: 10 }, (_, i) => finding({ severity: "minor", elementRef: `#m${i}`, confidence: 0.9 - i * 0.01 })),
    ];
    const result = postFilter(findings);
    const out = result.findings;
    expect(out.filter((f) => f.severity === "blocker")).toHaveLength(1);
    expect(out.filter((f) => f.severity !== "blocker")).toHaveLength(6);
    expect(out[0]?.severity).toBe("blocker"); // blocker first
    // Deterministic: same input -> same order.
    expect(postFilter(findings).findings).toEqual(out);
  });

  it("DISCLOSES what the cap withheld instead of dropping it in silence (F3)", () => {
    // 2 blockers + 10 minors, all one dimension. Cap keeps 1 blocker + 6 others,
    // so 1 blocker + 4 minors are withheld — and the summary says so.
    const findings: Finding[] = [
      ...Array.from({ length: 2 }, (_, i) => finding({ severity: "blocker", elementRef: `#b${i}` })),
      ...Array.from({ length: 10 }, (_, i) => finding({ severity: "minor", elementRef: `#m${i}` })),
    ];
    const { findings: kept, withheld } = postFilter(findings);
    expect(kept).toHaveLength(7); // 1 blocker + 6 others
    // 12 deduped − 7 kept = 5 withheld, all in the one dimension.
    expect(withheld.total).toBe(5);
    expect(withheld.byDimension).toEqual([{ dimension: "spacing" as Dimension, count: 5 }]);
  });

  it("is DELIBERATE across dimensions: one dimension's minors never crowd out others entirely (F3)", () => {
    // Five off-8px-scale spacing minors + one finding in each of four other
    // dimensions. The historic `.slice(0, 6)` after a severity sort would keep
    // the six highest-severity findings and could delete an entire dimension; the
    // deliberate selection reserves one slot per dimension first, so every
    // dimension that has a finding is represented in the kept set.
    const dims: Dimension[] = ["brand", "consistency", "typography", "responsiveness"];
    const findings: Finding[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        finding({ dimension: "spacing", severity: "minor", elementRef: `#s${i}` }),
      ),
      ...dims.map((dimension, i) => finding({ dimension, severity: "major", elementRef: `#d${i}` })),
    ];
    const { findings: kept, withheld } = postFilter(findings);
    const keptDims = new Set(kept.map((f) => f.dimension));
    // Every dimension present in the input is represented — none crowded out.
    for (const d of ["spacing", ...dims] as Dimension[]) expect(keptDims.has(d)).toBe(true);
    // And what did not fit is disclosed (the withheld spacing minors).
    expect(withheld.total).toBeGreaterThan(0);
    expect(withheld.byDimension.find((d) => d.dimension === "spacing")?.count).toBeGreaterThan(0);
  });
});
