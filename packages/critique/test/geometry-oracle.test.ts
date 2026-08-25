import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Finding, GeometryRect } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  citableSelectors,
  hallucinationGate,
  MAX_GEOMETRY_CHARS_PER_VIEWPORT,
  planGeometry,
  type CapturedShot,
} from "../src/index.js";

/**
 * F2 — the geometry-budget regression, on the REAL proof capture (the mobile route
 * whose live run produced eleven grounded findings and published zero).
 *
 * Two compounding bugs made only 34 of the 59 captured selectors citable at the
 * historic 6_000-char budget: `isStructurallySignificant()` promoted EVERY
 * overflowing element to a full line (26 table descendants inheriting the table's
 * overflow ate the budget in document order), and the `also cite` collapse never
 * fired. The offline oracle — six correct findings, one per known defect class,
 * each citing a real selector — then lost two of its six to the shrunken accept
 * set (6/6 → 4/6), because the grounding gate's accept set is derived from exactly
 * these citable selectors.
 *
 * The fix raises the default budget to 10_000, promotes only the OUTERMOST overflow
 * contributor (by rect containment, robust to the capture's inconsistent selector
 * prefixes), and lets the collapse run. The whole 59-selector map is citable again,
 * and the oracle is restored to 6/6.
 */
const PROOF_GEOMETRY: GeometryRect[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/proof-geometry.json", import.meta.url)), "utf8"),
);

/** The offline oracle: six correct findings, one per known defect class. */
const ORACLE_SELECTORS = [
  "body > footer > a", // visual hierarchy
  "body > main > section:nth-of-type(3) > p:nth-of-type(2)", // typography (SF Mono)
  "#bell", // accessibility (touch target)
  "#upgrade", // consistency (off-token background)
  "body > main > section:nth-of-type(1)", // spacing (off 8px scale)
  "body > main > section:nth-of-type(2) > table", // responsiveness (overflow)
];

const oracleFinding = (elementRef: string): Finding => ({
  dimension: "spacing",
  severity: "major",
  confidence: 0.9,
  route: "/",
  viewport: "mobile",
  elementRef,
  title: "t",
  description: "d",
  suggestion: null,
  introducedByThisPr: true,
});

const SHOTS: CapturedShot[] = [{ route: "/", viewport: "mobile" }];

describe("F2 — geometry budget & the offline oracle (proof capture)", () => {
  it("makes the WHOLE 59-selector proof map citable at the module-default budget", () => {
    // The property the whole fix rests on: the prompt is never stricter than the
    // gate. At the historic 6_000 budget this was 34/59.
    const citable = citableSelectors(PROOF_GEOMETRY);
    expect(citable.size).toBe(PROOF_GEOMETRY.length);
    // And the raised default is what buys it: 6_000 does NOT fit the whole map.
    expect(MAX_GEOMETRY_CHARS_PER_VIEWPORT).toBeGreaterThanOrEqual(10_000);
    const narrow = citableSelectors(PROOF_GEOMETRY, { maxCharsPerViewport: 6_000, maxCharsPerRequest: 18_000 });
    expect(narrow.size).toBeLessThan(PROOF_GEOMETRY.length);
  });

  it("restores the oracle to 6/6: every oracle finding survives the grounding gate", () => {
    const geometrySelectors = citableSelectors(PROOF_GEOMETRY);
    // The accept set is derived from the citable selectors, so a citable oracle
    // selector is an accepted one.
    for (const selector of ORACLE_SELECTORS) expect(geometrySelectors.has(selector)).toBe(true);

    const gated = hallucinationGate(ORACLE_SELECTORS.map(oracleFinding), { capturedShots: SHOTS, geometrySelectors });
    expect(gated.findings).toHaveLength(6);
    expect(gated.hallucinationDrops).toBe(0);
  });

  it("collapses the overflowing table's duplicate descendants instead of promoting each to a full line", () => {
    const plan = planGeometry(PROOF_GEOMETRY);
    // The collapse actually runs (it never did in the field).
    expect(plan.text).toContain("also cite");
    // The outermost overflow container is a full line WITH the marker; its many
    // inherited-overflow descendants are not each a full line.
    const fullLines = plan.text.split("\n").filter((l) => l.startsWith("- "));
    const tableCellFullLines = fullLines.filter((l) => /> t[dr]\b|> th\b|tbody|thead/.test(l));
    // The table and its containers overflow, but the ~20 individual cells/rows do
    // not each earn a full line (they collapse), so far fewer than the 26 that the
    // blanket overflow promotion produced.
    expect(tableCellFullLines.length).toBeLessThan(10);
  });
});
