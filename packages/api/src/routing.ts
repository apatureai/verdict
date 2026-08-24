import type { ReviewDepth } from "@apatureai/verdict-jobs";

/**
 * Depth -> model routing (TRD §5). The triage pass uses the fast/cheap model to
 * short-circuit no-op changes; the deep pass uses the stronger Thinking model.
 * The free-tier deep-pass swap (#35) and the registry-driven selection (#71)
 * layer on top of this default mapping.
 */
export const MODEL_BY_DEPTH: Record<ReviewDepth, string> = {
  triage: "qwen3-vl-flash",
  deep: "qwen3-vl-plus",
};

export function modelForDepth(depth: ReviewDepth): string {
  return MODEL_BY_DEPTH[depth];
}
