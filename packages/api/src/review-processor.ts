import type { JobRecord } from "@apatureai/verdict-jobs";
import {
  createReviewProcessor,
  type ReviewDepsProvider,
  type ReviewInput,
} from "@apatureai/verdict-review";
import type { EngineReviewResult } from "@apatureai/verdict-types";
import type { JobProcessor } from "./server.js";

/**
 * Bind the end-to-end review orchestrator (#109, `@apatureai/verdict-review`) as the API's
 * job processor, the real replacement for the EM0 `defaultProcessor` stub (whose
 * comment promised "EM2 replaces this with the real capture + critique
 * pipeline"). The async job path can now run the actual
 * context→capture→triage→deep-pass→assemble→project sequence by passing the
 * result of this to `createJobApi({ processor })`.
 *
 * Live I/O is INJECTED via `deps` (capture sandbox seam #11/#22, model factory
 * #27, genome embedder #104): the real worker binds real ones; tests bind stubs
 * + the mock model. `toReviewInput` derives the orchestrator input from a job's
 * depth + opaque review request payload (resolved context/capture inputs).
 *
 * Kept SEAM-FIRST: `createJobApi` still defaults to the version-stamped
 * `defaultProcessor` when no processor is supplied (so existing API tests are
 * untouched); this is the production binding a deployment opts into.
 */
export function createJobReviewProcessor(
  toReviewInput: (job: JobRecord) => ReviewInput | Promise<ReviewInput>,
  deps: ReviewDepsProvider<JobRecord>,
): JobProcessor {
  const processor = createReviewProcessor<JobRecord>(toReviewInput, deps);
  return (job: JobRecord): Promise<EngineReviewResult> => processor(job);
}
