import { describe, expect, it } from "vitest";
import {
  declinedForRoute,
  deterministicChecks,
  factsForRoute,
  touchTargetViolations,
  type InteractiveElement,
} from "../src/index.js";

/**
 * Judge-unlock §1.2/§4.1: the sharpest case. A lone 20x20 control with clear
 * space around it meets the WCAG 2.2 SC 2.5.8 Spacing exception, so the checker
 * DECLINES it. The declined measurement must be surfaced to the model as
 * "measured, declined, here is why" (so it can be judged against the repo's
 * stricter rule), while the reported fact list stays byte-identical to today.
 */

const bell: InteractiveElement = {
  route: "/",
  viewport: "mobile",
  selector: "#bell",
  role: null,
  rect: { x: 316, y: 14, width: 20, height: 20 },
  inlineTarget: false,
};

describe("declined measurements (judge-unlock §4.1)", () => {
  it("emits a lone undersized control as reported:false with a reason", () => {
    // No peers, so the Spacing exception applies and WCAG is not violated.
    const declined = touchTargetViolations([bell], { includeDeclined: true });
    expect(declined).toHaveLength(1);
    expect(declined[0]?.reported).toBe(false);
    expect(declined[0]?.selector).toBe("#bell");
    expect(declined[0]?.declineReason).toMatch(/Spacing exception/);
    expect(declined[0]?.detail).toContain("nothing was reported");
    expect(declined[0]?.blockEligible).toBe(false);
  });

  it("emits NOTHING for the same control when declines are not requested (byte-identical)", () => {
    expect(touchTargetViolations([bell])).toEqual([]);
  });

  it("keeps the reported fact list unchanged whether or not declines are collected", () => {
    const withoutDeclined = deterministicChecks({ textNodes: [], interactive: [bell] });
    const withDeclined = deterministicChecks({ textNodes: [], interactive: [bell], includeDeclined: true });
    // The reported fact list a reviewer sees is identical: the declined
    // measurement never enters `factsForRoute`.
    expect(factsForRoute(withoutDeclined, "/")).toEqual(factsForRoute(withDeclined, "/"));
    expect(factsForRoute(withDeclined, "/")).toEqual([]);
    // The declined measurement travels only on its own block.
    expect(declinedForRoute(withDeclined, "/")).toHaveLength(1);
    expect(declinedForRoute(withDeclined, "/")[0]).toContain("#bell");
    expect(declinedForRoute(withoutDeclined, "/")).toEqual([]);
  });
});
