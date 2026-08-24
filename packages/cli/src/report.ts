import { toMeasurementReport, type DeterministicFinding, type StabilityCheck } from "@apatureai/verdict-capture";
import { nothingReviewed, type EngineReviewResult } from "@apatureai/verdict-types";
import type { LocalGrounding } from "./grounding.js";

/**
 * Terminal rendering. Pure functions over already-computed results so the exact
 * output a reader sees is unit-tested, not assembled ad hoc at the call site.
 *
 * The one rule this file exists to enforce: a run that no model looked at never
 * prints a grade. The canned and mock clients produce a `grade` field like any
 * other run, and printing it as-is told readers their page had been reviewed
 * when nothing had reviewed it. So the report is keyed on which client ran. The
 * measured facts, which are real in every mode, get the numbered list; replayed
 * fixture text is labelled as fixture text and never counted as findings.
 *
 * The client is not the whole question, though. A LIVE run can call a model and
 * still judge no page: a triage pass that declines a deep review with no
 * baseline to decline it against ends with a real model call, a `grade` of
 * `ship` and zero routes judged. `modelKind` cannot see that; `coverage` can.
 * So the same refusal is keyed on coverage as well, and the reasons the engine
 * recorded in `notReviewed` are printed rather than left in the JSON.
 */

/** Which client produced the critique. Only `live` means a model saw the page. */
export type ReportModelKind = "live" | "canned" | "mock";

export interface RunSummary {
  target: string;
  targetNote: string;
  routes: string[];
  viewports: string[];
  modelKind: ReportModelKind;
  modelDescription: string;
  captureVersion: string;
  screenshotCount: number;
  screenshotDir: string;
  geometryCount: number;
  /** Whether the repository's own design system reached the model. */
  grounding: LocalGrounding;
  deterministicFindings: DeterministicFinding[];
  /** Where the full measured-fact list was written, for the "and N more" pointer. */
  factsFile: string | null;
  pageHealthFootnote: string | null;
  /** Repeat-capture determinism check, or null when --verify-stability was off. */
  stability: StabilityCheck | null;
  hallucinationDrops: number;
  modelFindingsSeen: number;
  result: EngineReviewResult;
  files: string[];
  elapsedMs: number;
}

/** Measured facts printed inline before the list is cut short. */
export const MAX_FACT_LINES = 12;

function pad(label: string, width = 12): string {
  return label.padEnd(width, " ");
}

/** True when no model saw the page, so nothing in the critique is a judgment. */
export function isSynthetic(kind: ReportModelKind): boolean {
  return kind !== "live";
}

/**
 * Show a path relative to the working directory when that is shorter and does
 * not escape upward; otherwise show it absolute. A screenful of `../../..` is
 * worse than an absolute path.
 */
export function displayPath(absolute: string, relativeToCwd: string): string {
  return relativeToCwd.startsWith("..") ? absolute : relativeToCwd;
}

/** Count deterministic findings by check kind, in a stable order. */
export function countByKind(findings: DeterministicFinding[]): Array<[string, number]> {
  const order = ["contrast", "overflow", "touch_target"];
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  return order.filter((kind) => counts.has(kind)).map((kind) => [kind, counts.get(kind) as number]);
}

/** One measured defect, with every viewport it was measured at. */
export interface FactGroup {
  kind: string;
  route: string;
  selector: string;
  detail: string;
  viewports: string[];
}

/**
 * Collapse the per-viewport measurements into one entry per (check, route,
 * element, detail). The same 3.23:1 contrast measured at three viewports is one
 * defect a reader has to fix once, so printing it three times buys nothing; the
 * viewport list is kept because "mobile only" and "everywhere" are different
 * problems. Order is first encounter, which keeps routes together.
 */
export function groupFacts(findings: DeterministicFinding[]): FactGroup[] {
  // Delegated, not reimplemented. The identical grouping now also builds the
  // `measurements` block on the wire result, and a terminal that phrased a
  // measurement differently from the payload beside it would be the same
  // two-surfaces-disagree bug the coverage work closed. One rule, one place.
  return toMeasurementReport(findings).violations.map((violation) => ({
    kind: violation.kind,
    route: violation.route,
    selector: violation.element,
    detail: violation.detail,
    viewports: [...violation.viewports],
  }));
}

