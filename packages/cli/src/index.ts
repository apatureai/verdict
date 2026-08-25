export { parseArgs, ArgError, DEFAULT_OPTIONS, USAGE } from "./args.js";
export type { CliOptions, ModelChoice } from "./args.js";
export { runCli } from "./run.js";
export type { RunIo } from "./run.js";
export {
  discloseGrounding,
  renderDeterministicFacts,
  runLocalReview,
  writeReviewArtifacts,
} from "./local-review.js";
export type {
  LocalReviewRequest,
  LocalReviewDeps,
  LocalReviewOutcome,
  WrittenArtifacts,
} from "./local-review.js";
export {
  contextGroundingParts,
  resolveGrounding,
  ungroundedDisclosure,
  withDisclosure,
  UNGROUNDED_DISCLOSURE_PREFIX,
} from "./grounding.js";
export type { LocalGenome, LocalGrounding, UngroundedReason } from "./grounding.js";
export { loadRepoGenome, UI_DNA_FILENAME } from "./genome-source.js";
export {
  lexicalEmbedder,
  lexicalTokens,
  lexicalVector,
  LEXICAL_EMBEDDER_DESCRIPTION,
  LEXICAL_EMBEDDER_DIMENSIONS,
  LEXICAL_EMBEDDER_ID,
} from "./lexical-embedder.js";
export { resolveLocalModel, fixturesDir, passModelsFromEnv, backendFromEnv, contextWindowFromEnv } from "./model-choice.js";
export type { ResolvedLocalModel, ResolveLocalModelOptions } from "./model-choice.js";
export {
  CLI_ENGINE_NAME,
  localJudgmentProvenance,
  stampJudgmentProvenance,
} from "./provenance.js";
export { serveDirectory, resolveRequestPath, candidateFiles } from "./static-server.js";
export type { StaticSite } from "./static-server.js";
export { FileScreenshotSink, displayPath } from "./file-sink.js";
export { loadRepoContext } from "./repo-context.js";
export type { LoadedRepoContext } from "./repo-context.js";
export {
  renderSummary,
  renderFindings,
  renderFacts,
  renderFixtureCritique,
  renderGrounding,
  renderReview,
  countByKind,
  groupFacts,
  isSynthetic,
} from "./report.js";
export type { RunSummary, ReportModelKind, FactGroup } from "./report.js";
