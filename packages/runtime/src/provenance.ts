import type {
  ModelCallOptions,
  ModelClient,
  ModelClientFactory,
  ModelRequest,
  ModelResponse,
} from "@apatureai/verdict-critique";
import {
  NO_MODEL_DISCLOSURE_PREFIX,
  noModelDisclosure,
  type EngineReviewResult,
  type JudgmentProvenance,
} from "@apatureai/verdict-types";

/**
 * Where the deployable composition states whether anything judged a page.
 *
 * `@apatureai/verdict-types` explains why the statement has to ride INSIDE the payload: a
 * caller of the HTTP job API never sees a terminal report, it sees one JSON
 * document and acts on it. Both local front doors have stamped it since the
 * provenance contract landed. This composition, the one behind the production
 * service, stamped nothing at all, so every result it published asserted a grade
 * with no in-band statement of what produced it. Downstream that is fail-safe
 * rather than dangerous, because Gate and Bastion both suppress a grade whose
 * provenance is missing, but it also meant this composition could never publish
 * a verdict a consumer would act on.
 *
 * The vocabulary is deliberately the one `@apatureai/verdict-serve` uses, down to the
 * `engine` value, because the two are the same wire surface: a signed job in,
 * one polled JSON result out. Provenance answers "what produced this judgment",
 * not "which deployment ran it", so a reader of either result reads one set of
 * words rather than two.
 *
 * What is NOT shared is where the answer comes from. `@apatureai/verdict-serve` chose its
 * own model client and can read the answer off that choice. This composition is
 * always configured with a real model backend, so configuration would answer
 * `model_backed: true` for every run including the ones where no model was ever
 * called: an empty capture short-circuits before triage, and a capture whose
 * images do not cover a requested route reaches the model with nothing to look
 * at. So the answer here is OBSERVED: the witness below wraps the model factory
 * the orchestrator is handed and records the calls that actually completed.
 */

/**
 * `engine` value for a review produced by the job API. Identical to
 * `@apatureai/verdict-serve`'s `LOCAL_ENGINE_NAME` on purpose (see above); the fields that
 * distinguish a run are `model` and `detail`.
 */
export const RUNTIME_ENGINE_NAME = "verdict-http";

/** A model factory that records what was actually asked of it. */
export interface JudgmentWitness {
  /** Hand this to the orchestrator in place of the configured factory. */
  factory: ModelClientFactory;
  /** What this process can prove about the calls that ran, as of now. */
  provenance(): JudgmentProvenance;
}

/**
 * Wrap a model factory so the result can state what happened rather than what
 * was configured.
 *
 * A call counts as a judgment of the page on exactly two conditions, both
 * checked here: it carried at least one image from the capture, and it
 * COMPLETED. A call carrying no images is a text-only step (DashScope's
 * two-step JSON coercion is one) and judged no pixels; a call that threw
 * produced no judgment to attest to. Anything left is a vision model that was
 * given a capture of the requested target and answered, which is exactly the
 * claim `model_backed: true` makes.
 *
 * The reported `model` is the id of the LAST such call. The passes run in order
 * (triage, then the deep pass over its suspects), so the last model to look at
 * the capture is the deepest one that ran, which is the judge a reader means.
 * A run that never got past triage reports the triage model, because that is
 * the model that actually looked.
 */