/**
 * The measured facts, as the report's numbered list. These are computed from the
 * captured DOM by `@apatureai/verdict-capture`, so they are true in every model mode and
 * are the whole of what an offline run legitimately tells you about a page.
 */
export function renderFacts(summary: RunSummary): string[] {
  const total = summary.deterministicFindings.length;
  if (total === 0) {
    return [
      "Measured facts  (computed from the captured DOM, no model involved)",
      "  none: no contrast, overflow or touch-target violation was measured",
    ];
  }

  const kinds = countByKind(summary.deterministicFindings);
  const kindNote = kinds.map(([kind, n]) => `${kind} ${n}`).join(", ");
  const groups = groupFacts(summary.deterministicFindings);
  const shown = groups.slice(0, MAX_FACT_LINES);

  const lines = [
    "Measured facts  (computed from the captured DOM, no model involved)",
    `  ${total} measurement(s) (${kindNote}) over ${groups.length} distinct element(s)`,
    "",
    ...shown.map(
      (group, index) =>
        `  ${String(index + 1).padStart(2, " ")}. [${group.kind}] ${group.route} ${group.selector} ` +
        `(${group.viewports.join(", ")})\n      ${group.detail}`,
    ),
  ];
  if (groups.length > shown.length) {
    lines.push(`      …and ${groups.length - shown.length} more`);
  }
  if (summary.factsFile !== null) {
    lines.push(`  every measurement: ${summary.factsFile}`);
  }
  return lines;
}

/**
 * The design-system grounding block.
 *
 * The claim this tool is built on is that it critiques a UI against the
 * repository's own design system, so a run has to show whether it did. A
 * grounded run names the version, the rule count and the ranking function,
 * because two embedders retrieve different rules from one genome. An ungrounded
 * run prints the same sentence the result carries in `notReviewed`, so the
 * terminal and the file cannot disagree.
 */
export function renderGrounding(grounding: LocalGrounding): string[] {
  if (!grounding.grounded) {
    return ["Design-system grounding", `  none (${grounding.reason})`, `  ${grounding.disclosure}`];
  }
  return [
    "Design-system grounding",
    `  ${pad("ui-dna")}${grounding.uiDnaVersion}  (${grounding.ruleCount} rule(s) from ${grounding.source})`,
    `  ${pad("retrieval")}top rules per route, ranked by ${grounding.embedder}`,
    `  ${pad("authority")}not checked: no authority service is reachable from a local run, so this`,
    "              result is advisory and cannot block",
  ];
}

/**
 * The determinism check's own line. A check that ran and found nothing still
 * says so; otherwise `--verify-stability` is indistinguishable from a run that
 * never made the comparison.
 */
export function renderStability(stability: StabilityCheck | null): string[] {
  if (stability === null) return [];
  const { pagesCompared, unstablePages } = stability;
  const stable = pagesCompared - unstablePages;
  return unstablePages === 0
    ? [`  stability: verified — ${stable}/${pagesCompared} page(s) byte-identical on a repeat capture`]
    : [
        `  stability: FAILED — ${unstablePages}/${pagesCompared} page(s) differed on a repeat capture;`,
        "             something is still moving, so treat the findings as unstable",
      ];
}

function findingLines(result: EngineReviewResult, bullet: (index: number) => string): string[] {
  return result.findings.map(
    (finding, index) =>
      `  ${bullet(index)} [${finding.severity}/${finding.dimension}] ${finding.title}\n` +
      `      ${finding.route} ${finding.viewport} → ${finding.element ?? "(no element)"}`,
  );
}

/** One line per surviving model finding. Live runs only. */
export function renderFindings(result: EngineReviewResult): string[] {
  if (result.findings.length === 0) return ["  (none)"];
  return findingLines(result, (index) => `${String(index + 1).padStart(2, " ")}.`);
}

/**
 * The replayed critique of an offline run. Never numbered and never called a
 * finding: this text was authored in a fixture before the page existed, and the
 * only thing it proves is that the pipeline carried it end to end.
 */
