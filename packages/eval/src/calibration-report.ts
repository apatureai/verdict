import { createHash } from "node:crypto";
import type {
  CalibrationRuntimeBinding,
  ConfidenceSource,
  ConfidenceUnavailableReason,
} from "@apatureai/verdict-types";
import {
  applyCalibrationTransform,
  type CalibrationTransformV1,
  type ReliabilityBin,
} from "./calibration.js";

export const CALIBRATION_REPORT_SCHEMA_VERSION = "1";

export interface IntervalEstimateV1 {
  estimate: number;
  lower: number;
  upper: number;
  confidenceLevel: number;
}

export interface CalibrationIdentityV1 {
  model: string;
  promptVersion: string;
  engineVersion: string;
  captureVersion: string;
  rubricVersion: string;
}

export interface CalibrationCohortResultV1 {
  cohort: string;
  samples: number;
  ece: IntervalEstimateV1;
  brier: IntervalEstimateV1;
  blockerFalsePositiveRate: IntervalEstimateV1;
  validReferenceRate: IntervalEstimateV1;
  status: "pass" | "regression" | "missing";
}

export interface CalibrationAttestationV1 {
  algorithm: "ed25519" | "hmac-sha256";
  keyId: string;
  /** SHA-256 of the canonical report bytes with `attestation: null`. */
  signedPayloadHash: `sha256:${string}`;
  signature: string;
}

/**
 * Promotion artifact for eval-gated promotion. All numeric decisions live here;
 * the runtime consumes this value and never invents a surface-local default.
 */
export interface CalibrationReportV1 {
  schemaVersion: "1";
  reportId: string;
  calibrationVersion: string;
  confidenceSource: ConfidenceSource;
  identity: CalibrationIdentityV1;
  manifests: {
    fitManifestHash: `sha256:${string}`;
    evalManifestHash: `sha256:${string}`;
  };
  splitPolicy: {
    repository: string;
    team: string;
    time: string;
    requiredCohorts: string[];
  };
  sampleCounts: {
    fit: number;
    evaluation: number;
    byCohort: Record<string, number>;
  };
  reliability: {
    bins: ReliabilityBin[];
    ece: IntervalEstimateV1;
    brier: IntervalEstimateV1;
  };
  risk: {
    aurc: IntervalEstimateV1;
    coverageAtFalseBlockTarget: IntervalEstimateV1;
    blockerFalsePositiveRate: IntervalEstimateV1;
    precision: IntervalEstimateV1;
    validReferenceRate: IntervalEstimateV1;
    falseBlockTarget: number;
    cohorts: CalibrationCohortResultV1[];
  };
  thresholds: {
    postFilterMinConfidence: number;
    blockingMinConfidence: number;
    unstableCaptureMaxConfidence: number;
  };
  transform: CalibrationTransformV1;
  evidenceStatus: "sufficient_evidence" | "insufficient_evidence";
  createdAt: string;
  validUntil: string;
  attestation: CalibrationAttestationV1 | null;
}

export interface ExpectedCalibrationIdentity extends Partial<CalibrationIdentityV1> {
  fitManifestHash?: `sha256:${string}`;
  evalManifestHash?: `sha256:${string}`;
  calibrationVersion?: string;
}

export type CalibrationValidationCode =
  | "malformed"
  | "non_finite"
  | "stale"
  | "cross_version"
  | "wrong_manifest"
  | "wrong_identity"
  | "insufficient_evidence"
  | "unattested";

export type CalibrationValidationResult =
  | { ok: true; report: CalibrationReportV1; reportHash: `sha256:${string}` }
  | { ok: false; code: CalibrationValidationCode; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** RFC 8785-compatible serialization for the JSON value subset used here. */
export function canonicalCalibrationJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in calibration report");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalCalibrationJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalCalibrationJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`unsupported calibration JSON value: ${typeof value}`);
}

export function serializeCalibrationReport(report: CalibrationReportV1): string {
  return `${canonicalCalibrationJson(report)}\n`;
}

