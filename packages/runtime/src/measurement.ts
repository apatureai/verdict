import {
  breakageForRoute,
  factsForRoute,
  toMeasurementReport,
  checksRunFor,
  type DeterministicFinding,
} from "@apatureai/verdict-capture";
import type { ReviewInput, ReviewRoute } from "@apatureai/verdict-review";
import type { Capture, CaptureContext, MeasurementReport } from "@apatureai/verdict-types";

/**
 * The measured half of a review, on the deployable path.
 *
 * `@apatureai/verdict-capture` measures contrast, overflow and touch targets while it
 * captures, and the orchestrator threads those measurements into two different
 * places: `facts` grounds the deep prompt, and `deterministicBreakage` overrules
 * a triage pass that declined to look. The CLI and the local HTTP server both
 * populate them, because both capture in-process and can read the measurements
 * straight off the capture result.
 *
 * The service composition cannot: it captures through `CAPTURE_ENDPOINT`, so the
 * only measurements it can ever have are the ones the capture service sends
 * back. Until now the wire contract had no field for them. `captureSchema` in
 * `adapters.ts` was `.strict()` over images, geometry, page health and the
 * capture version, so a capture service that measured a page and reported it was
 * REJECTED, and `toReviewInput` built every route as a bare `{ route }`. The
 * deployed engine therefore ran every deep prompt with no measured facts and
 * every triage pass with nothing that could overrule it, which is the opposite
 * of what the orchestrator's own documentation says both shipped surfaces do.
 *
 * These two pieces close that: `MeasuredCapture` is the capture-response shape
 * that carries the measurements, and `measuredRoutes` turns them into the
 * per-route inputs using the SAME `factsForRoute` / `breakageForRoute` helpers
 * the CLI uses, so the two paths cannot phrase a measurement differently.
 *
 * What this does NOT do, deliberately: measure anything itself. The checks in
 * `@apatureai/verdict-capture` run over computed styles and scroll widths read out of a live
 * DOM, and this process has no DOM: it has a capture service's answer. So a
 * capture service that sends no measurements produces a review with no measured
 * facts, and `measurementGap` says exactly that instead of leaving the absence
 * to look like a clean page.
 */

/**
 * A capture response that also carries what the capture service measured.
 *
 * Both fields are optional because the engine and the capture fleet deploy
 * separately: a fleet that predates this contract sends neither, and the review
 * still runs. Optional means UNKNOWN, never "measured nothing" -- an empty
 * `deterministicFindings` array is the positive statement that the checks ran
 * and found no violation, and absence is the statement that nothing was
 * measured at all. `measurementGap` is what keeps those two apart.
 */
export interface MeasuredCapture extends Capture {
  /** Contrast / overflow / touch-target measurements, per (route, viewport). */
  deterministicFindings?: DeterministicFinding[];
  /** Visible page text per route. UNTRUSTED; fenced by the deep pass. */
  pageText?: Record<string, string>;
}

/**
 * The capture seam as this runtime binds it: a capture plus its measurements.
 * Assignable to `CaptureInSandbox` wherever the orchestrator wants that, since
 * every added field is optional and `MeasuredCapture` extends `Capture`.
 */
export type MeasuredCaptureInSandbox = (url: string, ctx: CaptureContext) => Promise<MeasuredCapture>;

/**
 * Build the per-route orchestrator inputs from a capture's own measurements.
 *
 * Deliberately identical in shape and in source to what `runLocalReview` builds:
 * same helpers, same "omit the key when there is nothing to say" rule, so a
 * route with no measured violation is byte-identical to the bare `{ route }`
 * this used to produce and nothing downstream can tell which surface built it.
 *
 * `baselinePhash` and `tileScores` stay absent here for the same reason they are
 * absent on the local path: they describe this capture against a previous one,
 * and no baseline store exists to hold a previous one. Nothing is invented.
 */
export function measuredRoutes(routes: readonly string[], capture: MeasuredCapture): ReviewRoute[] {
  const findings = capture.deterministicFindings ?? [];
  const pageText = capture.pageText ?? {};
  return routes.map((route) => {
    const facts = factsForRoute(findings, route);
    const breakage = breakageForRoute(findings, route);
    const text = pageText[route];
    return {
      route,
      ...(facts.length > 0 ? { facts } : {}),
      ...(breakage.length > 0 ? { deterministicBreakage: breakage } : {}),
      ...(text ? { pageText: text } : {}),
    };
  });
}

