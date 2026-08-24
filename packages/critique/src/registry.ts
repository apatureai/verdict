import type { ReviewDepth } from "@apatureai/verdict-types";
import type { ModelBackend, ModelClient } from "./model.js";

/** Resolved model selection for one pass. */
export interface PassModelConfig {
  model: string;
  backend: ModelBackend;
  thinking: boolean;
}

/**
 * Default per-pass model selection (TRD §5). Qwen3-VL is the default judge: the
 * fast model triages, the Thinking model does the deep pass. Every field is
 * config-overridable so a swap (Qwen3-VL <-> Claude, DashScope <-> self-host) is
 * a config change only.
 */
export const DEFAULT_PASS_MODELS: Record<ReviewDepth, PassModelConfig> = {
  triage: { model: "qwen3-vl-flash", backend: "dashscope", thinking: false },
  deep: { model: "qwen3-vl-plus", backend: "dashscope", thinking: true },
};

export type PassModelOverrides = Partial<Record<ReviewDepth, Partial<PassModelConfig>>>;

/** Resolve the model config for a pass, applying any config overrides. */
export function resolvePassModel(depth: ReviewDepth, overrides?: PassModelOverrides): PassModelConfig {
  return { ...DEFAULT_PASS_MODELS[depth], ...overrides?.[depth] };
}

/** Builds a `ModelClient` for a resolved pass config (lets backends be swapped). */
export type ModelClientFactory = (config: PassModelConfig) => ModelClient;
