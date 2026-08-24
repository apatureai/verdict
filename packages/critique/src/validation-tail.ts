import type { CalibrationRuntimeBinding, Finding, Grade } from "@apatureai/verdict-types";
import {
  applyCalibrationBinding,
  calibrationBindingMatches,
  enforceBlockingThreshold,
  type CalibrationRuntimeIdentity,
} from "./calibration-binding.js";
import { applyConfidenceCeiling } from "./confidence-ceiling.js";
import { reconcileGrade } from "./grade.js";
import { hallucinationGate } from "./hallucination-gate.js";
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
 */
export interface ValidationTailInput {
  /** Raw findings from the model pass(es), pre-validation. */
  findings: Finding[];
  /** The model's holistic grade, floored to what surviving findings support (#106). */
  modelGrade: Grade;
  /** Routes actually captured; findings on uncaptured routes are dropped (#32). */
  capturedRoutes: Iterable<string>;
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
  findings: Finding[];
  grade: Grade;
  blockingEnabled: boolean;
  hallucinationDrops: number;
  /** The calibration binding IFF it matched the runtime identity (else undefined). */
  calibration: CalibrationRuntimeBinding | undefined;
}

export function runValidationTail(input: ValidationTailInput): ValidationTailResult {
  const gated = hallucinationGate(input.findings, {
    capturedRoutes: input.capturedRoutes,
    geometrySelectors: input.geometrySelectors,
  });

  const calibration =
    input.calibration && calibrationBindingMatches(input.calibration, input.identity)
      ? input.calibration
      : undefined;

  const calibrated = calibration ? applyCalibrationBinding(gated.findings, calibration) : gated.findings;
  const capped =
    input.captureUnstable && calibration
      ? applyConfidenceCeiling(calibrated, calibration.thresholds.unstableCaptureMaxConfidence)
      : calibrated;
  const filtered = postFilter(capped, {
    ...(calibration
      ? { minConfidence: calibration.thresholds.postFilterMinConfidence, useConfidence: true }
      : {}),
  });
  const findings = calibration ? enforceBlockingThreshold(filtered, calibration) : filtered;

  const reconciledGrade = reconcileGrade(input.modelGrade, findings);
  const blockingEnabled = calibration?.promotionMode === "blocking";
  const grade = !blockingEnabled && reconciledGrade === "blocked" ? "needs_work" : reconciledGrade;

  return { findings, grade, blockingEnabled, hallucinationDrops: gated.hallucinationDrops, calibration };
}
