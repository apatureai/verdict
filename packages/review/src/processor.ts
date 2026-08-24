import type { EngineReviewResult } from "@apatureai/verdict-types";
import { runReview, type ReviewDeps, type ReviewInput } from "./orchestrator.js";

export type ReviewDepsProvider<TJob> =
  | ReviewDeps
  | ((job: TJob, input: ReviewInput) => ReviewDeps | Promise<ReviewDeps>);

/**
 * Adapt the pure `runReview` orchestrator into a job processor: a function that
 * takes a job and returns the wire result the async job API persists. The API
 * package binds this as its injectable `processor`, REPLACING the EM0
 * `defaultProcessor` stub (`packages/api/src/server.ts`) whose own comment said
 * "EM2 replaces this with the real capture + critique pipeline".
 *
 * Generic over the job shape (`TJob`) so this package does NOT depend on
 * `@apatureai/verdict-jobs`: the caller supplies a `toReviewInput` mapper that derives the
 * orchestrator input from its own job record (depth, opaque review request,
 * resolved context/capture inputs). Live I/O (capture seam, model factory,
 * genome embedder) is injected once via `deps`.
 */
export function createReviewProcessor<TJob>(
  toReviewInput: (job: TJob) => ReviewInput | Promise<ReviewInput>,
  deps: ReviewDepsProvider<TJob>,
): (job: TJob) => Promise<EngineReviewResult> {
  return async (job: TJob): Promise<EngineReviewResult> => {
    const input = await toReviewInput(job);
    const resolvedDeps = typeof deps === "function" ? await deps(job, input) : deps;
    return runReview(input, resolvedDeps);
  };
}
