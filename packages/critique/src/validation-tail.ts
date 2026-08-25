import type {
  CalibrationRuntimeBinding,
  Dimension,
  Finding,
  Grade,
  WithheldFindings,
} from "@apatureai/verdict-types";
import {
  applyCalibrationBinding,
  calibrationBindingMatches,
  enforceBlockingThreshold,
  type CalibrationRuntimeIdentity,
} from "./calibration-binding.js";
import { applyConfidenceCeiling } from "./confidence-ceiling.js";
import { duplicateFactGate } from "./duplicate-fact-gate.js";
import type { FactLedger } from "./fact-ledger.js";
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
  /**
   * The deterministic fact ledger (judge-unlock §4.1/§4.3). When present, the
   * duplicate-of-measurement gate runs between the hallucination gate and
   * calibration: a grounded finding whose substance is an ALREADY-REPORTED
   * measurement is dropped or demoted, so the trust budget is spent on judgment
   * rather than on restated facts. Absent ⇒ the gate is a no-op, byte-identical
   * to before.
   */
  factLedger?: FactLedger;
}

export interface ValidationTailResult {
  /** Grounded findings first, then ungrounded (see `ungroundedFindings`), never interleaved. */
  findings: Finding[];
  grade: Grade;
  blockingEnabled: boolean;
  hallucinationDrops: number;
  /**
   * How many of `findings` are ungrounded (null `elementRef`): held out of the
   * grade, ranked last, and disclosed by the narrative.
   */
  ungroundedFindings: number;
  /**
   * Findings dropped because their substance was a measurement already reported
   * (judge-unlock §4.2). Not published.
   */
  duplicateFactDrops: number;
  /**
   * Surviving findings kept but DEMOTED for restating a reported measurement:
   * ranked last, excluded from the grade and from `netNewFindings`.
   */
  restatedFindings: number;
  /**
   * Surviving findings that made a claim no deterministic check had already
   * published. THE NORTH-STAR NUMERATOR (judge-unlock §4.4).
   */
  netNewFindings: number;
  /**
   * What the trust-budget cap withheld across every bucket (F3): disclosed on the
   * result rather than dropped in silence. `total: 0` when nothing was withheld.
   */
  withheldFindings: WithheldFindings;
  /** The calibration binding IFF it matched the runtime identity (else undefined). */
  calibration: CalibrationRuntimeBinding | undefined;
}

/** Merge per-bucket withheld summaries into one, re-summing per dimension. */
function mergeWithheld(parts: WithheldFindings[]): WithheldFindings {
  const byDim = new Map<Dimension, number>();
  let total = 0;
  for (const part of parts) {
    total += part.total;
    for (const { dimension, count } of part.byDimension) {
      byDim.set(dimension, (byDim.get(dimension) ?? 0) + count);
    }
  }
  const byDimension = [...byDim.entries()]
    .map(([dimension, count]) => ({ dimension, count }))
    .sort((a, b) => a.dimension.localeCompare(b.dimension));
  return { total, byDimension };
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
  const prepare = (findings: Finding[]): { findings: Finding[]; withheld: WithheldFindings } => {
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

  // The duplicate-of-measurement gate (judge-unlock §4.2/§4.3) runs on the
  // element-grounded bucket, BEFORE calibration and the trust-budget post-filter,
  // so the budget is spent on judgment rather than on restated facts. A finding
  // whose substance is an already-reported measurement is DROPPED; an ambiguous
  // restatement is DEMOTED and treated exactly like an ungrounded finding. Absent
  // ledger ⇒ no-op, byte-identical to before.
  const dup = input.factLedger
    ? duplicateFactGate(gated.findings, input.factLedger)
    : { findings: gated.findings, restatements: [] as Finding[], duplicateFactDrops: 0 };

  const groundedPrepared = prepare(dup.findings);
  const grounded = calibration
    ? enforceBlockingThreshold(groundedPrepared.findings, calibration)
    : groundedPrepared.findings;
  const ungroundedPrepared = prepare(gated.ungrounded);
  const ungrounded = ungroundedPrepared.findings;
  // Restatements are treated exactly like the ungrounded bucket: calibrated,
  // trust-budgeted, appended after every grounded novel finding, and excluded
  // from the grade. A restating model therefore produces a visibly empty review
  // rather than an invisibly worthless one.
  const restatedPrepared = prepare(dup.restatements);
  const restated = restatedPrepared.findings;
  // The trust-budget cap's withholdings across all three buckets, disclosed (F3)
  // rather than dropped in silence.
  const withheldFindings = mergeWithheld([
    groundedPrepared.withheld,
    ungroundedPrepared.withheld,
    restatedPrepared.withheld,
  ]);

  // Grade is reconciled against the GROUNDED NOVEL findings only: a restated or
  // ungrounded finding must never drive the verdict.
  const reconciledGrade = reconcileGrade(input.modelGrade, grounded);
  const blockingEnabled = calibration?.promotionMode === "blocking";
  const grade = !blockingEnabled && reconciledGrade === "blocked" ? "needs_work" : reconciledGrade;

  // Grounded first, then ungrounded, then restated: the array order IS the
  // ranking, so nothing held out of the grade can ever sit above a grounded one.
  const findings = [...grounded, ...ungrounded, ...restated];

  return {
    findings,
    grade,
    blockingEnabled,
    hallucinationDrops: gated.hallucinationDrops,
    ungroundedFindings: ungrounded.length,
    duplicateFactDrops: dup.duplicateFactDrops,
    restatedFindings: restated.length,
    // The north-star numerator: novel survivors that drive or could drive the
    // grade (grounded) plus honest-but-unlocatable novel observations
    // (ungrounded). Restatements and duplicates are excluded by construction.
    netNewFindings: grounded.length + ungrounded.length,
    withheldFindings,
    calibration,
  };
}
