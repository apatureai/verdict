import type { CalibrationRuntimeBinding, Finding } from "@apatureai/verdict-types";

export interface CalibrationRuntimeIdentity {
  model: string;
  promptVersion: string;
  engineVersion: string;
  captureVersion: string;
  rubricVersion: string;
}

export function calibrationBindingMatches(
  binding: CalibrationRuntimeBinding,
  identity: CalibrationRuntimeIdentity,
): boolean {
  return (Object.keys(identity) as Array<keyof CalibrationRuntimeIdentity>).every(
    (key) => binding.identity[key] === identity[key],
  );
}

/** Transform raw model scores exactly once, retaining raw values as restricted provenance. */
export function applyCalibrationBinding(
  findings: Finding[],
  binding: CalibrationRuntimeBinding,
): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    rawConfidence: finding.rawConfidence ?? finding.confidence,
    confidence: binding.calibrate(finding.rawConfidence ?? finding.confidence),
  }));
}

/** Blocking is possible only for findings meeting the report-owned threshold. */
export function enforceBlockingThreshold(
  findings: Finding[],
  binding: CalibrationRuntimeBinding,
): Finding[] {
  if (binding.promotionMode !== "blocking") return findings;
  return findings.map((finding) =>
    finding.severity === "blocker" && finding.confidence < binding.thresholds.blockingMinConfidence
      ? { ...finding, severity: "major" }
      : finding,
  );
}
