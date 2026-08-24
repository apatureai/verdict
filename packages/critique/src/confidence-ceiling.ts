import type { Finding } from "@apatureai/verdict-types";

/**
 * Confidence-ceiling propagation (TRD §5, #70). When the capture stability gate
 * (#15) flags a page as visually unstable, every finding's confidence is capped
 * at the ceiling so an unreliable render can't yield high-confidence findings;
 * the result also carries `validation.captureUnstable = true`. The cap runs
 * after calibration and before the post-filter (#33). Both numbers come from
 * the exact promoted CalibrationReportV1; capture contributes only instability.
 */
export function applyConfidenceCeiling(findings: Finding[], ceiling: number): Finding[] {
  return findings.map((f) => (f.confidence > ceiling ? { ...f, confidence: ceiling } : f));
}
