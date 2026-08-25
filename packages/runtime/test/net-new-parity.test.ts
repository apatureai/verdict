import { describe, expect, it } from "vitest";
import type { DeterministicFinding } from "@apatureai/verdict-capture";
import type { Finding } from "@apatureai/verdict-types";
import { buildFactLedger, runValidationTail, type CapturedShot } from "@apatureai/verdict-critique";
import { netNewFindingCount, type NetNewLedger } from "@apatureai/verdict-eval";

/**
 * F4 — ONE net-new definition, applied in both places.
 *
 * The shipped counter (`review.json.netNewFindings`, from the validation tail's
 * duplicate-of-measurement gate) and the CI metric (`netNewFindingCount` in the
 * eval package) must AGREE. They did not: the tail's gate matched a page-overflow
 * measurement on `selector === elementRef`, but page_overflow is keyed to the
 * reserved `document` selector, so a reworded page-overflow claim pinned to the
 * widest ELEMENT was scored 1 net-new by the shipped review while the CI metric
 * scored 0. This test runs the paraphrase attack through BOTH and asserts parity.
 */

const deterministic: DeterministicFinding[] = [
  {
    kind: "page_overflow",
    route: "/",
    viewport: "mobile",
    selector: "document",
    detail:
      "document scroll width 927px exceeds the 390px viewport by 537px; widest escaping element: body > main > section:nth-of-type(2) > table (900px wide)",
  },
  {
    kind: "contrast",
    route: "/",
    viewport: "mobile",
    selector: "#gear",
    detail: "text contrast 2.39:1 is below WCAG AA 4.5:1",
  },
];

/** The eval-side NetNewLedger, derived from the SAME deterministic findings. */
const factLedger = buildFactLedger(deterministic);
const netNewLedger: NetNewLedger = {
  entries: factLedger.entries.map((e) => ({
    claimClass: e.claimClass,
    route: e.route,
    selector: e.selector,
    reported: e.reported,
  })),
};

const finding = (over: Partial<Finding>): Finding => ({
  dimension: "responsiveness",
  severity: "major",
  confidence: 0.9,
  route: "/",
  viewport: "mobile",
  elementRef: null,
  title: "",
  description: "",
  suggestion: null,
  introducedByThisPr: false,
  ...over,
});

const shots: CapturedShot[] = [{ route: "/", viewport: "mobile" }];
const geometrySelectors = ["body > main > section:nth-of-type(2) > table", "#gear"];

describe("F4 — net-new parity between the shipped tail and the CI metric", () => {
  it("scores the reworded page-overflow restatement 0 on BOTH counters", () => {
    // The paraphrase attack: a page-overflow restatement pinned to the table.
    const paraphrase = finding({
      dimension: "responsiveness",
      elementRef: "body > main > section:nth-of-type(2) > table",
      title: "The page scrolls sideways on a phone",
      description:
        "At this viewport the document is wider than the viewport and the whole page scrolls horizontally.",
    });

    const tail = runValidationTail({
      findings: [paraphrase],
      modelGrade: "needs_work",
      capturedShots: shots,
      geometrySelectors,
      captureUnstable: false,
      factLedger,
      identity: {
        model: "qwen3vl-32k",
        promptVersion: "p",
        engineVersion: "e",
        captureVersion: "c",
        rubricVersion: "r",
      },
    });

    // The CI metric scores the SHIPPED findings (grounded + ungrounded + restated).
    const metric = netNewFindingCount(
      tail.findings.map((f) => ({ ...f, elementRef: f.elementRef ?? null })),
      netNewLedger,
    );

    expect(tail.netNewFindings).toBe(0);
    expect(metric).toBe(0);
    expect(tail.netNewFindings).toBe(metric); // the parity the fix guarantees
  });

  it("agrees on a genuinely net-new judgment (both count it)", () => {
    // A brand finding on the table cites nothing the checker measured — net-new.
    const brand = finding({
      dimension: "brand",
      elementRef: "body > main > section:nth-of-type(2) > table",
      title: "Zebra striping uses an off-brand grey",
      description: "The alternating row background is #efefef, not the neutral token #f4f6f8.",
    });
    const tail = runValidationTail({
      findings: [brand],
      modelGrade: "needs_work",
      capturedShots: shots,
      geometrySelectors,
      captureUnstable: false,
      factLedger,
      identity: { model: "m", promptVersion: "p", engineVersion: "e", captureVersion: "c", rubricVersion: "r" },
    });
    const metric = netNewFindingCount(
      tail.findings.map((f) => ({ ...f, elementRef: f.elementRef ?? null })),
      netNewLedger,
    );
    expect(tail.netNewFindings).toBe(1);
    expect(metric).toBe(1);
  });
});
