import type { DeterministicFinding } from "@apatureai/verdict-capture";
import type { EngineReviewResult } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  ungroundedDisclosure,
  UNGROUNDED_DISCLOSURE_PREFIX,
  type LocalGrounding,
} from "../src/grounding.js";
import {
  countByKind,
  displayPath,
  groupFacts,
  renderFacts,
  renderFindings,
  renderFixtureCritique,
  renderGrounding,
  renderStability,
  renderSummary,
  type RunSummary,
} from "../src/report.js";

const FACTS: DeterministicFinding[] = [
  { kind: "touch_target", route: "/", viewport: "mobile", selector: "#icon-close", detail: "28x28" },
  { kind: "contrast", route: "/", viewport: "mobile", selector: "#hero-subtitle", detail: "3.23:1" },
  { kind: "contrast", route: "/", viewport: "desktop", selector: "#hero-subtitle", detail: "3.23:1" },
];

const RESULT: EngineReviewResult = {
  grade: "needs_work",
  overall: "one real issue",
  blockingEnabled: false,
  confidenceUnavailableReason: "missing_calibration_report",
  findings: [
    {
      id: "f_001",
      dimension: "accessibility",
      severity: "major",
      title: "Dismiss control is a 28x28 touch target",
      description: "below the 44x44 minimum",
      route: "/",
      viewport: "mobile",
      element: "#icon-close",
      screenshotId: null,
      suggestion: "pad it",
    },
  ],
  notReviewed: [],
  artifacts: { annotatedScreenshots: [] },
  screenshotRetentionSeconds: 0,
  metadata: {
    engineVersion: "0.1.0",
    model: "canned",
    promptVersion: "system-prompt@v6",
    captureVersion: "chromium-playwright@1",
    uiDnaVersion: null,
  },
};

const UNGROUNDED: Extract<LocalGrounding, { grounded: false }> = {
  grounded: false,
  reason: "no_genome_file",
  disclosure: ungroundedDisclosure(
    "no_genome_file",
    "no UI-DNA snapshot was found at ./demo-site/ui-dna.json",
    { tokens: { "color.brand": "#4f46e5" }, brand: null, componentLibraries: [], uiDnaVersion: null },
  ),
};

const GROUNDED: LocalGrounding = {
  grounded: true,
  uiDnaVersion: "ui-dna@2026.06.12",
  ruleCount: 9,
  source: "./demo-site/ui-dna.json",
  embedder: "lexical-hash-256@1",
  authorityChecked: false,
};

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    target: "http://127.0.0.1:5000",
    targetNote: "(bundled demo site)",
    routes: ["/", "/pricing"],
    viewports: ["mobile", "desktop"],
    modelKind: "live",
    modelDescription: "LIVE model client",
    captureVersion: "chromium-playwright@1",
    screenshotCount: 4,
    screenshotDir: "out/screenshots",
    geometryCount: 57,
    // The default for these cases is the common one: no genome was resolved, so
    // the review carries the disclosure rather than a version stamp.
    grounding: UNGROUNDED,
    deterministicFindings: FACTS,
    factsFile: "out/deterministic-facts.txt",
    pageHealthFootnote: null,
    stability: null,
    hallucinationDrops: 2,
    modelFindingsSeen: 3,
    result: RESULT,
    files: ["out/review.json"],
    elapsedMs: 8421,
    ...overrides,
  };
}

describe("countByKind", () => {
  it("counts in a stable check order and omits absent kinds", () => {
    expect(countByKind(FACTS)).toEqual([
      ["contrast", 2],
      ["touch_target", 1],
    ]);
    expect(countByKind([])).toEqual([]);
  });
});

describe("displayPath", () => {
  it("prefers the relative form unless it escapes upward", () => {
    expect(displayPath("/repo/out/review.json", "out/review.json")).toBe("out/review.json");
    expect(displayPath("/tmp/x/review.json", "../../tmp/x/review.json")).toBe("/tmp/x/review.json");
  });
});

describe("renderFindings", () => {
  it("prints severity, dimension, title and the grounded address", () => {
    expect(renderFindings(RESULT)[0]).toContain("[major/accessibility] Dismiss control is a 28x28 touch target");
    expect(renderFindings(RESULT)[0]).toContain("/ mobile → #icon-close");
  });

  it("says so when nothing survived", () => {
    expect(renderFindings({ ...RESULT, findings: [] })).toEqual(["  (none)"]);
  });
});