/**
 * The capture's measurements as the wire reports them, or `undefined` when the
 * capture service sent none.
 *
 * `undefined` is the whole point and is not the same as an empty report. This
 * process has no DOM: it holds a capture service's answer, and a service that
 * measured nothing at all is not a page that measured clean. Synthesizing
 * `{ checksRun: [...], violations: [] }` from a fleet that never ran a check
 * would publish "measured, nothing found" to Gate and to an agent, which is the
 * exact false claim `measurementGap` exists to prevent one layer up.
 *
 * `checksRun` is left at the module default, which is every check
 * `deterministicChecks` runs: a fleet that reports measurements at all runs the
 * whole set, and the capture contract has no field for a subset. If one ever
 * gains one, this is the line that carries it.
 */
export function measurementReportFor(capture: MeasuredCapture): MeasurementReport | undefined {
  if (capture.deterministicFindings === undefined) return undefined;
  return toMeasurementReport(
    capture.deterministicFindings,
    checksRunFor([...new Set(capture.images.map((image) => image.viewport))]),
  );
}

/**
 * Why this run has no measurements to ground itself on, or `null` when the
 * capture service reported some -- including when it reported that it measured
 * and found nothing.
 *
 * Returned as a sentence rather than a boolean because the only useful thing to
 * do with it is say it: the operator reading it has to know that the deep prompt
 * ran unfacted and that triage could not be overruled, and that this is a
 * property of the capture service, not of the page.
 */
export function measurementGap(capture: MeasuredCapture): string | null {
  if (capture.deterministicFindings !== undefined) return null;
  return (
    "the capture service returned no deterministic measurements, so this review carried no measured " +
    "facts into the deep prompt and no measured breakage into triage; the contrast, overflow and " +
    "touch-target checks are computed during capture and cannot be recomputed here"
  );
}

/**
 * Why this run asked for the determinism check and got no answer, or `null`
 * when it either did not ask or was answered.
 *
 * The check is per-request now (`captureContext.verifyStability`), and the
 * capture fleet deploys separately from this engine, so "the caller asked and
 * the service does not implement it" is a real state a review must not report
 * as a passing check. It cannot be inferred from `pageHealth.unstable`: that
 * flag is `false` both when nothing moved and when nothing looked.
 *
 * Said as a sentence, like `measurementGap`, because the only useful thing to
 * do with it is say it, and the operator's next question is which side to fix.
 */
export function stabilityGap(context: CaptureContext, capture: Capture): string | null {
  if (context.verifyStability !== true) return null;
  if (capture.pageHealth.stability !== undefined) return null;
  return (
    "this review asked the capture service for the repeat-capture determinism check and the response " +
    "carried no stability counts, so nothing was verified: read pageHealth.unstable as 'nothing " +
    "contradicted this capture' rather than 'every page was compared and matched'"
  );
}

/**
 * Put the capture's measurements on the input the orchestrator is about to run.
 *
 * Mutates, because `createReviewProcessor` hands the same `ReviewInput` object
 * to `runReview` that it handed this composition, and because the composition
 * root already resolves the other capture-time-unknowable field the same way
 * (`input.context.uiDnaVersion`). The routes are rebuilt from
 * `captureContext.routes`, which is the post-cap list capture was actually asked
 * for, so the truncated tail stays out of the review exactly as before.
 */
export function applyMeasuredRoutes(input: ReviewInput, capture: MeasuredCapture): void {
  input.routes = measuredRoutes(input.captureContext.routes, capture);
  // The same measurements, on the other end of the review: the routes carry them
  // into the prompt, this carries them onto the result a consumer reads. Both
  // come from the one `deterministicFindings` array, so the fact a model was
  // shown and the fact Gate renders cannot be phrased differently. Assigned only
  // when the fleet sent measurements at all, so a silent fleet stays silent.
  const report = measurementReportFor(capture);
  if (report) input.measurements = report;
}
