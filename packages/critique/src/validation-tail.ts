import type { CalibrationRuntimeBinding, Finding, Grade } from "@apatureai/verdict-types";
import {
  applyCalibrationBinding,
  calibrationBindingMatches,
  enforceBlockingThreshold,
  type CalibrationRuntimeIdentity,
} from "./calibration-binding.js";
import { applyConfidenceCeiling } from "./confidence-ceiling.js";
import { reconcileGrade } from "./grade.js";
import { hallucinationGate, type CapturedShot } from "./hallucination-gate.js";
import { postFilter } from "./post-filter.js";

/**
 * The global validation tail (#32/#70/#33/#106): the ONE sequence that turns raw
 * model findings + a model grade into the gated, calibrated, filtered result the
 * wire carries. Both entry points run it identically: `critique()` over its single
 * pass, and `assembleCritique()` over the merged multi-route findings. It lived
 * duplicated in both (assemble's comment even read "order matches critique()"),
 * which is exactly how a fix could land in one copy and not the other. Centralized
 * here so the gate decision has a single source of truth.
 *
 * Order (load-bearing): hallucination gate → calibrate → confidence ceiling (when
 * the capture was unstable) → trust-budget post-filter → blocking-threshold
 * enforcement → grade reconciliation → the advisory blocked-floor. Calibration is
 * applied only when its binding matches the runtime identity; otherwise the result
 * stays advisory (raw scores, no ranking). Pure and deterministic.
 *
 * The gate now returns TWO buckets (W1-03): element-grounded findings, which flow
 * through the whole tail and drive the grade, and `ungrounded` findings (a real
 * shot but a null `elementRef`), which are calibrated and trust-budgeted the same
 * way but are held OUT of grade reconciliation and blocking, then appended AFTER
 * every grounded finding so ranking can never place an ungrounded finding above a
 * grounded one. Both buckets are published in `findings`; the split is disclosed
 * to the reader through the narrative and each ungrounded finding's null element.
 */
export interface ValidationTailInput {
  /** Raw findings from the model pass(es), pre-validation. */
  findings: Finding[];
  /** The model's holistic grade, floored to what surviving findings support (#106). */
  modelGrade: Grade;
  /** The `(route, viewport)` shots actually captured; findings off these are dropped (#32). */
  capturedShots: Iterable<CapturedShot>;
  /** Valid geometry selectors for the element_ref drop (#32); omit to skip that check. */
  geometrySelectors?: Iterable<string>;
  /** Whether the capture was visually unstable, which caps confidence (#70). */
  captureUnstable: boolean;
  /** The promoted calibration binding, applied only if it matches `identity`. */
  calibration?: CalibrationRuntimeBinding;
  /** The runtime identity the calibration binding must match to apply. */
  identity: CalibrationRuntimeIdentity;
}

export interface ValidationTailResult {
  /** Grounded findings first, then ungrounded (see `ungroundedFindings`), never interleaved. */
  findings: Finding[];
  grade: Grade;
  blockingEnabled: boolean;
  hallucinationDrops: number;
  /**
   * How many of `findings` are ungrounded (null `elementRef`): held out of the
   * grade, ranked last, and disclosed by the narrative. The grounded findings are
   * `findings.slice(0, findings.length - ungroundedFindings)`.
   */
  ungroundedFindings: number;
  /** The calibration binding IFF it matched the runtime identity (else undefined). */
  calibration: CalibrationRuntimeBinding | undefined;
}

export function runValidationTail(input: ValidationTailInput): ValidationTailResult {
  const gated = hallucinationGate(input.findings, {
    capturedShots: input.capturedShots,
    geometrySelectors: input.geometrySelectors,
  });

  const calibration =
    input.calibration && calibrationBindingMatches(input.calibration, input.identity)
      ? input.calibration
      : undefined;

  // Calibrate + cap + trust-budget each bucket the same way. Only the grounded
  // bucket goes on to blocking enforcement and the grade; the ungrounded bucket is
  // published for the reader but never drives the verdict.
  const prepare = (findings: Finding[]): Finding[] => {
    const calibrated = calibration ? applyCalibrationBinding(findings, calibration) : findings;
    const capped =
      input.captureUnstable && calibration
        ? applyConfidenceCeiling(calibrated, calibration.thresholds.unstableCaptureMaxConfidence)
        : calibrated;
    return postFilter(capped, {
      ...(calibration
        ? { minConfidence: calibration.thresholds.postFilterMinConfidence, useConfidence: true }
        : {}),
    });
  };

  const groundedFiltered = prepare(gated.findings);
  const grounded = calibration ? enforceBlockingThreshold(groundedFiltered, calibration) : groundedFiltered;
  const ungrounded = prepare(gated.ungrounded);

  // Grade is reconciled against the GROUNDED findings only: an ungrounded blocker
  // must not block a PR on an issue the model could not point at.
  const reconciledGrade = reconcileGrade(input.modelGrade, grounded);
  const blockingEnabled = calibration?.promotionMode === "blocking";
  const grade = !blockingEnabled && reconciledGrade === "blocked" ? "needs_work" : reconciledGrade;

  // Grounded first, ungrounded last: the array order IS the ranking, so no
  // ungrounded finding can ever sit above a grounded one.
  const findings = [...grounded, ...ungrounded];

  return {
    findings,
    grade,
    blockingEnabled,
    hallucinationDrops: gated.hallucinationDrops,
    ungroundedFindings: ungrounded.length,
    calibration,
  };
}
