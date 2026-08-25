import {
  deterministicChecks,
  factsForRoute,
  breakageForRoute,
  serializeGeometry,
  toInteractiveElements,
  toRawGeometryElements,
  toTextNodeStyles,
  type ExtractedPage,
} from "@apatureai/verdict-capture";
import type { Finding, Viewport } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { hallucinationGate } from "../src/index.js";

/**
 * The grounding gate (#32) used to delete findings about the engine's OWN
 * measurements.
 *
 * The deterministic checks run over text nodes (`p`, `span`, `li`), the geometry
 * map was landmark-only (`h1-h6, nav, a, button, input, select, textarea`). So
 * the engine could measure an overflow on a `<p>`, publish it as a fact the deep
 * prompt tells the model to trust, force the deep pass BECAUSE of that
 * measurement, and then delete the model's finding describing it, over the
 * caveat "citing a route or element that was never captured". The element had
 * been captured and measured; the caveat was false.
 *
 * These tests run the real production chain (extracted DOM -> checks -> geometry
 * map -> gate) rather than hand-built geometry, because the defect lived in the
 * gap between two of those steps and a fixture that skipped either one could not
 * have caught it. The second test is the other half of the contract: widening
 * the map to measured elements must not make the gate accept an element that was
 * genuinely never captured.
 */

const ROUTE = "/pricing";
const VIEWPORT: Viewport = "desktop";

/**
 * A page whose overflowing element is a `<p>`: measured by the overflow check,
 * not a landmark. `#hero-title` is the landmark control.
 */
const PAGE: ExtractedPage = {
  bodyText: "Pricing",
  documentHeight: 1200,
  canvasBackground: "rgb(255, 255, 255)",
  fonts: [],
  elements: [
    {
      tag: "h1",
      id: "hero-title",
      testId: null,
      role: null,
      cssPath: "body > main > h1",
      rect: { x: 32, y: 80, width: 600, height: 44 },
      animated: false,
      interactive: false,
      text: {
        fontSizePx: 36,
        fontWeight: 700,
        color: "rgb(16, 24, 40)",
        backgroundStack: ["rgb(255, 255, 255)"],
        contentWidthPx: 590,
      },
    },
    {
      tag: "p",
      id: "plan-blurb",
      testId: null,
      role: null,
      cssPath: "body > main > p",
      rect: { x: 32, y: 200, width: 200, height: 24 },
      animated: false,
      interactive: false,
      text: {
        fontSizePx: 16,
        fontWeight: 400,
        color: "rgb(16, 24, 40)",
        backgroundStack: ["rgb(255, 255, 255)"],
        contentWidthPx: 874,
      },
    },
  ],
};

/** The capture worker's own ordering: measure first, then serialize the map. */
function capturePage(page: ExtractedPage) {
  const measured = deterministicChecks({
    textNodes: toTextNodeStyles(page, ROUTE, VIEWPORT),
    interactive: toInteractiveElements(page, ROUTE, VIEWPORT),
  });
  const geometry = serializeGeometry(toRawGeometryElements(page, ROUTE, VIEWPORT), measured);
  return { measured, geometry, selectors: geometry.map((g) => g.selector) };
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "responsiveness",
  severity: "major",
  confidence: 0.9,
  route: ROUTE,
  viewport: VIEWPORT,
  elementRef: "#plan-blurb",
  title: "Plan blurb overflows its container",
  description: "Content is 874px wide inside a 200px container.",
  suggestion: null,
  introducedByThisPr: true,
  ...over,
});

describe("findings about measured elements survive the grounding gate (#32)", () => {
  it("keeps a finding citing a non-landmark element the engine measured an overflow on", () => {
    const { measured, selectors } = capturePage(PAGE);

    // The engine measured it, states it as a fact, and forces a deep pass on it.
    expect(factsForRoute(measured, ROUTE)).toContain(
      "- [overflow] #plan-blurb (desktop): content width 874px exceeds container 200px (horizontal overflow)",
    );
    expect(breakageForRoute(measured, ROUTE)).toContain(
      "[overflow] /pricing #plan-blurb: content width 874px exceeds container 200px (horizontal overflow)",
    );

    // So the element has to be citable.
    expect(selectors).toContain("#plan-blurb");

    const result = hallucinationGate([finding()], {
      capturedShots: [{ route: ROUTE, viewport: VIEWPORT }],
      geometrySelectors: selectors,
    });
    expect(result.findings.map((f) => f.elementRef)).toEqual(["#plan-blurb"]);
    expect(result.hallucinationDrops).toBe(0);
  });

  it("still deletes a finding citing an element that was genuinely never captured", () => {
    const { selectors } = capturePage(PAGE);
    expect(selectors).not.toContain("#pricing-table");

    const result = hallucinationGate(
      [finding(), finding({ elementRef: "#pricing-table" })],
      { capturedShots: [{ route: ROUTE, viewport: VIEWPORT }], geometrySelectors: selectors },
    );
    // The measured element survives; the invented one does not.
    expect(result.findings.map((f) => f.elementRef)).toEqual(["#plan-blurb"]);
    expect(result.hallucinationDrops).toBe(1);
  });

  it("still deletes a finding citing an uncaptured route, measured element or not", () => {
    const { selectors } = capturePage(PAGE);
    const result = hallucinationGate([finding({ route: "/checkout" })], {
      capturedShots: [{ route: ROUTE, viewport: VIEWPORT }],
      geometrySelectors: selectors,
    });
    expect(result.findings).toHaveLength(0);
    expect(result.hallucinationDrops).toBe(1);
  });

  it("does not admit every extracted element: an unmeasured non-landmark stays ungroundable", () => {
    const page: ExtractedPage = {
      ...PAGE,
      elements: [
        ...PAGE.elements,
        {
          tag: "span",
          id: "footnote",
          testId: null,
          role: null,
          cssPath: "body > main > span",
          rect: { x: 32, y: 300, width: 400, height: 18 },
          animated: false,
          interactive: false,
          // Fits its container and sits on a high-contrast backdrop: extracted,
          // but no check ever produced a fact naming it.
          text: {
            fontSizePx: 14,
            fontWeight: 400,
            color: "rgb(16, 24, 40)",
            backgroundStack: ["rgb(255, 255, 255)"],
            contentWidthPx: 380,
          },
        },
      ],
    };
    const { selectors } = capturePage(page);
    expect(selectors).toContain("#plan-blurb");
    expect(selectors).not.toContain("#footnote");

    const result = hallucinationGate([finding({ elementRef: "#footnote" })], {
      capturedShots: [{ route: ROUTE, viewport: VIEWPORT }],
      geometrySelectors: selectors,
    });
    expect(result.findings).toHaveLength(0);
    expect(result.hallucinationDrops).toBe(1);
  });
});
