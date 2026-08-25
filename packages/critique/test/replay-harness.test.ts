import { describe, expect, it } from "vitest";
import type { Finding } from "@apatureai/verdict-types";
import type { DeterministicFinding } from "@apatureai/verdict-capture";
import { replayNetNew, type ReplayFixture } from "../src/index.js";

/**
 * Judge-unlock §6 (requirement 4): the offline net-new harness replays a recorded
 * model response against a fixture page and reports raw findings, gate drops by
 * reason, survivors, and NET-NEW survivors — with no live model. This test is the
 * offline proof (§6 step 3): the two findings the live run actually produced are
 * both duplicates, so the run's effective net-new output is ZERO, and the harness
 * says so in a number CI can track.
 */

const finding = (over: Partial<Finding>): Finding => ({
  dimension: "visual_hierarchy",
  severity: "major",
  confidence: 1,
  route: "/",
  viewport: "mobile",
  elementRef: null,
  title: "",
  description: "",
  suggestion: null,
  introducedByThisPr: false,
  ...over,
});

const deterministicFindings: DeterministicFinding[] = [
  { kind: "contrast", route: "/", viewport: "desktop", selector: "body > header > nav > a:nth-of-type(1)", detail: "text contrast 2.10:1 is below WCAG AA 4.5:1" },
  { kind: "overflow", route: "/", viewport: "mobile", selector: "body > main > section:nth-of-type(3) > p:nth-of-type(2)", detail: "content width 497px exceeds container 336px" },
  { kind: "touch_target", route: "/", viewport: "mobile", selector: "#bell", detail: "touch target 20x20px is below 24x24, Spacing exception applies", reported: false, declineReason: "SC 2.5.8 Spacing exception" },
];

const fixture: ReplayFixture = {
  capturedShots: [
    { route: "/", viewport: "mobile" },
    { route: "/", viewport: "desktop" },
  ],
  geometrySelectors: [
    "body > header > nav > a:nth-of-type(1)",
    "body > main > section:nth-of-type(3) > p:nth-of-type(2)",
    "#bell",
    "body > footer > a",
  ],
  deterministicFindings,
  modelGrade: "needs_work",
};

const liveFindings: Finding[] = [
  finding({
    dimension: "color_contrast",
    viewport: "desktop",
    elementRef: "body > header > nav > a:nth-of-type(1)",
    title: "Navigation links have insufficient text contrast",
    description: "The element has a text contrast ratio of 2.10:1, which is below the WCAG AA requirement of 4.5:1.",
  }),
  finding({
    dimension: "responsiveness",
    viewport: "mobile",
    elementRef: "body > main > section:nth-of-type(3) > p:nth-of-type(2)",
    title: "Section content overflows horizontally",
    description: "The element has content width 497px exceeding the container width of 336px, causing horizontal overflow.",
  }),
];

describe("replayNetNew offline harness (judge-unlock §6)", () => {
  it("reports the live run's effective net-new output as ZERO", () => {
    const report = replayNetNew(liveFindings, fixture);
    expect(report.rawFindings).toBe(2);
    expect(report.duplicateFactDrops).toBe(2);
    expect(report.hallucinationDrops).toBe(0);
    expect(report.survivors).toBe(0);
    expect(report.netNewFindings).toBe(0);
    expect(report.netNewFindingRate).toBe(0);
  });

  it("counts a repo-rule finding and a hierarchy finding as net-new survivors", () => {
    const withNetNew: Finding[] = [
      ...liveFindings,
      finding({
        dimension: "accessibility",
        viewport: "mobile",
        elementRef: "#bell",
        title: "Notification control is under the repository's minimum size",
        description: "The design system requires interactive controls to be at least 24x24 CSS px on touch viewports with no exception.",
      }),
      finding({
        dimension: "visual_hierarchy",
        viewport: "mobile",
        elementRef: "body > footer > a",
        title: "The footer link is the most prominent text on the page",
        description: "The largest rendered text is the footer link while the page h1 is smaller, inverting the hierarchy against the brand rule.",
      }),
    ];
    const report = replayNetNew(withNetNew, fixture);
    expect(report.rawFindings).toBe(4);
    expect(report.duplicateFactDrops).toBe(2);
    expect(report.survivors).toBe(2);
    expect(report.netNewFindings).toBe(2);
    expect(report.netNewFindingRate).toBe(0.5);
    expect(report.survivorFindings.map((f) => f.elementRef).sort()).toEqual([
      "#bell",
      "body > footer > a",
    ]);
  });

  it("drops a finding that cites a selector the fixture never produced", () => {
    const hallucinated = [finding({ elementRef: "#ghost", dimension: "spacing", description: "cramped" })];
    const report = replayNetNew(hallucinated, fixture);
    expect(report.hallucinationDrops).toBe(1);
    expect(report.survivors).toBe(0);
  });
});