describe("groupFacts", () => {
  it("collapses one defect measured at several viewports into one entry", () => {
    expect(groupFacts(FACTS)).toEqual([
      { kind: "touch_target", route: "/", selector: "#icon-close", detail: "28x28", viewports: ["mobile"] },
      {
        kind: "contrast",
        route: "/",
        selector: "#hero-subtitle",
        detail: "3.23:1",
        viewports: ["mobile", "desktop"],
      },
    ]);
  });

  it("keeps two different measurements on the same element apart", () => {
    const grouped = groupFacts([
      { kind: "contrast", route: "/", viewport: "mobile", selector: "#a", detail: "3.2:1" },
      { kind: "contrast", route: "/", viewport: "desktop", selector: "#a", detail: "4.1:1" },
    ]);
    expect(grouped).toHaveLength(2);
  });
});

describe("renderFacts", () => {
  it("prints the measurement itself, not just a count", () => {
    const lines = renderFacts(summary());
    expect(lines[1]).toBe("  3 measurement(s) (contrast 2, touch_target 1) over 2 distinct element(s)");
    expect(lines.join("\n")).toContain("[contrast] / #hero-subtitle (mobile, desktop)\n      3.23:1");
    expect(lines.at(-1)).toBe("  every measurement: out/deterministic-facts.txt");
  });

  it("truncates a long list and says how many are left", () => {
    const many: DeterministicFinding[] = Array.from({ length: 15 }, (_, i) => ({
      kind: "contrast" as const,
      route: "/",
      viewport: "mobile" as const,
      selector: `#e${i}`,
      detail: "3.0:1",
    }));
    const lines = renderFacts(summary({ deterministicFindings: many }));
    expect(lines.join("\n")).toContain("…and 3 more");
  });

  it("says nothing was measured rather than staying silent", () => {
    expect(renderFacts(summary({ deterministicFindings: [] }))[1]).toContain(
      "no contrast, overflow or touch-target violation was measured",
    );
  });
});

describe("renderFixtureCritique", () => {
  it("labels replayed text as fixture text and does not number it", () => {
    const lines = renderFixtureCritique(summary({ modelKind: "canned" }));
    expect(lines[0]).toContain("FIXTURE TEXT: replayed from the canned client, not a judgment about this page");
    expect(lines.at(-1)).toContain("  - [major/accessibility] Dismiss control is a 28x28 touch target");
  });

  it("says the mock client judged nothing at all", () => {
    const lines = renderFixtureCritique(
      summary({ modelKind: "mock", result: { ...RESULT, findings: [] } }),
    );
    expect(lines.join("\n")).toContain("Nothing above judged this page");
  });
});

/**
 * The report has to answer "was this critiqued against my design system" as
 * plainly as it answers "did a model look at my page". Both answers are printed
 * from the same values the result carries, so the terminal and `review.json`
 * cannot say different things.
 */
describe("renderGrounding", () => {
  it("names the version, the rule count and the function that ranked them", () => {
    const lines = renderGrounding(GROUNDED).join("\n");
    expect(lines).toContain("ui-dna@2026.06.12");
    expect(lines).toContain("9 rule(s) from ./demo-site/ui-dna.json");
    // Two embedders retrieve different rules from one genome, so a grounded run
    // that cannot say which one ranked it cannot be compared with another.
    expect(lines).toContain("lexical-hash-256@1");
  });

  it("says a locally grounded review is advisory because authority was not checked", () => {
    const lines = renderGrounding(GROUNDED).join("\n");
    expect(lines).toContain("authority");
    expect(lines).toContain("no authority service is reachable from a local run");
    expect(lines).toContain("cannot block");
  });

  it("prints the reason and the result's own disclosure when nothing grounded the run", () => {
    const lines = renderGrounding(UNGROUNDED).join("\n");
    expect(lines).toContain("none (no_genome_file)");
    // Verbatim, so a reader of the terminal and a reader of review.json meet the
    // same sentence rather than two paraphrases of it.
    expect(lines).toContain(UNGROUNDED.disclosure);
    expect(lines).not.toContain("ui-dna@");
  });
});