export function renderFixtureCritique(summary: RunSummary): string[] {
  const client = summary.modelKind === "mock" ? "mock" : "canned";
  if (summary.result.findings.length === 0) {
    return [
      `  The ${client} client produced no critique text. Nothing above judged this page;`,
      "  the measured facts are this run's only real output.",
    ];
  }
  return [
    `  FIXTURE TEXT: replayed from the ${client} client, not a judgment about this page.`,
    "  It was authored before this page was captured; it survived the grounding gate",
    "  only because this page happens to contain the elements it names.",
    "",
    // Padded to the width of the numbered form so the second line still aligns.
    ...findingLines(summary.result, () => "  -"),
  ];
}

/**
 * The reasons the engine recorded for work it did not do, printed verbatim.
 * They are written for a human to act on, and the terminal is where a human is.
 */
export function renderNotReviewed(result: EngineReviewResult): string[] {
  if (result.notReviewed.length === 0) return [];
  return ["Not reviewed", ...result.notReviewed.map((line) => `  - ${line}`)];
}

/** The `Review` block: the grade, or the reason there cannot be one. */
export function renderReview(summary: RunSummary): string[] {
  const { result } = summary;
  const { coverage } = result;
  // A live model ran and judged no route. The `grade` in the file is the value
  // a critique over zero routes defaults to, not a verdict about this page, and
  // printing it as one is exactly how a triage short-circuit read as a green
  // light. Coverage is optional on the wire, so this fires only when a producer
  // actually stated it; absent means "this producer does not report coverage",
  // never "everything was reviewed".
  if (!isSynthetic(summary.modelKind) && coverage && nothingReviewed(coverage)) {
    const asked = coverage.routesRequested.length;
    return [
      "Review",
      `  ${pad("grade")}n/a (nothing was reviewed: 0 of ${asked} requested route(s) judged)`,
      `  ${pad("findings")}n/a (no route was judged)`,
      `  ${pad("confidence")}n/a (no route was judged)`,
      `  ${pad("blocking")}${result.blockingEnabled ? "enabled" : "advisory only"}`,
      "",
      ...(result.notReviewed.length > 0 ? [...renderNotReviewed(result), ""] : []),
      "  review.json carries a grade field for this run. It is not a grade for this page.",
    ];
  }
  // A live model ran, the route WAS judged, and the validation tail then deleted
  // every finding it produced. Coverage is full and truthful here, so the branch
  // above cannot see this run, and `grade` floors to `ship` on an empty findings
  // list exactly as it does for a page nobody found anything wrong with. The
  // difference is `modelFindingsSeen`: findings entered validation and none came
  // out, so this run established nothing about the page and does not print a
  // grade for it. The payload says the same in `gradeUnavailableReason`.
  if (
    !isSynthetic(summary.modelKind) &&
    result.gradeUnavailableReason === "nothing_survived_validation"
  ) {
    const seen = summary.modelFindingsSeen;
    const drops = summary.hallucinationDrops;
    const attributed =
      drops > 0
        ? `${drops} for citing a route or element that was never captured` +
          (seen > drops ? `, ${seen - drops} by the confidence floor and trust budget` : "")
        : "by the confidence floor and trust budget";
    return [
      "Review",
      `  ${pad("grade")}n/a (no finding survived validation: all ${seen} were deleted)`,
      `  ${pad("findings")}0 of ${seen} (${attributed})`,
      `  ${pad("confidence")}n/a (no finding survived to carry one)`,
      `  ${pad("blocking")}${result.blockingEnabled ? "enabled" : "advisory only"}`,
      "",
      ...(result.notReviewed.length > 0 ? [...renderNotReviewed(result), ""] : []),
      "  The page was reviewed; nothing this run said about it could be grounded or trusted.",
      "  review.json carries a grade field for this run. It is not a grade for this page.",
    ];
  }
  // A live model ran, the route WAS judged, the engine measured violations on
  // it and handed them to the model as facts, and the model returned nothing at
  // all. Coverage is full, nothing was deleted, and `grade` floors to `ship`
  // exactly as it does for a genuinely clean page. The difference is that this
  // run's own capture had something to say about the page and its judge did not,
  // which is a statement about the judge. The payload says the same in
  // `gradeUnavailableReason`.
  if (
    !isSynthetic(summary.modelKind) &&
    result.gradeUnavailableReason === "measured_facts_unjudged"
  ) {
    const reviewed = new Set(coverage?.routesReviewed ?? []);
    const measured = (result.measurements?.violations ?? []).filter((violation) =>
      reviewed.has(violation.route),
    ).length;
    return [
      "Review",
      `  ${pad("grade")}n/a (${measured} measured violation(s) on a reviewed route, and the review returned no findings)`,
      `  ${pad("findings")}0 of 0 (the model produced none)`,
      `  ${pad("confidence")}n/a (no finding survived to carry one)`,
      `  ${pad("blocking")}${result.blockingEnabled ? "enabled" : "advisory only"}`,
      "",
      ...(result.notReviewed.length > 0 ? [...renderNotReviewed(result), ""] : []),
      "  The page was captured and measured. Nothing judged it, whatever the grade field says.",
      "  review.json carries a grade field for this run. It is not a grade for this page.",
    ];
  }
  if (isSynthetic(summary.modelKind)) {
    const client = summary.modelKind === "mock" ? "mock" : "canned";
    return [
      "Review",
      `  ${pad("grade")}n/a (${client} client, no model saw this page)`,
      `  ${pad("findings")}n/a (no model ran; see the measured facts above)`,
      `  ${pad("confidence")}n/a (no model ran)`,
      `  ${pad("blocking")}${result.blockingEnabled ? "enabled" : "advisory only"}`,
      "",
      ...renderFixtureCritique(summary),
    ];
  }
  return [
    "Review",
    `  ${pad("grade")}${result.grade}`,
    `  ${pad("findings")}${result.findings.length}`,
    `  ${pad("confidence")}${
      result.confidence !== undefined
        ? String(result.confidence)
        : `withheld (${result.confidenceUnavailableReason ?? "no promoted calibration report"})`
    }`,
    `  ${pad("blocking")}${result.blockingEnabled ? "enabled" : "advisory only"}`,
    "",
    ...renderFindings(result),
    // A partial review is still a real review, and the routes it skipped are a
    // fact about it. They were already in review.json and nowhere on screen.
    ...(result.notReviewed.length > 0 ? ["", ...renderNotReviewed(result)] : []),
  ];
}

