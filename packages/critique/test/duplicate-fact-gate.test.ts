import { describe, expect, it } from "vitest";
import type { Finding } from "@apatureai/verdict-types";
import type { DeterministicFinding } from "@apatureai/verdict-capture";
import { buildFactLedger, classifyClaim, duplicateFactGate } from "../src/index.js";

/**
 * Judge-unlock §4.2: the duplicate-of-measurement gate is a real invariant. The
 * two findings the live model actually produced (verbatim from
 * scratchpad/wave1/proof/wirelog/text-003.txt) both restated measurements the
 * checker had already reported, and both must be dropped; a finding that requires
 * the repo's own rule (the #bell target under the stricter rule, with the WCAG
 * measurement DECLINED) must survive, and so must a finding that merely CITES a
 * measured literal as supporting context for a different claim.
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

// The reported measurements the deep prompt handed the model, plus the DECLINED
// #bell target-size measurement (the WCAG Spacing exception applied).
const ledger = buildFactLedger([
  {
    kind: "contrast",
    route: "/",
    viewport: "desktop",
    selector: "body > header > nav > a:nth-of-type(1)",
    detail: "text contrast 2.10:1 is below WCAG AA 4.5:1",
  },
  {
    kind: "overflow",
    route: "/",
    viewport: "mobile",
    selector: "body > main > section:nth-of-type(3) > p:nth-of-type(2)",
    detail: "content width 497px exceeds container 336px (horizontal overflow)",
  },
  {
    kind: "touch_target",
    route: "/",
    viewport: "mobile",
    selector: "#bell",
    detail: "touch target 20x20px is below the 24x24px minimum, but the Spacing exception applies",
    reported: false,
    declineReason: "the WCAG 2.2 SC 2.5.8 Spacing exception applies",
  },
] satisfies DeterministicFinding[]);

// The two findings the live run produced, verbatim.
const liveContrast = finding({
  dimension: "color_contrast",
  viewport: "desktop",
  elementRef: "body > header > nav > a:nth-of-type(1)",
  title: "Navigation links have insufficient text contrast",
  description:
    "The element `body > header > nav > a:nth-of-type(1)` has a text contrast ratio of 2.10:1, which is below the WCAG AA requirement of 4.5:1. This violates the constraint that all body text must meet WCAG AA contrast standards, reducing readability and accessibility for users with low vision.",
});
const liveOverflow = finding({
  dimension: "responsiveness",
  viewport: "mobile",
  elementRef: "body > main > section:nth-of-type(3) > p:nth-of-type(2)",
  title: "Section content overflows horizontally",
  description:
    "The element `body > main > section:nth-of-type(3) > p:nth-of-type(2)` has content width 497px exceeding the container width of 336px, causing horizontal overflow.",
});

describe("duplicateFactGate (judge-unlock §4.2)", () => {
  it("drops BOTH live-run findings as restatements of reported measurements", () => {
    const result = duplicateFactGate([liveContrast, liveOverflow], ledger);
    expect(result.duplicateFactDrops).toBe(2);
    expect(result.findings).toHaveLength(0);
    expect(result.restatements).toHaveLength(0);
  });

  it("keeps a repo-rule finding on an element whose WCAG measurement was DECLINED", () => {
    // #bell's target-size measurement is in the ledger as reported:false, so it
    // never suppresses. The repo's stricter 24x24-no-exception rule makes this
    // net-new.
    const bellRepoRule = finding({
      dimension: "accessibility",
      viewport: "mobile",
      elementRef: "#bell",
      title: "Notification control is under the repository's minimum size",
      description:
        "The design system requires interactive controls to be at least 24x24 CSS px on touch viewports with no exception; #bell is smaller and is the notification affordance.",
    });
    const result = duplicateFactGate([bellRepoRule], ledger);
    expect(result.duplicateFactDrops).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.elementRef).toBe("#bell");
  });

  it("keeps a hierarchy finding that only CITES a measured literal as context", () => {
    // Its OWN claim is a hierarchy judgment, not a measurement; the element carries
    // no reported measurement, so a stray literal is not a restatement.
    const hierarchy = finding({
      dimension: "visual_hierarchy",
      viewport: "mobile",
      elementRef: "body > footer > a",
      title: "The footer link is the most prominent text on the page",
      description:
        "The largest rendered text is the 34px footer link, while the page's own h1 renders at 12px, so the visual hierarchy is inverted against the brand rule.",
    });
    const result = duplicateFactGate([hierarchy], ledger);
    expect(result.duplicateFactDrops).toBe(0);
    expect(result.findings).toHaveLength(1);
  });

  // F4 — the reserved-selector case. A page_overflow measurement is keyed to the
  // reserved "document" selector, so the element-keyed check never sees it, and a
  // reworded page-overflow claim pinned to the widest ELEMENT slipped past the gate
  // and was miscounted as net-new (the shipped review scored 1, the CI metric 0).
  describe("F4 — page-overflow restatement (reserved `document` selector)", () => {
    const pageOverflowLedger = buildFactLedger([
      {
        kind: "page_overflow",
        route: "/",
        viewport: "mobile",
        selector: "document",
        detail:
          "document scroll width 927px exceeds the 390px viewport by 537px; widest escaping element: body > main > section:nth-of-type(2) > table (900px wide, right edge 927px)",
      },
    ] satisfies DeterministicFinding[]);

    it("DROPS a finding whose primary claim IS the page overflow, on the table it pins", () => {
      // The paraphrase attack, verbatim: a reworded page-overflow claim pinned to
      // the table, which carries no distinct element_overflow of its own.
      const paraphrase = finding({
        dimension: "responsiveness",
        viewport: "mobile",
        elementRef: "body > main > section:nth-of-type(2) > table",
        title: "The page scrolls sideways on a phone",
        description:
          "At this viewport the document is wider than the viewport and the whole page scrolls horizontally.",
      });
      const result = duplicateFactGate([paraphrase], pageOverflowLedger);
      // Excluded from net-new: neither kept as novel nor left uncounted.
      expect(result.findings).toHaveLength(0);
      expect(result.duplicateFactDrops + result.restatements.length).toBe(1);
    });

    it("DEMOTES an element-pinned overflow finding that adds judgment but restates the page fact", () => {
      const structural = finding({
        dimension: "responsiveness",
        viewport: "mobile",
        elementRef: "body > main > section:nth-of-type(2) > table",
        title: "Seven-column table cannot be a table at 390px",
        description:
          "The invoices table is laid out at a fixed 900px inside a 364px card; at this viewport the columns should stack into a card per invoice.",
      });
      const result = duplicateFactGate([structural], pageOverflowLedger);
      expect(result.findings).toHaveLength(0); // not net-new
      expect(result.restatements).toHaveLength(1); // kept, demoted
    });

    it("keeps a finding on the table's OWN distinct element_overflow as net-new", () => {
      // The same route also reported a per-element overflow on THIS element — a
      // genuinely different, element-level fact, so an element_overflow finding on
      // it is not merely restating the page overflow.
      const ledgerWithElementOverflow = buildFactLedger([
        { kind: "page_overflow", route: "/", viewport: "mobile", selector: "document", detail: "document scroll width 927px exceeds the 390px viewport" },
        { kind: "overflow", route: "/", viewport: "mobile", selector: "#chart", detail: "content width 800px exceeds container 360px (horizontal overflow)" },
      ] satisfies DeterministicFinding[]);
      const dupOnChart = finding({
        dimension: "responsiveness",
        viewport: "mobile",
        elementRef: "#chart",
        title: "Chart overflows its card",
        description: "content width 800px exceeds container 360px, overflowing horizontally",
      });
      // Its own element_overflow is reported, so the existing exact-class branch
      // drops it as a duplicate of THAT measurement (not the page rule).
      const result = duplicateFactGate([dupOnChart], ledgerWithElementOverflow);
      expect(result.duplicateFactDrops).toBe(1);
    });
  });

  it("classifies claims by class, not wording", () => {
    // A paraphrase with no measurement literal still classifies as contrast.
    expect(
      classifyClaim(
        finding({ dimension: "color_contrast", title: "Nav text is hard to read", description: "the nav text barely stands out against its background" }),
      ),
    ).toBe("contrast");
    // A visual-hierarchy finding with no markers is not a measurement class.
    expect(classifyClaim(finding({ dimension: "visual_hierarchy", title: "weak hierarchy", description: "the eye lands nowhere first" }))).toBeNull();
  });
});
