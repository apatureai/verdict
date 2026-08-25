import { describe, expect, it } from "vitest";
import { pageOverflowViolations, type PageMetrics } from "../src/index.js";

/**
 * Judge-unlock §3.5: the page_overflow check closes the arithmetic half of the
 * biggest defect on the proof page — a 927px document in a 390px viewport, driven
 * by a 900px table.
 */

const proof = (over: Partial<PageMetrics> = {}): PageMetrics => ({
  route: "/",
  viewport: "mobile",
  viewportWidthPx: 390,
  documentScrollWidthPx: 927,
  rootScrollsX: false,
  offenders: [
    { selector: "body > main > section:nth-of-type(2) > table", rightEdgePx: 927, widthPx: 900 },
  ],
  ...over,
});

describe("pageOverflowViolations (judge-unlock §3.5)", () => {
  it("fires on 927 vs 390 and names the widest escaping element", () => {
    const [finding, ...rest] = pageOverflowViolations([proof()]);
    expect(rest).toHaveLength(0);
    expect(finding?.kind).toBe("page_overflow");
    expect(finding?.selector).toBe("document");
    expect(finding?.detail).toContain("927px exceeds the 390px viewport by 537px");
    expect(finding?.detail).toContain("body > main > section:nth-of-type(2) > table");
    expect(finding?.detail).toContain("900px");
  });

  it("is block-eligible only when the root does not scroll and an offender is named", () => {
    expect(pageOverflowViolations([proof()])[0]?.blockEligible).toBe(true);
    // Root scrolls horizontally on purpose -> not the page coming apart.
    expect(pageOverflowViolations([proof({ rootScrollsX: true })])[0]?.blockEligible).toBe(false);
    // Root-scroll unknown (absent) -> fail closed, never gates.
    expect(pageOverflowViolations([proof({ rootScrollsX: undefined })])[0]?.blockEligible).toBe(false);
    // No offender named -> not gateable.
    expect(pageOverflowViolations([proof({ offenders: [] })])[0]?.blockEligible).toBe(false);
  });

  it("bands the excess by share of the viewport (537 of 390 is major)", () => {
    // 537/390 = 1.38 > 0.5 -> band 3.
    expect(pageOverflowViolations([proof()])[0]?.severity).toBe(3);
  });

  it("does not fire when the document fits within a pixel of the viewport", () => {
    expect(pageOverflowViolations([proof({ documentScrollWidthPx: 390 })])).toHaveLength(0);
    expect(pageOverflowViolations([proof({ documentScrollWidthPx: 391 })])).toHaveLength(0);
    expect(pageOverflowViolations([proof({ documentScrollWidthPx: 392 })])).toHaveLength(1);
  });
});
