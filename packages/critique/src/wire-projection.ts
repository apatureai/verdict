import { nothingReviewed, nothingSurvivedValidation } from "@apatureai/verdict-types";
import type {
  Critique,
  EngineReviewResult,
  Finding,
  GradeUnavailableReason,
  MeasurementReport,
  ReviewCoverage,
  WireFinding,
} from "@apatureai/verdict-types";

/**
 * Project the engine's internal `Critique` into the consumer-facing wire result
 * `EngineReviewResult` (TRD §2/§8). This IS the cross-repo contract boundary with
 * Gate: the async job API returns this shape, and it must stay byte-compatible
 * with `fixtures/gate-review-result.golden.json`. The internal `Finding` is the
 * rich form (dimension/confidence/introducedByThisPr). `introducedByThisPr` is
 * DROPPED here (internal-only), while `confidence` (since #150) and `dimension`
 * (since #159) pass through per finding: consumers like Bastion group outcomes
 * by the calibrated confidence + rubric dimension and must not fabricate either.
 * The wire form stays the projected, stable subset Gate renders.
 *
 * Pure. The screenshot-id and artifact-URL resolution are injected (the worker
 * binds them to the captured-image set + the object-store signed-URL base);
 * absent ⇒ no annotated screenshot for that finding.
 *
 * The model emits a dedicated `title` + `description` per finding (#100); the
 * projection passes them through. `deriveTitle` remains only as a DEFENSIVE
 * fallback for a finding whose title is empty/whitespace; it derives one from
 * the description so a malformed model row can never yield a blank wire title.
 */

const MAX_TITLE_LEN = 80;

/** Derive a concise title from a description (defensive fallback for a blank title). */
export function deriveTitle(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length === 0) return "Design finding";
  // First sentence, if it is short enough to read as a title.
  const sentenceEnd = trimmed.search(/[.!?](\s|$)/);
  const firstSentence = sentenceEnd >= 0 ? trimmed.slice(0, sentenceEnd) : trimmed;
  if (firstSentence.length <= MAX_TITLE_LEN) return firstSentence;
  // Otherwise cap at a word boundary under the limit and ellipsize.
  const capped = firstSentence.slice(0, MAX_TITLE_LEN);
  const lastSpace = capped.lastIndexOf(" ");
  return `${(lastSpace > 0 ? capped.slice(0, lastSpace) : capped).trimEnd()}…`;
}

/** Stable, 1-based finding id: f_001, f_002, … (order-deterministic). */
export function wireFindingId(index: number): string {
  return `f_${String(index + 1).padStart(3, "0")}`;
}

export interface WireProjectionOptions {
  /**
   * Resolve the annotated-screenshot id for a finding (route+viewport → the
   * captured shot), or null when none. Defaults to null for every finding.
   */
  screenshotIdFor?: (finding: Finding, index: number) => string | null;
  /** Build the public artifact URL for a screenshot id (object-store signed URL). */
  artifactUrlFor?: (screenshotId: string) => string;
  /** Engine debug URL for this run, omitted from the wire result when absent. */
  engineDebugUrl?: string;
  /**
   * Page-health footnote (#20): the rendered console-error/failed-request/
   * blocked-font note from `pageHealthFootnote(capture.pageHealth)`, or
   * null/undefined when the page was clean. Surfaced in `artifacts` and never
   * mixed into `findings`. Omitted from the wire result when absent, so a clean
   * page leaves the result byte-identical to before.
   */
  pageHealthFootnote?: string | null;
  /**
   * What the run actually looked at (#165). Supplied by the ORCHESTRATOR, which
   * is the only stage that knows which routes reached a judgment and which
   * viewports were captured for them; the projector is one stage earlier than
   * that knowledge and must never synthesize it from the critique (a critique
   * with zero findings says nothing about whether anything was reviewed, which
   * is the whole reason this field exists). Omitted from the wire result when
   * absent, so a producer that cannot answer honestly says nothing rather than
   * claiming full coverage.
   */
  coverage?: ReviewCoverage;
  /**
   * What the capture MEASURED: the deterministic contrast/overflow/touch-target
   * violations, grouped for the wire. Supplied by the caller that ran capture,
   * for the same reason `coverage` is: this projector is one stage away from the
   * DOM and must never synthesize a measurement, least of all an empty report,
   * which would publish "measured, nothing found" about a capture that measured
   * nothing at all.
   *
   * It is passed through VERBATIM. It does not participate in `findings`, in
   * `resultConfidence`, or in `nothingReviewedNarrative`. The single exception,
   * and the reason it is read here at all, is `gradeRetraction`: a judge handed
   * measured facts that returns nothing at all has not reviewed the page, and
   * that is a statement this projector is the right place to make. See
   * `gradeRetraction`.
   */
  measurements?: MeasurementReport;
  /** Screenshot retention seconds (tier retention policy, #51). */
  screenshotRetentionSeconds: number;
}

