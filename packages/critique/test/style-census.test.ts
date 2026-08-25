import { describe, expect, it } from "vitest";
import type { GeometryRect, StyleDigest, Viewport } from "@apatureai/verdict-types";
import { renderStyleCensus } from "../src/index.js";

/**
 * Judge-unlock §2.5b: the style census states the DISTRIBUTION of every style
 * value on the page, converting "scan N elements for an outlier" into "read one
 * line". It is a statement of distribution, never a finding.
 */

const digest = (over: Partial<StyleDigest> = {}): StyleDigest => ({
  fontFamily: "Helvetica Neue",
  fontSizePx: 12,
  fontWeight: 400,
  lineHeightPx: 14,
  color: "#101828",
  backgroundColor: "transparent",
  paddingPx: [0, 0, 0, 0],
  marginPx: [0, 0, 0, 0],
  gapPx: null,
  borderRadiusPx: 0,
  display: null,
  ...over,
});

const geom = (
  selector: string,
  style: StyleDigest,
  label: string | undefined,
  viewport: Viewport = "mobile",
): GeometryRect => ({
  route: "/",
  viewport,
  selector,
  role: "generic",
  rect: { x: 0, y: 0, width: 100, height: 20 },
  style,
  ...(label !== undefined ? { label } : {}),
});

describe("renderStyleCensus (judge-unlock §2.5b)", () => {
  const geometry: GeometryRect[] = [
    geom("body > header > nav > a:nth-of-type(1)", digest({ fontFamily: "Georgia", fontSizePx: 13 }), "Docs"),
    geom("body > header > nav > a:nth-of-type(2)", digest({ fontFamily: "Georgia", fontSizePx: 13 }), "Status"),
    geom("body > main > section:nth-of-type(3) > p.ref-line", digest({ fontFamily: "SF Mono", fontSizePx: 11 }), "webhook"),
    geom("body > main > h1", digest({ fontFamily: "Helvetica Neue", fontSizePx: 19, fontWeight: 600 }), "Billing"),
    geom("body > main > p.lede", digest({ fontFamily: "Helvetica Neue", fontSizePx: 14 }), "Manage your plan"),
    geom("body > footer > a", digest({ fontFamily: "Helvetica Neue", fontSizePx: 34, fontWeight: 800 }), "Terms"),
  ];

  it("names every font family with its element count", () => {
    const census = renderStyleCensus(geometry);
    expect(census).toContain("Georgia x2");
    expect(census).toContain('"SF Mono" x1');
    expect(census).toContain('"Helvetica Neue" x3');
  });

  it("hands the hierarchy comparison to the model as two pre-computed facts", () => {
    const census = renderStyleCensus(geometry);
    // The largest rendered text is the footer link, not the h1 — the hierarchy
    // inversion, stated as a fact without asserting it is a defect.
    expect(census).toMatch(/largest rendered text: 34px\/800 on `body > footer > a`/);
    expect(census).toMatch(/page h1: 19px\/600 on `body > main > h1`/);
  });

  it("renders nothing when no element carries a style digest", () => {
    const styleless: GeometryRect[] = [
      { route: "/", viewport: "mobile", selector: "#x", role: "generic", rect: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    expect(renderStyleCensus(styleless)).toBe("");
    expect(renderStyleCensus([])).toBe("");
    expect(renderStyleCensus(undefined)).toBe("");
  });
});
