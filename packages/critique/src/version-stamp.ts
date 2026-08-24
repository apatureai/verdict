import type { ResultMetadata } from "@apatureai/verdict-types";

/**
 * Version stamping (#68). Every Findings result carries
 * `{engineVersion, model, promptVersion, captureVersion}`, the stable interface
 * consumers depend on and the lineage key for the preference dataset. A
 * prompt/model change without a version bump must be impossible, so the four
 * fields are required and asserted non-empty. The values are sourced from the
 * model/prompt registry (#71); until that lands they come from the adapter
 * constants + the resolved per-pass model (#26) + the capture version.
 */
export interface VersionStampInput {
  engineVersion: string;
  model: string;
  promptVersion: string;
  captureVersion: string;
  rubricVersion?: string;
  uiDnaVersion: string | null;
}

const REQUIRED: (keyof VersionStampInput)[] = [
  "engineVersion",
  "model",
  "promptVersion",
  "captureVersion",
];

/** Build the stamped `ResultMetadata`, throwing if any required version is empty. */
export function buildResultMetadata(input: VersionStampInput): ResultMetadata {
  for (const field of REQUIRED) {
    if (!input[field]) {
      throw new Error(`version stamp missing "${field}": a prompt/model change must bump its version`);
    }
  }
  return {
    engineVersion: input.engineVersion,
    model: input.model,
    promptVersion: input.promptVersion,
    captureVersion: input.captureVersion,
    rubricVersion: input.rubricVersion ?? "design-rubric@1",
    uiDnaVersion: input.uiDnaVersion,
  };
}

/** Throw unless every required version field is stamped (defensive gate). */
export function assertVersionStamped(metadata: ResultMetadata): void {
  buildResultMetadata({ ...metadata });
}

/**
 * The `{engine.*}` OTel span attributes for the version stamp: the same fields
 * `@apatureai/verdict-observability` `setVersionAttributes` puts on critique spans (#8), so
 * traces are filterable by model/prompt/capture revision.
 */
export function versionSpanAttributes(metadata: ResultMetadata): Record<string, string> {
  return {
    "engine.engine_version": metadata.engineVersion,
    "engine.model": metadata.model,
    "engine.prompt_version": metadata.promptVersion,
    "engine.capture_version": metadata.captureVersion,
    ...(metadata.rubricVersion ? { "engine.rubric_version": metadata.rubricVersion } : {}),
  };
}