/** Project one internal finding to its wire form (internal-only fields dropped). */
function toWireFinding(
  finding: Finding,
  index: number,
  options: WireProjectionOptions,
  confidenceAvailable: boolean,
): WireFinding {
  const screenshotId = options.screenshotIdFor?.(finding, index) ?? null;
  return {
    id: wireFindingId(index),
    // #159: the validated internal rubric dimension crosses the wire verbatim,
    // never derived from severity/title. Consumers group outcomes by it.
    dimension: finding.dimension,
    severity: finding.severity,
    // Pass the model-emitted title through; fall back to a derived one only if blank.
    title: finding.title.trim().length > 0 ? finding.title : deriveTitle(finding.description),
    description: finding.description,
    route: finding.route,
    viewport: finding.viewport,
    element: finding.elementRef,
    screenshotId,
    suggestion: finding.suggestion,
    // Raw model confidence never crosses the wire. Emit only after report binding.
    ...(confidenceAvailable ? { confidence: finding.confidence } : {}),
  };
}

/**
 * Result-level confidence (#150): the minimum over calibrated finding
 * confidences. A clean result has no raw score to transform, so it has no
 * numeric confidence; the old synthetic `1` is deliberately retired by #160.
 */
function resultConfidence(findings: readonly Finding[]): number {
  if (findings.length === 0) throw new Error("cannot aggregate confidence without calibrated findings");
  return Math.min(...findings.map((finding) => finding.confidence));
}

/**
 * What a result says about itself when its coverage reports that no route
 * reached a judgment (#3).
 *
 * Three fields disagreed on that path. `coverage.routesReviewed` was empty,
 * `grade` was `ship` because a critique with no findings floors there, and
 * `overall` carried whatever prose the run had produced, which on the commonest
 * such path is the triage model's "Triage found no issues warranting a deep
 * review." Every consumer in this org checks coverage first and withholds both,
 * so the contradiction never reached a Check Run; it reached anyone who opened
 * `out/review.json`, which is a supported thing to do and the reason the file is
 * written at all.
 *
 * So the payload states it in the payload. `grade` cannot be nulled (see
 * `GradeUnavailableReason`), but the two prose fields can be made true, and the
 * model's own sentence is preserved rather than deleted, in the same field and
 * for the same reason as an ungrounded findings narrative.
 */
function nothingReviewedNarrative(critique: Critique, coverage: ReviewCoverage): {
  overall: string;
  ungroundedNarrative?: string;
} {
  const asked = coverage.routesRequested.length;
  const statement =
    `Nothing was reviewed: 0 of ${asked} requested route(s) reached a judgment in this run. ` +
    `The grade on this result is the value a review with no findings defaults to, not a verdict ` +
    `about this page.` +
    (critique.notReviewed.length > 0 ? " What was not reviewed, and why, is listed in notReviewed." : "");
  const prose = critique.overall.trim();
  // An existing `ungroundedNarrative` always wins: it was set because every
  // finding a narrative described was deleted, which is the more specific claim.
  if (critique.ungroundedNarrative !== undefined) {
    return { overall: statement, ungroundedNarrative: critique.ungroundedNarrative };
  }
  return prose.length === 0 ? { overall: statement } : { overall: statement, ungroundedNarrative: critique.overall };
}

/**
 * Whether this result's `grade` is a verdict about the page, and when it is not,
 * why (#3 and its follow-up).
 *
 * `grade` is a required closed enum and a result with no findings floors to
 * `ship`, so three very different runs publish the identical field:
 *
 *   1. a page a model looked at and found nothing wrong with. A real `ship`.
 *   2. a run where no route reached a judgment at all. `nothing_reviewed`,
 *      stated from OBSERVED coverage, so a caller that did not report coverage
 *      never has it asserted on its behalf.
 *   3. a run whose route WAS reviewed and whose every finding the validation
 *      tail then deleted. `nothing_survived_validation`.
 *
 * The third case is the one the coverage check cannot see, and it was published
 * as `grade: "ship"` with an `overall` reading "No finding in this review
 * survived validation, so this run reports nothing about the page". Coverage was
 * full because coverage reports what the pipeline looked at, and the pipeline
 * did look. Only the count of findings that ENTERED validation separates it from
 * case 1, which is why the critique carries `validation.modelFindingsSeen` and
 * why this is decided here rather than from the wire result's own fields.
 *
 * `nothing_reviewed` wins when both hold: it is the earlier and larger failure
 * (a run that judged no route had nothing to delete in the first place), and it
 * is the one every consumer already words for a reader.
 *
 * Case 1 gets nothing. A clean page's `ship` is earned, and retracting it would
 * be a worse bug than the one this closes: it would turn every genuinely passing
 * review into a run that says it assessed nothing. A PARTIAL deletion gets
 * nothing either: findings survived, so the review reached a real verdict about
 * the page, and its caveat belongs in `overall` where `reconcileNarrative` puts
 * it.
 */
