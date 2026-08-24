import { PIXEL_BUDGETS } from "@apatureai/verdict-capture";
import type {
  CalibrationRuntimeBinding,
  CaptureImage,
  ConfidenceUnavailableReason,
  Critique,
  CritiqueOptions,
  RepoContext,
} from "@apatureai/verdict-types";
import type { ModelImage, ModelRequest } from "./model.js";
import { defaultModelFactory } from "./mock-model.js";
import { resolvePassModel, type ModelClientFactory, type PassModelOverrides } from "./registry.js";
import { reconcileNarrative } from "./narrative.js";
import { parseCritiqueOutput } from "./schema.js";
import { buildResultMetadata } from "./version-stamp.js";
import { buildSystemPrompt, SYSTEM_PROMPT_VERSION } from "./prompt.js";
import { runValidationTail } from "./validation-tail.js";

export const ENGINE_VERSION = "0.1.0";
export const PROMPT_VERSION = `system-prompt@${SYSTEM_PROMPT_VERSION}`;
export const RUBRIC_VERSION = "design-rubric@1";
const DEFAULT_CAPTURE_VERSION = "stub@0";

/** Injectable dependencies: the seam that keeps model backends swappable per pass. */
export interface CritiqueDeps {
  /** Build the model client for a resolved pass config (default: mock stand-in). */
  modelFactory?: ModelClientFactory;
  /** Per-pass model config overrides (model id / backend / thinking). */
  passModels?: PassModelOverrides;
  /** Capture version stamped on the result (from the capture that produced the images). */
  captureVersion?: string;
  /** Valid elementRef selectors from the geometry map (#18); enables the element_ref drop (#32). */
  geometrySelectors?: Iterable<string>;
  calibration?: CalibrationRuntimeBinding;
  confidenceUnavailableReason?: ConfidenceUnavailableReason;
}

function toModelImages(images: CaptureImage[]): ModelImage[] {
  return images.map((i) => ({ objectKey: i.objectKey, route: i.route, viewport: i.viewport }));
}

function buildRequest(
  model: string,
  thinking: boolean,
  images: CaptureImage[],
  context: RepoContext,
  maxPixels: number,
): ModelRequest {
  return {
    model,
    thinking,
    // #69: per-tier max_pixels enforced in the adapter (Qwen3-VL patch-16 budget,
    // not Claude's 2576px/4784-token constants); the cost lever.
    maxPixels,
    responseFormat: "json_object",
    messages: [
      // #30: the frozen rubric + grounding rules + instruction-hierarchy defense.
      // The brand dimension is scored exactly when the repo supplied a brand block.
      { role: "system", content: buildSystemPrompt({ brandPresent: context.brand !== null }) },
      { role: "user", content: `context:${context.contentHash}`, images: toModelImages(images) },
    ],
  };
}

/**
 * The single critique entry point used by every surface (TRD §6.1). It resolves
 * the per-pass model config, builds the request, and routes through the swappable
 * `ModelClient`. A model swap (Qwen3-VL <-> Claude, DashScope <-> self-host) is a
 * config change with no change here or at any call site. The model output is
 * Zod-validated (#31); the result is stamped with the resolved model (#68).
 * Two-step JSON (#29) and the hallucination gate (#32) build on this seam.
 */
export async function critique(
  images: CaptureImage[],
  context: RepoContext,
  options: CritiqueOptions,
  deps: CritiqueDeps = {},
): Promise<Critique> {
  const config = resolvePassModel(options.depth, deps.passModels);
  const client = (deps.modelFactory ?? defaultModelFactory)(config);
  const maxPixels = PIXEL_BUDGETS[options.depth];
  const response = await client.complete(
    buildRequest(config.model, config.thinking, images, context, maxPixels),
  );

  // #31: parse + Zod-validate; never hand prose downstream.
  const parsed = parseCritiqueOutput(response.text);
  const output = parsed.ok ? parsed.value : null;

  // The global validation tail (#32/#70/#33/#106), shared with assembleCritique().
  const captureVersion = deps.captureVersion ?? DEFAULT_CAPTURE_VERSION;
  const tail = runValidationTail({
    findings: output?.findings ?? [],
    modelGrade: output?.grade ?? "ship",
    capturedRoutes: images.map((i) => i.route),
    geometrySelectors: deps.geometrySelectors,
    captureUnstable: options.captureUnstable === true,
    calibration: deps.calibration,
    identity: {
      model: config.model,
      promptVersion: PROMPT_VERSION,
      engineVersion: ENGINE_VERSION,
      captureVersion,
      rubricVersion: RUBRIC_VERSION,
    },
  });

  // Same reconciliation as `assembleCritique`: this entry point runs the same
  // validation tail, so it can publish the same contradiction (a narrative about
  // findings the grounding gate deleted) and is settled the same way.
  const narrative = reconcileNarrative({
    overall: output?.overall ?? `critique via ${config.model}`,
    modelFindingsSeen: output?.findings.length ?? 0,
    survivingFindings: tail.findings.length,
    hallucinationDrops: tail.hallucinationDrops,
  });

  return {
    grade: tail.grade,
    overall: narrative.overall,
    ...(narrative.ungroundedNarrative !== undefined
      ? { ungroundedNarrative: narrative.ungroundedNarrative }
      : {}),
    findings: tail.findings,
    notReviewed: output?.notReviewed ?? [],
    validation: {
      hallucinationDrops: tail.hallucinationDrops,
      captureUnstable: options.captureUnstable === true,
      // Same count the narrative reconciliation above is given: findings that
      // entered the tail, not findings that survived it.
      modelFindingsSeen: output?.findings.length ?? 0,
    },
    metadata: buildResultMetadata({
      engineVersion: ENGINE_VERSION,
      model: config.model,
      promptVersion: PROMPT_VERSION,
      captureVersion,
      uiDnaVersion: context.uiDnaVersion,
    }),
    ...(tail.calibration ? { calibration: tail.calibration.reference } : {}),
    blockingEnabled: tail.blockingEnabled,
    ...(!tail.calibration
      ? {
          confidenceUnavailableReason:
            deps.calibration ? "mismatched_calibration_report" : deps.confidenceUnavailableReason ?? "missing_calibration_report",
        }
      : {}),
  };
}