/** The full report a run prints on success. */
export function renderSummary(summary: RunSummary): string {
  const synthetic = isSynthetic(summary.modelKind);
  const parsedFrom = synthetic ? "replayed finding(s) parsed" : "model finding(s) parsed";

  const lines: string[] = [
    "",
    "Target",
    `  ${pad("url")}${summary.target}${summary.targetNote ? `  ${summary.targetNote}` : ""}`,
    `  ${pad("routes")}${summary.routes.join(", ")}`,
    `  ${pad("viewports")}${summary.viewports.join(", ")}`,
    `  ${pad("model")}${summary.modelDescription}`,
    `  ${pad("capture")}${summary.captureVersion}`,
    "",
    "Capture",
    `  ${summary.screenshotCount} screenshot(s) written to ${summary.screenshotDir}`,
    `  ${summary.geometryCount} DOM element(s) recorded in the geometry map`,
    `  page health: ${summary.pageHealthFootnote ?? "clean"}`,
    ...renderStability(summary.stability),
    "",
    ...renderFacts(summary),
    "",
    ...renderGrounding(summary.grounding),
    "",
    "Grounding gate",
    `  ${summary.modelFindingsSeen} ${parsedFrom}, ${summary.hallucinationDrops} dropped for citing a route or element that was never captured`,
    "",
    ...renderReview(summary),
    "",
    "Wrote",
    ...summary.files.map((file) => `  ${file}`),
    // Both offline clients emit a grade into review.json; neither one earned it. Name the client
    // that produced it, because "the fixture's" is only true of the canned replay.
    ...(synthetic
      ? [
          `  note: review.json carries the ${
            summary.modelKind === "mock" ? "mock client's" : "fixture's"
          } own grade field. It is not a grade for this page.`,
          // The file outlives this terminal, so the file says it too.
          "        its provenance block says the same in band: model_backed is false.",
        ]
      : []),
    "",
    `Done in ${(summary.elapsedMs / 1000).toFixed(1)}s.`,
  ];
  return lines.join("\n");
}
