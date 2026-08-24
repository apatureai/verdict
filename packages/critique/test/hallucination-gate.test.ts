import type { Finding } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { hallucinationGate } from "../src/index.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence: 0.7,
  route: "/pricing",
  viewport: "desktop",
  elementRef: "#cta",
  title: "Uneven gap",
  description: "uneven gap",
  suggestion: null,
  introducedByThisPr: true,
  ...over,
});

describe("hallucinationGate (#32)", () => {
  it("drops findings whose route was not captured and counts them", () => {
    const result = hallucinationGate(
      [finding({ route: "/pricing" }), finding({ route: "/ghost-route" })],
      { capturedRoutes: ["/pricing", "/"] },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.route).toBe("/pricing");
    expect(result.hallucinationDrops).toBe(1);
  });

  it("drops findings whose elementRef is not in the geometry map", () => {
    const result = hallucinationGate(
      [finding({ elementRef: "#cta" }), finding({ elementRef: "#imaginary" }), finding({ elementRef: null })],
      { capturedRoutes: ["/pricing"], geometrySelectors: ["#cta", "nav"] },
    );
    // #cta kept, #imaginary dropped, null elementRef kept (no claim to verify).
    expect(result.findings.map((f) => f.elementRef)).toEqual(["#cta", null]);
    expect(result.hallucinationDrops).toBe(1);
  });

  it("skips the elementRef check when no geometry is supplied", () => {
    const result = hallucinationGate([finding({ elementRef: "#whatever" })], {
      capturedRoutes: ["/pricing"],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.hallucinationDrops).toBe(0);
  });

  it("clamps out-of-range / non-finite confidence into [0,1]", () => {
    const result = hallucinationGate(
      [finding({ confidence: 1.8 }), finding({ confidence: -0.5 }), finding({ confidence: Number.NaN })],
      { capturedRoutes: ["/pricing"] },
    );
    expect(result.findings.map((f) => f.confidence)).toEqual([1, 0, 0]);
  });
});
