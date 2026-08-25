import { describe, expect, it } from "vitest";
import type { DeterministicFinding } from "@apatureai/verdict-capture";
import {
  buildFactLedger,
  claimClassOfKind,
  literalKey,
  measurementLiterals,
  renderDeclinedFacts,
  renderReportedFacts,
} from "../src/index.js";

/**
 * Judge-unlock §4.1: the fact ledger is the ONE structure that drives both the
 * prompt blocks and the duplicate gate, built once from the deterministic +
 * declined findings.
 */

const findings: DeterministicFinding[] = [
  { kind: "contrast", route: "/", viewport: "mobile", selector: "#nav", detail: "text contrast 2.10:1 is below WCAG AA 4.5:1" },
  { kind: "overflow", route: "/", viewport: "mobile", selector: "#p", detail: "content width 497px exceeds container 336px" },
  { kind: "page_overflow", route: "/", viewport: "mobile", selector: "document", detail: "document scroll width 927px exceeds the 390px viewport by 537px" },
  {
    kind: "touch_target",
    route: "/",
    viewport: "mobile",
    selector: "#bell",
    detail: "touch target 20x20px is below the 24x24px minimum, but the Spacing exception applies",
    reported: false,
    declineReason: "the WCAG 2.2 SC 2.5.8 Spacing exception applies",
  },
];

describe("buildFactLedger (judge-unlock §4.1)", () => {
  it("maps each check kind to its claim class", () => {
    expect(claimClassOfKind("contrast")).toBe("contrast");
    expect(claimClassOfKind("overflow")).toBe("element_overflow");
    expect(claimClassOfKind("page_overflow")).toBe("page_overflow");
    expect(claimClassOfKind("touch_target")).toBe("target_size");
  });

  it("records reported and declined entries, marking each", () => {
    const ledger = buildFactLedger(findings);
    expect(ledger.entries).toHaveLength(4);
    expect(ledger.entries.filter((e) => e.reported)).toHaveLength(3);
    const declined = ledger.entries.find((e) => !e.reported);
    expect(declined?.selector).toBe("#bell");
    expect(declined?.declineReason).toMatch(/Spacing exception/);
  });

  it("indexes only REPORTED measurement literals, per (selector, viewport)", () => {
    const ledger = buildFactLedger(findings);
    expect(ledger.measurementLiterals.get(literalKey("#nav", "mobile"))).toEqual(new Set(["2.10:1", "4.5:1"]));
    expect([...(ledger.measurementLiterals.get(literalKey("#p", "mobile")) ?? [])]).toContain("497px");
    // The declined #bell measurement never enters the literal index.
    expect(ledger.measurementLiterals.has(literalKey("#bell", "mobile"))).toBe(false);
  });

  it("renders the reported and declined prompt blocks separately", () => {
    const ledger = buildFactLedger(findings);
    const reported = renderReportedFacts(ledger, "/");
    expect(reported).toHaveLength(3);
    expect(reported.join("\n")).toContain("[contrast] #nav");
    const declined = renderDeclinedFacts(ledger, "/");
    expect(declined).toHaveLength(1);
    expect(declined[0]).toContain("[target_size] #bell");
    expect(declined[0]).toContain("[declined:");
  });

  it("extracts measurement-shaped literals from a detail string", () => {
    const lits = measurementLiterals("text contrast 2.10:1 and a 20x20px box at 497px wide");
    expect(lits.has("2.10:1")).toBe(true);
    expect(lits.has("497px")).toBe(true);
    expect(lits.has("20x20px")).toBe(true);
  });
});