export function witnessModelCalls(factory: ModelClientFactory): JudgmentWitness {
  let judgedByModel: string | null = null;
  // Per model, not a single running total. Triage and the deep pass are usually
  // different models, and attributing every image-bearing call to whichever ran
  // last overstates what that model saw. This field exists to stop overclaiming,
  // so it must not overclaim.
  const imageCallsByModel = new Map<string, number>();
  let textOnlyCalls = 0;

  return {
    factory: (config) => {
      const client = factory(config);
      const observed: ModelClient = {
        backend: client.backend,
        async complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse> {
          const response = await client.complete(request, options);
          const sawImages = request.messages.some((message) => (message.images?.length ?? 0) > 0);
          if (sawImages) {
            imageCallsByModel.set(request.model, (imageCallsByModel.get(request.model) ?? 0) + 1);
            judgedByModel = request.model;
          } else {
            textOnlyCalls++;
          }
          return response;
        },
      };
      return observed;
    },
    provenance: () => {
      if (judgedByModel !== null) {
        return {
          model_backed: true,
          source: "model",
          engine: RUNTIME_ENGINE_NAME,
          model: judgedByModel,
          detail: (() => {
            const own = imageCallsByModel.get(judgedByModel) ?? 0;
            const others = [...imageCallsByModel]
              .filter(([model]) => model !== judgedByModel)
              .reduce((sum, [, count]) => sum + count, 0);
            const mine = `${judgedByModel} judged ${own} capture${own === 1 ? "" : "s"} of it`;
            const rest = others > 0 ? `, after ${others} earlier triage capture${others === 1 ? "" : "s"}` : "";
            return `verdict reviewed this page over the job API: the capture fleet rendered the target and ${mine}${rest}`;
          })(),
        };
      }
      return {
        model_backed: false,
        source: "canned",
        engine: RUNTIME_ENGINE_NAME,
        model: null,
        // Kept to a single clause: `noModelDisclosure` wraps it in the shared
        // sentence about what in a result is still real, and a detail that says
        // the same thing again reads as a stutter in the field a human greps.
        detail:
          "verdict called no vision model on a capture of this target" +
          (textOnlyCalls > 0
            ? `, only ${textOnlyCalls} text-only model call${textOnlyCalls === 1 ? "" : "s"} that saw no pixels`
            : ""),
      };
    },
  };
}

/**
 * Attach the stamp, and on an unjudged run put the same fact where a consumer
 * that reads only prose will still meet it.
 *
 * The `notReviewed` disclosure is the shared one, character for character, so a
 * reader and a delivery surface deduplicating on `NO_MODEL_DISCLOSURE_PREFIX`
 * see the same line from either surface.
 *
 * `overall` is where this deliberately diverges from `@apatureai/verdict-serve`. That
 * surface overwrites it because its unjudged path is the mock or canned client,
 * which writes a confident narrative about a page it never saw. The unjudged
 * path HERE is a run that reviewed nothing, and the wire projection has already
 * replaced `overall` with a more specific true sentence ("Nothing was reviewed:
 * 0 of N requested route(s) reached a judgment") and retracted the grade in
 * `gradeUnavailableReason`. Overwriting a precise statement with a general one
 * loses information, so the stamp leaves `overall` alone exactly when the result
 * has already retracted its own grade, and writes the disclosure there when it
 * has not.
 */
export function stampJudgmentProvenance(
  result: EngineReviewResult,
  provenance: JudgmentProvenance,
): EngineReviewResult {
  if (provenance.model_backed === true) return { ...result, provenance };
  const disclosure = noModelDisclosure(provenance);
  return {
    ...result,
    provenance,
    ...(result.gradeUnavailableReason === undefined ? { overall: disclosure } : {}),
    notReviewed: [disclosure, ...result.notReviewed],
  };
}

/** Refused publication: the result cannot say what produced it. */
export class UnattestedResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnattestedResultError";
  }
}

/**
 * Publication guard. Nothing leaves this composition without saying how it was
 * produced, so a future code path that forgets to stamp fails the attempt
 * loudly instead of publishing a grade of unknown origin. Same guard, same
 * refusal, as `@apatureai/verdict-serve`'s `assertAttested`.
 */
export function assertAttested(result: EngineReviewResult): EngineReviewResult {
  const provenance = result.provenance;
  if (!provenance || typeof provenance.model_backed === "undefined") {
    throw new UnattestedResultError(
      "a review reached publication with no judgment provenance; refusing to publish a grade of unknown origin",
    );
  }
  if (
    provenance.model_backed === false &&
    !result.notReviewed.some((line) => line.startsWith(NO_MODEL_DISCLOSURE_PREFIX))
  ) {
    throw new UnattestedResultError(
      "a result nothing judged reached publication without its notReviewed disclosure",
    );
  }
  return result;
}
