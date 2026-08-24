import type { Finding } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { gradeFromFindings, reconcileGrade, worstGrade } from "../src/index.js";

const f = (severity: Finding["severity"]): Finding => ({
  dimension: "spacing",
  severity,
  confidence: 0.9,
  route: "/",
  viewport: "desktop",
  elementRef: null,
  title: "t",
  description: "d",
  suggestion: null,
  introducedByThisPr: true,
});

describe("gradeFromFindings (#106)", () => {
  it("maps the worst surviving severity to the grade it justifies", () => {
    expect(gradeFromFindings([])).toBe("ship");
    expect(gradeFromFindings([f("nit")])).toBe("ship_with_nits");
    expect(gradeFromFindings([f("minor")])).toBe("needs_work");
    expect(gradeFromFindings([f("major")])).toBe("needs_work");
    expect(gradeFromFindings([f("nit"), f("blocker")])).toBe("blocked");
  });
});

describe("reconcileGrade (#106)", () => {
  it("LOWERS a grade unsupported by surviving findings", () => {
    // The classic false-positive: blocked grade but the blocker finding was dropped.
    expect(reconcileGrade("blocked", [])).toBe("ship");
    expect(reconcileGrade("blocked", [f("nit")])).toBe("ship_with_nits");
    expect(reconcileGrade("needs_work", [])).toBe("ship");
  });

  it("never RAISES a conservative model grade above its findings", () => {
    expect(reconcileGrade("ship", [f("blocker")])).toBe("ship"); // model graded leniently → kept
    expect(reconcileGrade("ship_with_nits", [f("major")])).toBe("ship_with_nits");
  });

  it("keeps a grade fully supported by findings", () => {
    expect(reconcileGrade("blocked", [f("blocker")])).toBe("blocked");
    expect(reconcileGrade("needs_work", [f("minor")])).toBe("needs_work");
  });
});

describe("worstGrade", () => {
  it("returns the most severe grade, ship by default", () => {
    expect(worstGrade([])).toBe("ship");
    expect(worstGrade(["ship", "needs_work", "ship_with_nits"])).toBe("needs_work");
    expect(worstGrade(["blocked", "ship"])).toBe("blocked");
  });
});
