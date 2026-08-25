import { describe, expect, it } from "vitest";
import type { StyleDigest } from "@apatureai/verdict-types";
import { selectSignificant, type RawGeometryElement } from "../src/index.js";

/**
 * Judge-unlock §2.4: the significance-tier selection MUST NOT be able to silently
 * omit a significant element class. This is the acceptance test the spec demands:
 * a table wider than the viewport, a nav, a heading, and an interactive control
 * are all present, and the mandatory tiers survive a hostile budget.
 */

const digest = (over: Partial<StyleDigest> = {}): StyleDigest => ({
  fontFamily: "Helvetica Neue",
  fontSizePx: 14,
  fontWeight: 400,
  lineHeightPx: 18,
  color: "#101828",
  backgroundColor: "transparent",
  paddingPx: [0, 0, 0, 0],
  marginPx: [0, 0, 0, 0],
  gapPx: null,
  borderRadiusPx: 0,
  display: null,
  ...over,
});

const el = (over: Partial<RawGeometryElement>): RawGeometryElement => ({
  route: "/",
  viewport: "mobile",
  tag: "div",
  rect: { x: 0, y: 0, width: 100, height: 20 },
  style: digest(),
  ...over,
});

/** A rough model of the proof page's significant elements. */
function proofElements(): RawGeometryElement[] {
  return [
    el({ tag: "header", cssPath: "body > header", rect: { x: 0, y: 0, width: 390, height: 49 } }),
    el({ tag: "nav", cssPath: "body > header > nav", rect: { x: 238, y: 14, width: 125, height: 20 } }),
    el({ tag: "a", cssPath: "body > header > nav > a:nth-of-type(1)", ownText: "Docs", style: digest({ fontFamily: "Georgia" }) }),
    el({ tag: "button", id: "bell", rect: { x: 316, y: 14, width: 20, height: 20 }, interactive: true }),
    el({ tag: "h1", cssPath: "body > main > h1", ownText: "Billing", rect: { x: 13, y: 75, width: 364, height: 24 }, style: digest({ fontSizePx: 19, fontWeight: 600 }) }),
    el({ tag: "main", cssPath: "body > main", rect: { x: 0, y: 49, width: 390, height: 1600 } }),
    el({ tag: "section", cssPath: "body > main > section:nth-of-type(1)", rect: { x: 13, y: 110, width: 364, height: 120 }, style: digest({ paddingPx: [13, 13, 13, 13] }) }),
    el({ tag: "section", cssPath: "body > main > section:nth-of-type(2)", rect: { x: 13, y: 297, width: 364, height: 199 }, style: digest({ paddingPx: [13, 13, 13, 13] }) }),
    // The 900px table that escapes the 390px viewport — the biggest defect.
    el({ tag: "table", cssPath: "body > main > section:nth-of-type(2) > table", rect: { x: 27, y: 349, width: 900, height: 134 }, overflowsX: true }),
    el({ tag: "footer", cssPath: "body > footer", rect: { x: 0, y: 1700, width: 390, height: 60 } }),
    el({ tag: "a", cssPath: "body > footer > a", ownText: "Terms", rect: { x: 13, y: 1720, width: 99, height: 40 }, style: digest({ fontSizePx: 34, fontWeight: 800 }), interactive: true }),
  ];
}

describe("selectSignificant (judge-unlock §2.4)", () => {
  it("never silently omits a significant element class", () => {
    const selectors = new Set(selectSignificant(proofElements()).entries.map((e) => e.selector));
    // A table wider than the viewport (overflow contributor tier).
    expect(selectors.has("body > main > section:nth-of-type(2) > table")).toBe(true);
    // A nav (landmark), a heading (landmark), interactive controls (interactive).
    expect(selectors.has("body > header > nav")).toBe(true);
    expect(selectors.has("body > main > h1")).toBe(true);
    expect(selectors.has("#bell")).toBe(true);
    expect(selectors.has("body > footer > a")).toBe(true);
    // The card/section elements carrying off-scale padding, and the page landmarks.
    expect(selectors.has("body > main > section:nth-of-type(1)")).toBe(true);
    expect(selectors.has("body > main > section:nth-of-type(2)")).toBe(true);
    expect(selectors.has("body > header")).toBe(true);
    expect(selectors.has("body > footer")).toBe(true);
    expect(selectors.has("body > main")).toBe(true);
  });

  it("carries the style digest, label and overflow flag through to the entry", () => {
    const entries = selectSignificant(proofElements()).entries;
    const table = entries.find((e) => e.selector === "body > main > section:nth-of-type(2) > table");
    expect(table?.overflowsX).toBe(true);
    const h1 = entries.find((e) => e.selector === "body > main > h1");
    expect(h1?.label).toBe("Billing");
    expect(h1?.style?.fontSizePx).toBe(19);
  });

  it("keeps EVERY mandatory entry even under a hostile per-viewport budget", () => {
    // All eleven elements above are mandatory (measured/overflow/interactive/
    // landmark/text/layout). A budget of 5 must not drop any of them.
    const all = proofElements();
    const result = selectSignificant(all, [], { maxEntriesPerViewport: 5 });
    // Every mandatory element survives; the significant classes are still present.
    for (const selector of [
      "body > main > section:nth-of-type(2) > table",
      "body > header > nav",
      "body > main > h1",
      "#bell",
      "body > footer > a",
    ]) {
      expect(result.entries.map((e) => e.selector)).toContain(selector);
    }
    // A mandatory-only page drops no discretionary entries.
    expect(result.omittedByBudget).toBe(0);
  });

  it("drops discretionary fill first, and counts what it dropped", () => {
    // One mandatory (a heading) plus many discretionary generic-but-styled divs.
    const mandatory = el({ tag: "h1", cssPath: "body > h1", ownText: "T", rect: { x: 0, y: 0, width: 100, height: 30 } });
    const filler = Array.from({ length: 20 }, (_, i) =>
      el({ tag: "div", cssPath: `body > div:nth-of-type(${i + 1})`, rect: { x: 0, y: 0, width: 300, height: 200 } }),
    );
    const result = selectSignificant([mandatory, ...filler], [], { maxEntriesPerViewport: 5 });
    // The heading (mandatory) survives; the budget is otherwise spent on fill.
    expect(result.entries.map((e) => e.selector)).toContain("body > h1");
    expect(result.entries.length).toBeLessThanOrEqual(5);
    expect(result.omittedByBudget).toBeGreaterThan(0);
  });
});
