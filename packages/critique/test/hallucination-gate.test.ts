import type { CapturedShot } from "../src/index.js";
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

const shot = (route: string, viewport: Finding["viewport"]): CapturedShot => ({ route, viewport });

describe("hallucinationGate (#32)", () => {
  it("drops findings whose (route, viewport) shot was not captured and counts them", () => {
    const result = hallucinationGate(
      [finding({ route: "/pricing" }), finding({ route: "/ghost-route" })],
      { capturedShots: [shot("/pricing", "desktop"), shot("/", "desktop")] },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.route).toBe("/pricing");
    expect(result.hallucinationDrops).toBe(1);
    expect(result.ungrounded).toEqual([]);
  });

  it("drops a finding claiming a viewport that was never captured (W1-03)", () => {
    // Route /pricing WAS captured, but only at mobile. A finding claiming desktop
    // points at a shot that does not exist, and must not survive on route alone.
    const result = hallucinationGate(
      [finding({ viewport: "mobile" }), finding({ viewport: "desktop" })],
      { capturedShots: [shot("/pricing", "mobile")] },
    );
    expect(result.findings.map((f) => f.viewport)).toEqual(["mobile"]);
    expect(result.hallucinationDrops).toBe(1);
  });

  it("drops findings whose elementRef is not in the geometry map", () => {
    const result = hallucinationGate(
      [finding({ elementRef: "#cta" }), finding({ elementRef: "#imaginary" })],
      { capturedShots: [shot("/pricing", "desktop")], geometrySelectors: ["#cta", "nav"] },
    );
    expect(result.findings.map((f) => f.elementRef)).toEqual(["#cta"]);
    expect(result.hallucinationDrops).toBe(1);
  });

  it("routes a null-elementRef finding to the ungrounded bucket, not the graded findings, and does not count it as a drop", () => {
    const result = hallucinationGate(
      [finding({ elementRef: "#cta" }), finding({ elementRef: null, severity: "blocker" })],
      { capturedShots: [shot("/pricing", "desktop")], geometrySelectors: ["#cta"] },
    );
    // The grounded finding drives the grade; the null-ref blocker is quarantined.
    expect(result.findings.map((f) => f.elementRef)).toEqual(["#cta"]);
    expect(result.ungrounded.map((f) => f.severity)).toEqual(["blocker"]);
    expect(result.hallucinationDrops).toBe(0);
  });

  it("still drops a null-elementRef finding whose shot was never captured (ungrounded is only for real shots)", () => {
    const result = hallucinationGate([finding({ elementRef: null, route: "/ghost" })], {
      capturedShots: [shot("/pricing", "desktop")],
    });
    expect(result.findings).toEqual([]);
    expect(result.ungrounded).toEqual([]);
    expect(result.hallucinationDrops).toBe(1);
  });

  it("buckets null-elementRef findings even when no geometry is supplied", () => {
    const result = hallucinationGate([finding({ elementRef: null })], {
      capturedShots: [shot("/pricing", "desktop")],
    });
    expect(result.findings).toEqual([]);
    expect(result.ungrounded).toHaveLength(1);
    expect(result.hallucinationDrops).toBe(0);
  });

  it("skips the elementRef check when no geometry is supplied (non-null refs pass through)", () => {
    const result = hallucinationGate([finding({ elementRef: "#whatever" })], {
      capturedShots: [shot("/pricing", "desktop")],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.hallucinationDrops).toBe(0);
  });

  // F1 — the citation-suffix class that deleted all 11 field findings. The
  // geometry block rendered `- #upgrade (button) box …` and told the model to cite
  // element_ref "EXACTLY as written", so it cited the role too. The gate normalises
  // that KNOWN artefact and matches the selector exactly — never fuzzily.
  describe("F1 — normalises known citation artefacts, then matches EXACTLY", () => {
    const geo = ["#upgrade", "body > header", "body > main > section:nth-of-type(1) > a", "body > header > nav > a:nth-of-type(1)", "body > header > nav > a:nth-of-type(2)"];
    const gate = (ref: string | null) =>
      hallucinationGate([finding({ elementRef: ref })], {
        capturedShots: [shot("/pricing", "desktop")],
        geometrySelectors: geo,
      });

    it("strips a trailing parenthesised role: `#upgrade (button)` → `#upgrade`", () => {
      const r = gate("#upgrade (button)");
      expect(r.findings.map((f) => f.elementRef)).toEqual(["#upgrade"]);
      expect(r.hallucinationDrops).toBe(0);
    });

    it("strips a `(generic)` role suffix on a descendant selector", () => {
      const r = gate("body > header (generic)");
      expect(r.findings.map((f) => f.elementRef)).toEqual(["body > header"]);
      expect(r.hallucinationDrops).toBe(0);
    });

    it("does NOT mistake a `:nth-of-type(1)` pseudo-class for a role suffix", () => {
      // The paren here has no preceding space, so it is part of the selector.
      const r = gate("body > main > section:nth-of-type(1) > a (link)");
      expect(r.findings.map((f) => f.elementRef)).toEqual(["body > main > section:nth-of-type(1) > a"]);
      expect(r.hallucinationDrops).toBe(0);
    });

    it("splits a comma-joined multi-selector citation into one finding per resolved selector", () => {
      const r = gate(
        "body > header > nav > a:nth-of-type(1) (link), body > header > nav > a:nth-of-type(2) (link)",
      );
      expect(r.findings.map((f) => f.elementRef)).toEqual([
        "body > header > nav > a:nth-of-type(1)",
        "body > header > nav > a:nth-of-type(2)",
      ]);
      expect(r.hallucinationDrops).toBe(0);
    });

    it("still DROPS a normalised citation that resolves to no real selector (no fuzzy match)", () => {
      const r = gate("#imaginary (button)");
      expect(r.findings).toEqual([]);
      expect(r.hallucinationDrops).toBe(1);
    });

    it("keeps only the parts of a multi-cite that resolve; the rest are dropped", () => {
      const r = gate("#upgrade (button), #ghost (link)");
      expect(r.findings.map((f) => f.elementRef)).toEqual(["#upgrade"]);
    });
  });

  it("clamps out-of-range / non-finite confidence into [0,1]", () => {
    const result = hallucinationGate(
      [
        finding({ confidence: 1.8 }),
        finding({ confidence: -0.5 }),
        finding({ confidence: Number.NaN }),
      ],
      { capturedShots: [shot("/pricing", "desktop")] },
    );
    expect(result.findings.map((f) => f.confidence)).toEqual([1, 0, 0]);
  });
});