function gradeRetraction(
  critique: Critique,
  coverage: ReviewCoverage | undefined,
  measurements: MeasurementReport | undefined,
): GradeUnavailableReason | undefined {
  if (coverage && nothingReviewed(coverage)) return "nothing_reviewed";
  if (nothingSurvivedValidation(critique)) return "nothing_survived_validation";
  if (measuredFactsUnjudged(critique, coverage, measurements)) return "measured_facts_unjudged";
  return undefined;
}

/**
 * Case 4, and the only one that is a statement about the JUDGE rather than
 * about the pipeline: this run reviewed a route, the engine measured at least
 * one violation on a route it reviewed, and the model returned nothing at all.
 *
 * The deep prompt hands these measurements to the model as facts and tells it to
 * trust them. A judge given "text contrast 3.23:1 is below WCAG AA 4.5:1" about
 * a page it is looking at, which then produces zero findings and puts zero
 * findings into validation, has not reviewed that page. The `ship` an empty
 * findings list floors to is not something it established, and that is what this
 * retracts.
 *
 * Four conditions, and each one is load-bearing:
 *
 *   (a) coverage is present and non-empty. Without coverage the engine does not
 *       know what was reviewed and will not assert it on a caller's behalf; with
 *       empty coverage `nothing_reviewed` is the earlier and larger failure and
 *       has already won above.
 *   (b) no finding survived.
 *   (c) NO finding entered validation. Stated explicitly rather than left to
 *       fall out of the precedence above, so "a deleted finding yields
 *       `nothing_survived_validation`, never this" is a property a test can pin.
 *       One finding anywhere on the page, surviving or deleted, means the judge
 *       spoke and this reason does not apply.
 *   (d) a measurement sits on a route this run actually reviewed. A violation on
 *       a route nobody judged says nothing about the judge.
 *
 * Three things are deliberately NOT in it:
 *
 *   - `blockEligible`. The claim is "nothing judged this", not "your page is
 *     defective", so it stays true even when the measured overflow turns out to
 *     be a deliberate scroll container. That is what lets this ship ahead of the
 *     capture-precision work rather than behind it.
 *   - Matching a measured selector against a finding's `elementRef`. It would
 *     retract an EARNED `ship` whenever a competent model correctly declines to
 *     flag an intentional design choice on a measured element, and it would
 *     couple every graded run in the fleet to the stability of one selector
 *     function. Total silence is the signal; a single finding suppresses it.
 *   - `provenance.model_backed`. It is attached later, by wrapping an
 *     already-projected result, so it is not available here. It is also
 *     unnecessary: a run nothing judged is already grade-suppressed by a
 *     stronger rule downstream.
 *
 * NOT CONFIGURABLE, on either side. No repo config and no engine flag may
 * silence it, because a switch that turns off the one signal an injected page
 * cannot reach is itself a second injection channel.
 *
 * EXPORTED so its conditions can be pinned INDEPENDENTLY of where it sits in
 * `gradeRetraction`'s precedence chain. Condition (c) is redundant while
 * `nothing_survived_validation` is evaluated first, and a test that only went
 * through `toEngineReviewResult` would pass with (c) deleted. Precedence is
 * supposed to be a property of the ORDER, not the only thing holding the
 * predicate together: a later reordering must not be able to change what this
 * function means.
 */
export function measuredFactsUnjudged(
  critique: Critique,
  coverage: ReviewCoverage | undefined,
  measurements: MeasurementReport | undefined,
): boolean {
  if (!coverage || coverage.routesReviewed.length === 0) return false;
  if (critique.findings.length > 0) return false;
  if (critique.validation.modelFindingsSeen !== 0) return false;
  if (!measurements) return false;
  const reviewed = new Set(coverage.routesReviewed);
  return measurements.violations.some((violation) => reviewed.has(violation.route));
}

/**
 * What a result says about itself when the judge was handed measured facts and
 * answered with nothing at all.
 *
 * Same shape as `nothingReviewedNarrative` and for the same reason: `grade`
 * cannot be nulled, so the two prose fields carry the truth instead, and the
 * model's own sentence is preserved rather than deleted so an operator can see
 * what the judge claimed. An existing `ungroundedNarrative` still wins, though
 * on this path there cannot be one: it is set only when findings were deleted,
 * and this reason requires that none were ever produced.
 */