describe("renderSummary", () => {
  it("prints the design-system grounding block between the facts and the gate", () => {
    const grounded = renderSummary(summary({ grounding: GROUNDED }));
    expect(grounded).toContain("Design-system grounding");
    expect(grounded).toContain("ui-dna@2026.06.12");
    expect(grounded.indexOf("Design-system grounding")).toBeGreaterThan(
      grounded.indexOf("Measured facts"),
    );
    expect(grounded.indexOf("Design-system grounding")).toBeLessThan(
      grounded.indexOf("Grounding gate"),
    );

    const ungrounded = renderSummary(summary());
    expect(ungrounded).toContain(UNGROUNDED_DISCLOSURE_PREFIX);
    expect(ungrounded).not.toContain("ui-dna@2026.06.12");
  });

  it("reports the capture, the gate and the review together", () => {
    const text = renderSummary(summary());
    expect(text).toContain("4 screenshot(s) written to out/screenshots");
    expect(text).toContain("57 DOM element(s) recorded in the geometry map");
    expect(text).toContain("3 measurement(s) (contrast 2, touch_target 1) over 2 distinct element(s)");
    expect(text).toContain("page health: clean");
    expect(text).toContain("3 model finding(s) parsed, 2 dropped");
    expect(text).toContain("grade       needs_work");
    expect(text).toContain("withheld (missing_calibration_report)");
    expect(text).toContain("Done in 8.4s.");
  });

  it("refuses to print a grade when no model saw the page", () => {
    for (const kind of ["canned", "mock"] as const) {
      const text = renderSummary(summary({ modelKind: kind }));
      expect(text).toContain(`grade       n/a (${kind} client, no model saw this page)`);
      expect(text).toContain("findings    n/a (no model ran; see the measured facts above)");
      expect(text).toContain("confidence  n/a (no model ran)");
      // The fixture's own grade must not leak into the report in any form.
      expect(text).not.toContain("needs_work");
      expect(text).not.toContain("3 model finding(s) parsed");
      expect(text).toContain("3 replayed finding(s) parsed, 2 dropped");
    }
  });

  it("warns that review.json's grade is the fixture's, not the page's", () => {
    const text = renderSummary(summary({ modelKind: "canned" }));
    expect(text).toContain("note: review.json carries the fixture's own grade field.");
    expect(renderSummary(summary())).not.toContain("note: review.json");
  });

  it("blames the mock client, not a fixture, for the grade a mock run writes", () => {
    // There is no fixture on the mock path, so calling that stray grade "the fixture's" would
    // point the reader at a file that had nothing to do with it.
    const text = renderSummary(summary({ modelKind: "mock" }));
    expect(text).toContain("note: review.json carries the mock client's own grade field.");
    expect(text).not.toContain("the fixture's own grade field");
  });

  it("gives the numbered list to the measurements, not to replayed fixture text", () => {
    const text = renderSummary(summary({ modelKind: "canned" }));
    expect(text).toContain("   1. [touch_target] / #icon-close (mobile)");
    expect(text).not.toContain("   1. [major/accessibility]");
  });

  it("shows a numeric confidence when a calibration report was bound", () => {
    const text = renderSummary(summary({ result: { ...RESULT, confidence: 0.71 } }));
    expect(text).toContain("confidence  0.71");
  });

  it("surfaces the page-health footnote when the page was not clean", () => {
    const text = renderSummary(summary({ pageHealthFootnote: "Page health: 2 console error(s)." }));
    expect(text).toContain("page health: Page health: 2 console error(s).");
  });

  it("says nothing about stability when the check did not run", () => {
    expect(renderSummary(summary())).not.toContain("stability:");
  });

  it("reports the determinism check when --verify-stability ran", () => {
    const text = renderSummary(summary({ stability: { pagesCompared: 6, unstablePages: 0 } }));
    expect(text).toContain("stability: verified — 6/6 page(s) byte-identical on a repeat capture");
  });

  it("refuses to print a grade when a live run judged no route", () => {
    // The triage short-circuit shape: a live model WAS called, so the client
    // check passes it, and coverage is the only field that says it judged
    // nothing.
    const text = renderSummary(
      summary({
        result: {
          ...RESULT,
          grade: "ship",
          findings: [],
          notReviewed: ["/: triage answered that no deep review was needed, but this run carried no baseline"],
          coverage: {
            routesRequested: ["/", "/pricing"],
            routesReviewed: [],
            viewportsRequested: ["mobile", "desktop"],
            viewportsReviewed: [],
          },
        },
      }),
    );
    expect(text).toContain("grade       n/a (nothing was reviewed: 0 of 2 requested route(s) judged)");
    expect(text).toContain("findings    n/a (no route was judged)");
    expect(text).toContain("confidence  n/a (no route was judged)");
    // The stray grade must not reach the reader in any form.
    expect(text).not.toContain("grade       ship");
    // And the engine's reason is on screen, not only in the file.
    expect(text).toContain("Not reviewed");
    expect(text).toContain("- /: triage answered that no deep review was needed");
    expect(text).toContain("It is not a grade for this page.");
  });

  it("still prints the grade when a live run judged at least one route", () => {
    // The over-correction guard: a partial review is a real review, and its
    // grade was earned by the routes it did judge.
    const text = renderSummary(
      summary({
        result: {
          ...RESULT,
          notReviewed: ["route /pricing (no preview deployment matched the head SHA)"],
          coverage: {
            routesRequested: ["/", "/pricing"],
            routesReviewed: ["/"],
            viewportsRequested: ["mobile", "desktop"],
            viewportsReviewed: ["mobile", "desktop"],
          },
        },
      }),
    );
    expect(text).toContain("grade       needs_work");
    expect(text).not.toContain("nothing was reviewed");
    // The skipped route is still named.
    expect(text).toContain("Not reviewed");
    expect(text).toContain("- route /pricing (no preview deployment matched the head SHA)");
  });

  it("blames the offline client, not the coverage, when both would refuse the grade", () => {
    // A mock run over an empty capture trips both refusals. "No model saw this
    // page" is the stronger and more actionable of the two: coverage would be
    // empty even if a model HAD run, so reporting it instead would point the
    // reader at the capture when the client is the reason.
    const text = renderSummary(
      summary({
        modelKind: "mock",
        result: {
          ...RESULT,
          coverage: {
            routesRequested: ["/"],
            routesReviewed: [],
            viewportsRequested: ["mobile"],
            viewportsReviewed: [],
          },
        },
      }),
    );
    expect(text).toContain("grade       n/a (mock client, no model saw this page)");
    expect(text).not.toContain("nothing was reviewed");
  });

  it("refuses the grade when the route WAS reviewed and every finding was deleted", () => {
    // Coverage is full and truthful, so the nothing-was-reviewed branch above
    // cannot see this run. `grade` still floors to `ship` on the empty findings
    // list that deletion leaves behind, and printing that as a verdict is the
    // terminal telling a developer their page passed a review that established
    // nothing about it.
    const text = renderSummary(
      summary({
        modelFindingsSeen: 2,
        hallucinationDrops: 2,
        result: {
          ...RESULT,
          grade: "ship",
          findings: [],
          overall:
            "No finding in this review survived validation, so this run reports nothing about the page.",
          hallucinationDrops: 2,
          gradeUnavailableReason: "nothing_survived_validation",
          coverage: {
            routesRequested: ["/"],
            routesReviewed: ["/"],
            viewportsRequested: ["mobile"],
            viewportsReviewed: ["mobile"],
          },
        },
      }),
    );
    expect(text).toContain("grade       n/a (no finding survived validation: all 2 were deleted)");
    expect(text).toContain("findings    0 of 2 (2 for citing a route or element that was never captured)");
    expect(text).toContain("confidence  n/a (no finding survived to carry one)");
    expect(text).not.toContain("grade       ship");
    expect(text).toContain("It is not a grade for this page.");
  });

  it("names the trust budget when it, and not the grounding gate, did the deleting", () => {
    const text = renderSummary(
      summary({
        modelFindingsSeen: 3,
        hallucinationDrops: 0,
        result: {
          ...RESULT,
          grade: "ship",
          findings: [],
          hallucinationDrops: 0,
          gradeUnavailableReason: "nothing_survived_validation",
          coverage: {
            routesRequested: ["/"],
            routesReviewed: ["/"],
            viewportsRequested: ["mobile"],
            viewportsReviewed: ["mobile"],
          },
        },
      }),
    );
    expect(text).toContain("grade       n/a (no finding survived validation: all 3 were deleted)");
    expect(text).toContain("findings    0 of 3 (by the confidence floor and trust budget)");
  });

  it("refuses the grade when the engine measured the page and the model said nothing", () => {
    // The audit's run. Coverage is full, nothing was deleted, and `grade` floors
    // to `ship` exactly as it does for a genuinely clean page. What separates
    // them is that this run's own capture had something to say and its judge did
    // not, which is a statement about the judge.
    const text = renderSummary(
      summary({
        modelFindingsSeen: 0,
        hallucinationDrops: 0,
        result: {
          ...RESULT,
          grade: "ship",
          findings: [],
          hallucinationDrops: 0,
          gradeUnavailableReason: "measured_facts_unjudged",
          measurements: {
            checksRun: ["contrast", "overflow", "touch_target"],
            violations: [
              {
                kind: "contrast",
                route: "/",
                viewports: ["mobile"],
                element: "#hero-subtitle",
                detail: "text contrast 3.23:1 is below WCAG AA 4.5:1",
                blockEligible: true,
              },
              {
                kind: "overflow",
                route: "/",
                viewports: ["mobile"],
                element: "#promo-code",
                detail: "content width 345px exceeds container 140px (horizontal overflow)",
                blockEligible: true,
              },
              {
                kind: "touch_target",
                route: "/",
                viewports: ["mobile"],
                element: "#icon-close",
                detail: "touch target 28x28px is below 44x44px",
                blockEligible: false,
              },
            ],
          },
          coverage: {
            routesRequested: ["/"],
            routesReviewed: ["/"],
            viewportsRequested: ["mobile"],
            viewportsReviewed: ["mobile"],
          },
        },
      }),
    );
    expect(text).toContain(
      "grade       n/a (3 measured violation(s) on a reviewed route, and the review returned no findings)",
    );
    expect(text).toContain("findings    0 of 0 (the model produced none)");
    expect(text).not.toContain("grade       ship");
    expect(text).toContain("The page was captured and measured. Nothing judged it");
  });

  it("REGRESSION GUARD: a clean page and a partial deletion both keep their grade", () => {
    const full = {
      routesRequested: ["/"],
      routesReviewed: ["/"],
      viewportsRequested: ["mobile"] as const,
      viewportsReviewed: ["mobile"] as const,
    };
    // Nothing entered validation, nothing was deleted: an earned `ship`.
    const clean = renderSummary(
      summary({
        modelFindingsSeen: 0,
        hallucinationDrops: 0,
        result: {
          ...RESULT,
          grade: "ship",
          findings: [],
          hallucinationDrops: 0,
          coverage: {
            routesRequested: [...full.routesRequested],
            routesReviewed: [...full.routesReviewed],
            viewportsRequested: [...full.viewportsRequested],
            viewportsReviewed: [...full.viewportsReviewed],
          },
        },
      }),
    );
    expect(clean).toContain("grade       ship");
    expect(clean).not.toContain("survived validation");

    // One of three survived: a real verdict about a real page.
    const partial = renderSummary(
      summary({
        modelFindingsSeen: 3,
        hallucinationDrops: 2,
        result: {
          ...RESULT,
          hallucinationDrops: 2,
          coverage: {
            routesRequested: [...full.routesRequested],
            routesReviewed: [...full.routesReviewed],
            viewportsRequested: [...full.viewportsRequested],
            viewportsReviewed: [...full.viewportsReviewed],
          },
        },
      }),
    );
    expect(partial).toContain("grade       needs_work");
    expect(partial).not.toContain("survived validation");
  });

  it("leaves a producer that reports no coverage at all exactly where it was", () => {
    // Absent coverage means "this producer does not report it", never
    // "everything was reviewed" and never "nothing was".
    const text = renderSummary(summary());
    expect(text).toContain("grade       needs_work");
    expect(text).not.toContain("nothing was reviewed");
    expect(text).not.toContain("Not reviewed");
  });
});

describe("renderStability", () => {
  it("emits nothing when the check did not run", () => {
    expect(renderStability(null)).toEqual([]);
  });

  it("states the pass explicitly, so a clean check is visible", () => {
    expect(renderStability({ pagesCompared: 3, unstablePages: 0 })).toEqual([
      "  stability: verified — 3/3 page(s) byte-identical on a repeat capture",
    ]);
  });

  it("names the failure and what it means", () => {
    const lines = renderStability({ pagesCompared: 6, unstablePages: 2 });
    expect(lines[0]).toContain("FAILED — 2/6 page(s) differed on a repeat capture");
    expect(lines[1]).toContain("treat the findings as unstable");
  });
});
