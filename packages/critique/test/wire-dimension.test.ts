import type { Critique, Dimension, Finding, Severity } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { toEngineReviewResult } from "../src/index.js";

const ALL_DIMENSIONS: Dimension[] = [
  "visual_hierarchy",
  "spacing",
  "color_contrast",
  "typography",
  "consistency",
  "responsiveness",
  "accessibility",
  "brand",
];
const ALL_SEVERITIES: Severity[] = ["nit", "minor", "major", "blocker"];

function finding(over: Partial<Finding> = {}): Finding {
  return {
    dimension: "color_contrast",
    severity: "major",
    confidence: 0.9,
    route: "/pricing",
    viewport: "mobile",
    elementRef: null,
    title: "t",
    description: "d",
    suggestion: null,
    introducedByThisPr: false,
    ...over,
  };
}

function critique(findings: Finding[]): Critique {
  return {
    grade: "needs_work",
    overall: "o",
    findings,
    notReviewed: [],
    validation: { hallucinationDrops: 0, captureUnstable: false, modelFindingsSeen: findings.length },
    metadata: {
      engineVersion: "2026.06.0",
      model: "qwen3-vl",
      promptVersion: "p@1",
      captureVersion: "c@1",
      uiDnaVersion: "d@1",
    },
  };
}

describe("wire dimension pass-through (#159)", () => {
  it("carries every one of the eight rubric dimensions verbatim", () => {
    const result = toEngineReviewResult(critique(ALL_DIMENSIONS.map((d) => finding({ dimension: d }))), {
      screenshotRetentionSeconds: 60,
    });
    expect(result.findings.map((f) => f.dimension)).toEqual(ALL_DIMENSIONS);
  });

  it("is emitted from the internal finding, never derived from severity or title", () => {
    // A spacing nit and an accessibility blocker: dimension is independent of severity.
    const result = toEngineReviewResult(
      critique([
        finding({ dimension: "spacing", severity: "nit", title: "accessibility contrast is fine" }),
        finding({ dimension: "accessibility", severity: "blocker", title: "spacing looks tight" }),
      ]),
      { screenshotRetentionSeconds: 60 },
    );
    expect(result.findings[0]).toMatchObject({ dimension: "spacing", severity: "nit" });
    expect(result.findings[1]).toMatchObject({ dimension: "accessibility", severity: "blocker" });
  });

  it("counterexample: severity=blocker, dimension=accessibility reaches the wire unchanged", () => {
    const result = toEngineReviewResult(critique([finding({ dimension: "accessibility", severity: "blocker" })]), {
      screenshotRetentionSeconds: 60,
    });
    expect(result.findings[0]!.dimension).toBe("accessibility");
    expect(result.findings[0]!.severity).toBe("blocker");
  });

  it("covers dimension x severity independence across the matrix", () => {
    for (const dimension of ALL_DIMENSIONS) {
      for (const severity of ALL_SEVERITIES) {
        const result = toEngineReviewResult(critique([finding({ dimension, severity })]), { screenshotRetentionSeconds: 60 });
        expect(result.findings[0]).toMatchObject({ dimension, severity });
      }
    }
  });
});
