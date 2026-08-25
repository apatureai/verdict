import type { Finding } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  assembleCritique,
  toEngineReviewResult,
  type CapturedShot,
  type DeepPassRouteResult,
} from "../src/index.js";

/**
 * W1-03, requirement (3): a model-backed finding with `screenshotId: null` must be
 * impossible. The gate keeps a finding only when its `(route, viewport)` pair was
 * captured, and the projection resolves the screenshot by that same pair — so
 * every surviving finding names a shot that exists. This exercises the whole
 * chain (gate -> assemble -> wire projection) with the exact `(route, viewport)`
 * lookup both production surfaces use to bind `screenshotIdFor`.
 */

// A tiny stand-in for the captured image set: the pairs a run actually produced.
const captured: Array<CapturedShot & { objectKey: string }> = [
  { route: "/pricing", viewport: "mobile", objectKey: "shot_pricing_mobile" },
  { route: "/pricing", viewport: "desktop", objectKey: "shot_pricing_desktop" },
  { route: "/", viewport: "mobile", objectKey: "shot_home_mobile" },
];

// The exact resolver `runLocalReview` and `screenshotIdForCapture` use.
const screenshotIdFor = (finding: Finding): string | null =>
  captured.find((s) => s.route === finding.route && s.viewport === finding.viewport)?.objectKey ?? null;

const capturedShots: CapturedShot[] = captured.map(({ route, viewport }) => ({ route, viewport }));

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence: 0.9,
  route: "/pricing",
  viewport: "mobile",
  elementRef: "#cta",
  title: "Uneven gap",
  description: "uneven gap above the CTA",
  suggestion: null,
  introducedByThisPr: true,
  ...over,
});

const routeResult = (route: string, findings: Finding[]): DeepPassRouteResult => ({
  route,
  output: { grade: "needs_work", overall: "issues found", findings, notReviewed: [] },
});

const deps = {
  capturedShots,
  model: "qwen3-vl-plus",
  captureVersion: "stub@0",
  uiDnaVersion: null,
};

describe("W1-03 (3): every surviving finding resolves a screenshot", () => {
  it("no surviving wire finding carries screenshotId: null, including ungrounded ones", () => {
    const critique = assembleCritique(
      [
        routeResult("/pricing", [
          finding({ viewport: "mobile", elementRef: "#cta" }), // grounded, captured
          finding({ viewport: "desktop", elementRef: null, dimension: "typography" }), // ungrounded, captured shot exists
          // A hallucinated viewport: /pricing was NOT captured at tablet. The gate
          // must drop this so it can never reach the projection with a null shot.
          finding({ viewport: "tablet", elementRef: "#ghost", severity: "blocker" }),
        ]),
        routeResult("/", [finding({ route: "/", viewport: "mobile", elementRef: null, dimension: "color_contrast" })]),
      ],
      deps,
    );

    const result = toEngineReviewResult(critique, { screenshotRetentionSeconds: 60, screenshotIdFor });

    // The tablet finding was dropped by the gate (uncaptured shot).
    expect(critique.validation.hallucinationDrops).toBe(1);
    expect(result.findings.some((f) => f.viewport === "tablet")).toBe(false);

    // The load-bearing invariant: every finding that DID survive resolves a shot.
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(f.screenshotId).not.toBeNull();
    }
  });
});
