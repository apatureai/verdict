import { noModelDisclosure, type EngineReviewResult, type JudgmentProvenance } from "@apatureai/verdict-types";
import type { ReportModelKind } from "./report.js";

/**
 * Whether anything judged the page, written into the result itself.
 *
 * Both local front doors run the same pipeline and both write the same
 * `review.json`, so both stamp the same fact the same way. The terminal report
 * already refuses to print a grade for a run no model looked at, but that is a
 * property of the terminal, not of the file: `out/review.json` and the body of
 * `GET /jobs/:id` outlive the run and get read by people and programs that
 * never saw the banner. So the statement travels in the payload, in the
 * vocabulary `apatureai/bastion` already stamps on the results it hands an
 * agent.
 *
 * The stamp describes the client THIS process chose. It is never taken from a
 * request, and there is no path that produces a result without one.
 */

/** `engine` value for a review produced by the terminal CLI. */
export const CLI_ENGINE_NAME = "verdict-cli";

/**
 * Only `live` means a model saw the page. `mock` and `canned` run the real
 * capture and the real measurements and then fill the critique from a
 * deterministic stand-in, which is `model_backed: false` rather than `null`:
 * this process picked that client itself and knows exactly what it did.
 */
export function localJudgmentProvenance(
  engine: string,
  kind: ReportModelKind,
  model: string | null,
): JudgmentProvenance {
  if (kind === "live") {
    return {
      model_backed: true,
      source: "model",
      engine,
      model,
      detail:
        "verdict ran this review with the live model client: Chromium captured the target and a " +
        "vision model judged the capture",
    };
  }
  return {
    model_backed: false,
    source: "canned",
    engine,
    model: null,
    detail:
      `verdict ran this review with the ${kind} client: the capture, the DOM geometry map and ` +
      "the measured contrast, overflow and touch-target facts are real, but the grade, the " +
      "narrative and any findings came from a deterministic stand-in rather than from a model",
  };
}

/**
 * Attach the stamp, and on an unjudged run put the same fact where a consumer
 * that reads only prose will still meet it: first in `notReviewed`, and in
 * `overall`, which is otherwise the stand-in's own narrative about a page it
 * never saw. The findings are left in place; the disclosure names them.
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
    overall: disclosure,
    notReviewed: [disclosure, ...result.notReviewed],
  };
}
