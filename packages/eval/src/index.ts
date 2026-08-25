export { mulberry32 } from "./rng.js";
export { CANARY_DEFECTS, generateCanaries } from "./canary.js";
export type {
  CanaryDefect,
  CanaryGroundTruth,
  CanarySpec,
  CanaryBaseline,
  GenerateCanariesOptions,
} from "./canary.js";
export {
  INJECTION_VECTORS,
  INJECTION_PAYLOADS,
  generateInjectionCanaries,
  injectionResisted,
  injectionComplianceModes,
  injectionResistance,
} from "./injection-canary.js";
export type {
  InjectionVector,
  InjectionCanarySpec,
  GenerateInjectionCanariesOptions,
  CleanReview,
  ObservedReview,
  InjectionComplianceMode,
  InjectionCase,
  InjectionResistanceResult,
} from "./injection-canary.js";
export {
  findingKey,
  isUsableForKappa,
  consensusFindings,
  raterGrades,
  parseGoldenSet,
} from "./golden-set.js";
export type { LabeledFinding, RaterLabel, GoldenCase, GoldenSet } from "./golden-set.js";
export {
  precisionRecall,
  perDimensionPR,
  blockerRecall,
  nitPrecision,
  netNewFindingRate,
  GRADE_SCALE,
  quadraticWeightedKappa,
  bootstrapKappaCI,
  krippendorffAlpha,
  gwetAC2,
  gradeRatingsMatrix,
  bootstrapAgreementCI,
} from "./metrics.js";
export type {
  PrecisionRecall,
  KappaCI,
  BootstrapOptions,
  RatingsMatrix,
  AgreementMetric,
  AgreementWeights,
  AgreementOptions,
  AgreementCI,
  NetNewLedger,
  NetNewLedgerEntry,
} from "./metrics.js";
export { canaryRecall, humanRegressionBeyondCI, regressionGate } from "./regression-gate.js";
export type {
  CanaryEvalInput,
  HumanMonitorInput,
  RegressionGateInput,
  RegressionGateResult,
} from "./regression-gate.js";
export { DEFAULT_QUALITY_BARS, qualityGate } from "./quality-gate.js";
export type { QualityBars, QualityGateInput, QualityGateResult } from "./quality-gate.js";
export { DEFAULT_SLO_TARGETS, evaluateSlos } from "./slo.js";
export type { SloTargets, SloCounts, SloResult } from "./slo.js";
export { ModelPromptRegistry } from "./registry.js";
export type {
  RegistryStatus,
  PromotionMode,
  RegistryStamp,
  RegistryEntry,
  PromotedCalibration,
  ModelPromptRegistryOptions,
} from "./registry.js";
export {
  expectedCalibrationError,
  brierScore,
  bootstrapEceCI,
  fitMonotonicCalibration,
  fitSerializableMonotonicCalibration,
  applyCalibration,
  applyCalibrationTransform,
} from "./calibration.js";
export type {
  CalibrationPair,
  ReliabilityBin,
  CalibrationReport,
  EceCI,
  BootstrapOptions as CalibrationBootstrapOptions,
  CalibrationMap,
  CalibrationKnotV1,
  CalibrationTransformV1,
} from "./calibration.js";
export {
  CALIBRATION_REPORT_SCHEMA_VERSION,
  canonicalCalibrationJson,
  serializeCalibrationReport,
  calibrationReportHash,
  calibrationAttestedPayloadHash,
  validateCalibrationReport,
  parseCalibrationReport,
  createCalibrationRuntimeBinding,
} from "./calibration-report.js";
export type {
  IntervalEstimateV1,
  CalibrationIdentityV1,
  CalibrationCohortResultV1,
  CalibrationAttestationV1,
  CalibrationReportV1,
  ExpectedCalibrationIdentity,
  CalibrationValidationCode,
  CalibrationValidationResult,
  CalibrationRuntimeResolution,
  CalibrationAttestationVerifier,
} from "./calibration-report.js";
export {
  DEFAULT_PROMOTION_TOLERANCES,
  beatsCurrentJudge,
  shadowPromotionDecision,
} from "./shadow-promotion.js";
export type {
  JudgeScorecard,
  PromotionTolerances,
  ShadowPromotionInput,
  ShadowPromotionDecision,
} from "./shadow-promotion.js";

export {
  CONTRACT_VECTORS,
  contractPairs,
  renderCalibrationContract,
} from "./calibration-contract.js";
export type { ContractVectorSpec } from "./calibration-contract.js";
export { releaseGate, parseReleaseCandidate } from "./release-gate.js";
export type {
  ReleaseCandidateV1,
  ReleaseDecisionV1,
  BlockingGuardResult,
  ReleaseGateOptions,
} from "./release-gate.js";