function measuredFactsUnjudgedNarrative(
  critique: Critique,
  coverage: ReviewCoverage,
  measurements: MeasurementReport,
): { overall: string; ungroundedNarrative?: string } {
  const reviewed = new Set(coverage.routesReviewed);
  const onReviewed = measurements.violations.filter((v) => reviewed.has(v.route));
  const statement =
    `${onReviewed.length} measurement(s) taken from this capture do not meet threshold on the ` +
    `route(s) this run reviewed, and the review returned no findings at all. The grade on this ` +
    `result is the value an empty findings list defaults to, not a verdict about this page. What ` +
    `was measured is listed under \`measurements\`.`;
  const prose = critique.overall.trim();
  if (critique.ungroundedNarrative !== undefined) {
    return { overall: statement, ungroundedNarrative: critique.ungroundedNarrative };
  }
  return prose.length === 0
    ? { overall: statement }
    : { overall: statement, ungroundedNarrative: critique.overall };
}

/** Project the internal critique into the cross-repo wire result Gate consumes. */
export function toEngineReviewResult(critique: Critique, options: WireProjectionOptions): EngineReviewResult {
  const confidenceAvailable = critique.calibration !== undefined && critique.findings.length > 0;
  const retraction = gradeRetraction(critique, options.coverage, options.measurements);
  const unreviewed =
    options.coverage && nothingReviewed(options.coverage)
      ? nothingReviewedNarrative(critique, options.coverage)
      : retraction === "measured_facts_unjudged" && options.coverage && options.measurements
        ? measuredFactsUnjudgedNarrative(critique, options.coverage, options.measurements)
        : null;
  const findings = critique.findings.map((f, i) => toWireFinding(f, i, options, confidenceAvailable));

  const annotatedScreenshots = findings
    .filter((f): f is WireFinding & { screenshotId: string } => f.screenshotId !== null)
    .map((f) => ({
      findingId: f.id,
      url: options.artifactUrlFor ? options.artifactUrlFor(f.screenshotId) : f.screenshotId,
    }));

  return {
    grade: critique.grade,
    overall: unreviewed ? unreviewed.overall : critique.overall,
    ...(confidenceAvailable ? { confidence: resultConfidence(critique.findings) } : {}),
    ...(critique.calibration ? { calibration: critique.calibration } : {}),
    blockingEnabled: critique.blockingEnabled === true,
    ...(critique.calibration === undefined
      ? { confidenceUnavailableReason: critique.confidenceUnavailableReason ?? "missing_calibration_report" }
      : {}),
    findings,
    notReviewed: critique.notReviewed,
    artifacts: {
      annotatedScreenshots,
      // engineDebugUrl is optional on the wire, so only set it when present.
      ...(options.engineDebugUrl !== undefined ? { engineDebugUrl: options.engineDebugUrl } : {}),
      // Page-health footnote (#20), only when capture reported something; a
      // clean page omits the field so the wire result stays byte-compatible.
      ...(options.pageHealthFootnote ? { pageHealthFootnote: options.pageHealthFootnote } : {}),
    },
    screenshotRetentionSeconds: options.screenshotRetentionSeconds,
    metadata: critique.metadata,
    // The grounding gate's drop count (#32) crosses the wire verbatim. It used
    // to stop here: the count was computed, logged, counted into an SLO and then
    // dropped at this projection, so a consumer holding the result could not tell
    // a clean page from three findings that could not be pointed at. Emitted even
    // when zero, because zero is the answer to the same question.
    hallucinationDrops: critique.validation.hallucinationDrops,
    // The model's prose, on a result where it is not a description of the page:
    // either every finding it was written about was deleted, or nothing was
    // reviewed at all. `overall` above carries the engine's statement in both
    // cases, so this is where the prose a reader may still want to see is kept.
    ...(unreviewed
      ? unreviewed.ungroundedNarrative !== undefined
        ? { ungroundedNarrative: unreviewed.ungroundedNarrative }
        : {}
      : critique.ungroundedNarrative !== undefined
        ? { ungroundedNarrative: critique.ungroundedNarrative }
        : {}),
    // Coverage (#165): emitted verbatim from what the orchestrator observed,
    // omitted entirely when the caller did not state it.
    ...(options.coverage ? { coverage: options.coverage } : {}),
    // The measured half, verbatim. Omitted entirely when the caller did not
    // measure, because an empty report is the positive claim "these checks ran
    // and found nothing" and this projector is not entitled to make it. Never
    // read by the grade; the one place it is read is `gradeRetraction`.
    ...(options.measurements ? { measurements: options.measurements } : {}),
    // The grade's retraction, for the raw artifact (#3). `grade` is a required
    // closed enum, so a run that assessed nothing still carries `ship`; this says
    // in band that it is not a verdict. See `gradeRetraction` for which runs
    // qualify and, just as load-bearing, which do not.
    ...(retraction ? { gradeUnavailableReason: retraction } : {}),
  };
}