function sha256(bytes: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

export function calibrationReportHash(report: CalibrationReportV1): `sha256:${string}` {
  return sha256(serializeCalibrationReport(report));
}

export function calibrationAttestedPayloadHash(report: CalibrationReportV1): `sha256:${string}` {
  return sha256(serializeCalibrationReport({ ...report, attestation: null }));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function shaRef(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validInterval(value: unknown): value is IntervalEstimateV1 {
  if (!isRecord(value)) return false;
  return (
    probability(value.estimate) &&
    probability(value.lower) &&
    probability(value.upper) &&
    probability(value.confidenceLevel) &&
    value.lower <= value.estimate &&
    value.estimate <= value.upper
  );
}

function validReliabilityBins(value: unknown): value is ReliabilityBin[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let priorUpper = 0;
  return value.every((raw, index) => {
    if (!isRecord(raw)) return false;
    const valid =
      probability(raw.lower) &&
      probability(raw.upper) &&
      raw.lower <= raw.upper &&
      nonNegativeInteger(raw.count) &&
      probability(raw.predictedMean) &&
      probability(raw.empiricalRate) &&
      (index === 0 || raw.lower >= priorUpper);
    if (valid) priorUpper = raw.upper as number;
    return valid;
  });
}

function validTransform(value: unknown): value is CalibrationTransformV1 {
  if (!isRecord(value) || value.kind !== "isotonic_v1" || !Array.isArray(value.knots) || value.knots.length < 2) {
    return false;
  }
  let priorRaw = -1;
  let priorCalibrated = -1;
  for (const rawKnot of value.knots) {
    if (!isRecord(rawKnot) || !probability(rawKnot.raw) || !probability(rawKnot.calibrated)) return false;
    if (rawKnot.raw <= priorRaw || rawKnot.calibrated < priorCalibrated) return false;
    priorRaw = rawKnot.raw;
    priorCalibrated = rawKnot.calibrated;
  }
  const first = value.knots[0] as Record<string, unknown>;
  const last = value.knots[value.knots.length - 1] as Record<string, unknown>;
  return first.raw === 0 && last.raw === 1;
}

function validCohort(value: unknown): value is CalibrationCohortResultV1 {
  if (!isRecord(value)) return false;
  return (
    nonEmpty(value.cohort) &&
    nonNegativeInteger(value.samples) &&
    validInterval(value.ece) &&
    validInterval(value.brier) &&
    validInterval(value.blockerFalsePositiveRate) &&
    validInterval(value.validReferenceRate) &&
    (value.status === "pass" || value.status === "regression" || value.status === "missing")
  );
}

function malformed(error: string): CalibrationValidationResult {
  return { ok: false, code: "malformed", error };
}

export function validateCalibrationReport(
  value: unknown,
  expected: ExpectedCalibrationIdentity = {},
  nowMs: number = Date.now(),
): CalibrationValidationResult {
  if (!isRecord(value)) return malformed("report must be an object");
  if (value.schemaVersion !== CALIBRATION_REPORT_SCHEMA_VERSION) {
    return { ok: false, code: "cross_version", error: "unsupported CalibrationReportV1 schema version" };
  }
  if (
    !nonEmpty(value.reportId) ||
    !nonEmpty(value.calibrationVersion) ||
    !["raw_verbalized", "post_hoc_isotonic", "post_hoc_histogram", "hidden_state_probe", "ensemble"].includes(
      String(value.confidenceSource),
    )
  ) return malformed("invalid report identity/source");

  const identity = value.identity;
  if (!isRecord(identity) || !["model", "promptVersion", "engineVersion", "captureVersion", "rubricVersion"].every(
    (key) => nonEmpty(identity[key]),
  )) return malformed("invalid model/prompt/engine/capture/rubric identity");

  const manifests = value.manifests;
  if (!isRecord(manifests) || !shaRef(manifests.fitManifestHash) || !shaRef(manifests.evalManifestHash)) {
    return malformed("invalid fit/eval manifest hash");
  }

  const split = value.splitPolicy;
  if (
    !isRecord(split) ||
    !nonEmpty(split.repository) ||
    !nonEmpty(split.team) ||
    !nonEmpty(split.time) ||
    !Array.isArray(split.requiredCohorts) ||
    split.requiredCohorts.length === 0 ||
    !split.requiredCohorts.every(nonEmpty) ||
    !split.requiredCohorts.includes("visual_text_conflict")
  ) return malformed("repository/team/time policy and visual_text_conflict cohort are required");

  const counts = value.sampleCounts;
  if (
    !isRecord(counts) ||
    !nonNegativeInteger(counts.fit) ||
    !nonNegativeInteger(counts.evaluation) ||
    !isRecord(counts.byCohort) ||
    !Object.values(counts.byCohort).every(nonNegativeInteger)
  ) return malformed("invalid sample counts");

  const reliability = value.reliability;
  if (
    !isRecord(reliability) ||
    !validReliabilityBins(reliability.bins) ||
    !validInterval(reliability.ece) ||
    !validInterval(reliability.brier)
  ) return malformed("invalid reliability evidence");

  const risk = value.risk;
  if (
    !isRecord(risk) ||
    !validInterval(risk.aurc) ||
    !validInterval(risk.coverageAtFalseBlockTarget) ||
    !validInterval(risk.blockerFalsePositiveRate) ||
    !validInterval(risk.precision) ||
    !validInterval(risk.validReferenceRate) ||
    !probability(risk.falseBlockTarget) ||
    !Array.isArray(risk.cohorts) ||
    !risk.cohorts.every(validCohort)
  ) return malformed("invalid risk-coverage/cohort evidence");

  const cohortNames = new Set((risk.cohorts as CalibrationCohortResultV1[]).map((cohort) => cohort.cohort));
  if (!(split.requiredCohorts as string[]).every((cohort) => cohortNames.has(cohort))) {
    return malformed("required cohort evidence is missing");
  }

  const thresholds = value.thresholds;
  if (
    !isRecord(thresholds) ||
    !probability(thresholds.postFilterMinConfidence) ||
    !probability(thresholds.blockingMinConfidence) ||
    !probability(thresholds.unstableCaptureMaxConfidence)
  ) return malformed("invalid report-owned thresholds");
  if (thresholds.blockingMinConfidence < thresholds.postFilterMinConfidence) {
    return malformed("blocking threshold cannot be below the display post-filter threshold");
  }
  if (!validTransform(value.transform)) return malformed("invalid serialized calibration transform");
  if (value.evidenceStatus !== "sufficient_evidence" && value.evidenceStatus !== "insufficient_evidence") {
    return malformed("invalid evidence status");
  }
  const evaluatedInBins = (reliability.bins as ReliabilityBin[])
    .reduce((total, bin) => total + bin.count, 0);
  const cohortByName = new Map(
    (risk.cohorts as CalibrationCohortResultV1[]).map((cohort) => [cohort.cohort, cohort]),
  );
  const evidenceIsPopulated =
    (counts.fit as number) > 0 &&
    (counts.evaluation as number) > 0 &&
    evaluatedInBins === counts.evaluation &&
    (split.requiredCohorts as string[]).every((cohortName) => {
      const declared = (counts.byCohort as Record<string, number>)[cohortName];
      const cohort = cohortByName.get(cohortName);
      return declared !== undefined && declared > 0 && cohort?.samples === declared;
    });
  if (!evidenceIsPopulated) {
    return { ok: false, code: "insufficient_evidence", error: "calibration evidence sample counts are insufficient" };
  }
  if (!nonEmpty(value.createdAt) || !nonEmpty(value.validUntil)) return malformed("missing report validity window");
  const createdAt = Date.parse(value.createdAt as string);
  const validUntil = Date.parse(value.validUntil as string);
  if (!Number.isFinite(createdAt) || !Number.isFinite(validUntil) || createdAt > validUntil) {
    return malformed("invalid report validity window");
  }
  if (nowMs > validUntil) return { ok: false, code: "stale", error: "calibration report is stale" };

  if (value.attestation !== null) {
    const attestation = value.attestation;
    if (
      !isRecord(attestation) ||
      (attestation.algorithm !== "ed25519" && attestation.algorithm !== "hmac-sha256") ||
      !nonEmpty(attestation.keyId) ||
      !shaRef(attestation.signedPayloadHash) ||
      !nonEmpty(attestation.signature)
    ) return malformed("invalid calibration attestation");
  }

  const report = value as unknown as CalibrationReportV1;
  if (report.attestation && report.attestation.signedPayloadHash !== calibrationAttestedPayloadHash(report)) {
    return { ok: false, code: "unattested", error: "attestation payload hash does not match report" };
  }
  for (const key of ["model", "promptVersion", "engineVersion", "captureVersion", "rubricVersion"] as const) {
    if (expected[key] !== undefined && report.identity[key] !== expected[key]) {
      return { ok: false, code: "wrong_identity", error: `calibration ${key} does not match candidate` };
    }
  }
  if (expected.calibrationVersion !== undefined && report.calibrationVersion !== expected.calibrationVersion) {
    return { ok: false, code: "cross_version", error: "calibration version does not match" };
  }
  if (
    (expected.fitManifestHash !== undefined && report.manifests.fitManifestHash !== expected.fitManifestHash) ||
    (expected.evalManifestHash !== undefined && report.manifests.evalManifestHash !== expected.evalManifestHash)
  ) return { ok: false, code: "wrong_manifest", error: "calibration manifest does not match" };
  if (report.evidenceStatus !== "sufficient_evidence") {
    return { ok: false, code: "insufficient_evidence", error: "calibration evidence is insufficient" };
  }
  if (report.risk.cohorts.some((cohort) => cohort.status !== "pass")) {
    return { ok: false, code: "insufficient_evidence", error: "required cohort did not pass" };
  }
  return { ok: true, report, reportHash: calibrationReportHash(report) };
}

export function parseCalibrationReport(
  bytes: string,
  expected: ExpectedCalibrationIdentity = {},
  nowMs?: number,
): CalibrationValidationResult {
  try {
    return validateCalibrationReport(JSON.parse(bytes), expected, nowMs);
  } catch (error) {
    return malformed(error instanceof Error ? error.message : "invalid calibration JSON");
  }
}

function unavailableReason(code: CalibrationValidationCode): ConfidenceUnavailableReason {
  switch (code) {
    case "insufficient_evidence": return "insufficient_evidence";
    case "unattested": return "unattested_calibration_report";
    case "wrong_identity":
    case "wrong_manifest":
    case "cross_version": return "mismatched_calibration_report";
    default: return "invalid_calibration_report";
  }
}

export type CalibrationRuntimeResolution =
  | { ok: true; binding: CalibrationRuntimeBinding }
  | { ok: false; reason: ConfidenceUnavailableReason; error: string };

export function createCalibrationRuntimeBinding(
  value: unknown,
  promotionMode: "advisory" | "blocking",
  expected: ExpectedCalibrationIdentity = {},
  nowMs?: number,
): CalibrationRuntimeResolution {
  const validated = validateCalibrationReport(value, expected, nowMs);
  if (!validated.ok) {
    return { ok: false, reason: unavailableReason(validated.code), error: validated.error };
  }
  const { report, reportHash } = validated;
  return {
    ok: true,
    binding: {
      reference: {
        reportId: report.reportId,
        reportHash,
        calibrationVersion: report.calibrationVersion,
        confidenceSource: report.confidenceSource,
      },
      identity: { ...report.identity },
      promotionMode,
      thresholds: { ...report.thresholds },
      calibrate: (rawConfidence: number) => applyCalibrationTransform(report.transform, rawConfidence),
    },
  };
}

export type CalibrationAttestationVerifier = (
  report: CalibrationReportV1,
  reportHash: `sha256:${string}`,
) => Promise<boolean>;
