/**
 * `@apatureai/verdict-evidence`: the producer of the signed `DerivedEvidenceBundleV1`
 * Entropy Engine's acceptance gate consumes (judgment-engine#156).
 *
 * Judgment Engine owns checkout/capture, adapter authorization, artifact
 * custody, bundle identity, and signing. This package is contract-only wire +
 * a pure builder + an injected signer port, with no network, model, browser,
 * store, or private key. The RFC 8785 canonicalizer is byte-identical to Entropy's
 * verifier so one golden verifies in both repositories.
 */

export * from "./bundle.js";
export { canonicalize, canonicalBytes, CanonicalizationError } from "./canonicalize.js";
export {
  buildDerivedEvidenceBundle,
  signDerivedEvidenceBundle,
  bundleCanonicalDigest,
  BundleIntegrityError,
  type Ed25519SignerPort,
  type BuildBundleInput,
} from "./producer.js";
export {
  ARTIFACT_TRUST_DECISION_VERSION,
  decideArtifactTrust,
  isUsePermitted,
  assertNotSemanticAuthority,
  SemanticAuthorityError,
  type AllowedUse,
  type ForbiddenBySignatureAlone,
  type ArtifactTrustDecisionV1,
  type TrustDecisionInput,
} from "./trust-decision.js";
export {
  EVIDENCE_REQUEST_SCHEMA_VERSION,
  bindingFieldsFromRequest,
  bundleBindsToRequest,
  assertBundleBindsToRequest,
  RequestBindingError,
  type EvidenceRequestUiDnaRef,
  type EvidenceRequestV1,
  type BundleBinding,
  type BindingCheck,
} from "./request.js";
export {
  corruptBundle,
  buildNegativeCorpus,
  signedContentBytes,
  ALL_BUNDLE_MUTATIONS,
  type BundleMutation,
  type CorruptBundle,
} from "./negative-corpus.js";
export {
  EVIDENCE_METRICS_VERSION,
  EVIDENCE_METRICS,
  ALLOWED_EVIDENCE_LABEL_KEYS,
  isEvidenceMetric,
  assertEvidenceMetricSafe,
  EvidenceMetricDlpError,
  type EvidenceMetricUnit,
  type EvidenceMetricName,
  type EvidenceMetricDef,
  type EvidenceRejectionReason,
  type EvidenceMetricLabels,
  type EvidenceMetricEvent,
} from "./metrics.js";
