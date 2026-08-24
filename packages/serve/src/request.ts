import type { LocalGenome, LocalReviewRequest } from "@apatureai/verdict-cli";
import type { ContextBlockInput } from "@apatureai/verdict-context";
import type { JobRecord } from "@apatureai/verdict-jobs";
import { toReviewInput } from "@apatureai/verdict-runtime/input";
import { LocalEngineError } from "./errors.js";

/**
 * Turn a durable job into the input the local pipeline runs.
 *
 * The submitted payload is Gate's `POST /jobs` contract verbatim, parsed by the
 * SAME `toReviewInput` the production composition root uses, so this server is
 * a service Gate can actually be pointed at rather than a private dialect. That
 * function also does the two checks a local server must not skip: the request's
 * `installationId` and `depth` are verified against the HMAC-scoped durable job
 * rather than trusted from caller-controlled JSON.
 *
 * Everything Gate cannot send is layered on here from the operator's own
 * configuration. That set has shrunk: the contract now carries the component
 * libraries the caller detected as well as design tokens and a brand string, so
 * `--context-dir` is the fallback for a caller that did not send them, and the
 * operator's directory still supplies the one thing no request can (the UI-DNA
 * genome, which the deployed engine resolves from its own Source of Truth).
 */

export interface LocalRequestOptions {
  /** Design context loaded from `--context-dir`, if the operator configured one. */
  repoContext?: ContextBlockInput;
  /**
   * The UI-DNA genome loaded from `--context-dir`, or the reason there is none.
   * Gate's job contract has no field for a genome (the deployed engine resolves
   * one itself from the Source of Truth), so this can only come from the
   * operator's own directory, and it is forwarded whichever way it came out: a
   * review that could not be grounded says so rather than staying silent.
   */
  genome?: LocalGenome;
  /** Retention advertised on the wire result. */
  screenshotRetentionSeconds?: number;
  /** Capture each page twice and compare the bytes. */
  verifyStability?: boolean;
  /** Object-key prefix for this job's screenshots. */
  keyPrefix: string;
}

/**
 * Request-supplied context wins wherever the request actually supplied
 * something; the operator's directory fills the rest. Neither one is silently
 * discarded, and a review with no context at all is still a review, just a less
 * grounded one.
 */
function mergeContext(
  fromRequest: ContextBlockInput,
  repo: ContextBlockInput | undefined,
): ContextBlockInput {
  if (!repo) return fromRequest;
  return {
    tokens: Object.keys(fromRequest.tokens).length > 0 ? fromRequest.tokens : repo.tokens,
    brand: fromRequest.brand ?? repo.brand,
    componentLibraries:
      fromRequest.componentLibraries.length > 0
        ? fromRequest.componentLibraries
        : repo.componentLibraries,
    uiDnaVersion: fromRequest.uiDnaVersion,
    ...(fromRequest.routes ? { routes: fromRequest.routes } : {}),
  };
}

export function toLocalReviewRequest(
  job: JobRecord,
  options: LocalRequestOptions,
): LocalReviewRequest {
  let input;
  try {
    input = toReviewInput(job);
  } catch (error) {
    // A malformed submission is a typed failure, never a review of nothing.
    throw new LocalEngineError(
      "invalid_review_request",
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    url: input.url,
    routes: input.captureContext.routes,
    viewports: input.captureContext.viewports,
    darkMode: input.captureContext.darkMode,
    isFork: input.captureContext.isFork,
    installationId: input.captureContext.installationId,
    depth: input.depth,
    context: mergeContext(input.context, options.repoContext),
    ...(options.genome ? { genome: options.genome } : {}),
    ...(input.previewBuildFacts ? { previewBuildFacts: input.previewBuildFacts } : {}),
    // Everything `toReviewInput` decided BEFORE the review ran has to survive
    // this projection or the local path silently reviews a different request
    // than the production one. `notReviewed` was already declared on
    // `LocalReviewRequest` and was never forwarded; nothing populated it until
    // the route cap did, and the first thing it carried would have been lost.
    ...(input.notReviewed ? { notReviewed: input.notReviewed } : {}),
    ...(input.requestedRoutes ? { requestedRoutes: input.requestedRoutes } : {}),
    // The operator's `--verify-stability` and the request's own ask are the
    // same instruction, so either one turns the check on for this job: a server
    // started with the flag runs it on everything, and a caller that asked for
    // it on one review gets it on that review from a server started without.
    // Neither can switch the other OFF, because "do not verify" is not
    // something either side is trying to say.
    ...(options.verifyStability === true || input.captureContext.verifyStability === true
      ? { verifyStability: true }
      : options.verifyStability !== undefined
        ? { verifyStability: options.verifyStability }
        : {}),
    screenshotRetentionSeconds: options.screenshotRetentionSeconds ?? 0,
    keyPrefix: options.keyPrefix,
  };
}
