import type {
  CalibrationRuntimeBinding,
  ConfidenceUnavailableReason,
  Critique,
  Finding,
} from "@apatureai/verdict-types";
import { ENGINE_VERSION, PROMPT_VERSION, RUBRIC_VERSION } from "./critique.js";
import type { DeepPassRouteResult } from "./deep-pass.js";
import type { FactLedger } from "./fact-ledger.js";
import { worstGrade } from "./grade.js";
import type { CapturedShot } from "./hallucination-gate.js";
import { reconcileNarrative } from "./narrative.js";
import { buildResultMetadata } from "./version-stamp.js";
import { runValidationTail } from "./validation-tail.js";

/**
 * Assemble per-route deep-pass outputs (#29) into ONE final `Critique`. The deep
 * pass runs once per route and returns a `CritiqueOutput | null` per route; but
 * the validation tail must run ONCE, GLOBALLY over the merged findings:
 *   - hallucination gate (#32) against the reviewed `(route, viewport)` shots + geometry,
 *   - confidence ceiling (#70) when the capture was unstable,
 *   - post-filter (#33): confidence floor + dedupe across viewports + the
 *     global cap (1 blocker + 6), which is meaningless per-route,
 *   - version stamp (#68).
 * Without this, nothing turned `runDeepPass` results into a wire-ready Critique
 * (the cross-route cap/dedupe/gate were never applied). `critique()` does this
 * tail for its single stub pass; this is the multi-route equivalent.
 *
 * Pure. A route whose coercion failed (`output: null`, no partial #31) contributes
 * no findings and is recorded in `notReviewed`.
 */
export interface AssembleCritiqueDeps {
  /** Every reviewed `(route, viewport)` shot; the hallucination gate drops findings off these (#32). */
  capturedShots: CapturedShot[];
  /** Valid elementRef selectors from the geometry map (#18) for the element_ref drop (#32). */
  geometrySelectors?: Iterable<string>;
  /** Confidence ceiling when the capture was visually unstable (#15/#70). */
  captureUnstable?: boolean;
  /** Eval-owned, already validated promoted calibration binding (#160). */
  calibration?: CalibrationRuntimeBinding;
  confidenceUnavailableReason?: ConfidenceUnavailableReason;
  /**
   * Deterministic fact ledger (judge-unlock §4). Built ONCE by the orchestrator
   * from the same `DeterministicFinding[]` that drives the prompt, and passed
   * here to run the duplicate-of-measurement gate. Absent ⇒ gate is a no-op.
   */
  factLedger?: FactLedger;
  /** Engine-side not-reviewed reasons (fork skip, off-domain, capture failures) to carry through. */
  notReviewed?: string[];
  /** Resolved per-pass model id for the stamp (#26/#68). */
  model: string;
  engineVersion?: string;
  promptVersion?: string;
  captureVersion: string;
  uiDnaVersion: string | null;
}

export function assembleCritique(routes: DeepPassRouteResult[], deps: AssembleCritiqueDeps): Critique {
  const valid = routes.filter((r): r is DeepPassRouteResult & { output: NonNullable<DeepPassRouteResult["output"]> } => r.output !== null);

  const merged: Finding[] = valid.flatMap((r) => r.output.findings as Finding[]);

  // Findings recovered via salvage (step-1 output published after coercion failed).
  // The explicit provenance marker so a recovered pass is never silent (#29/#31).
  const salvagedFindings = valid
    .filter((r) => r.salvaged === true)
    .reduce((sum, r) => sum + r.output.findings.length, 0);

  const engineVersion = deps.engineVersion ?? ENGINE_VERSION;
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;

  // The global validation tail (#32/#70/#33/#106), shared with critique(). Runs
  // ONCE over the merged multi-route findings (the cross-route cap/dedupe/gate are
  // meaningless per-route). Model grade = the worst route grade, floored to what
  // the surviving findings support.
  const tail = runValidationTail({
    findings: merged,
    modelGrade: worstGrade(valid.map((r) => r.output.grade)),
    capturedShots: deps.capturedShots,
    geometrySelectors: deps.geometrySelectors,
    captureUnstable: deps.captureUnstable === true,
    calibration: deps.calibration,
    ...(deps.factLedger ? { factLedger: deps.factLedger } : {}),
    identity: {
      model: deps.model,
      promptVersion,
      engineVersion,
      captureVersion: deps.captureVersion,
      rubricVersion: RUBRIC_VERSION,
    },
  });
  const { findings, grade, blockingEnabled, calibration } = tail;
  // The narrative is settled against what survived the tail, not published
  // alongside it: the model wrote it before the grounding gate deleted anything,
  // and a paragraph describing findings this result does not contain is the same
  // result contradicting itself. See `reconcileNarrative`.
  const narrative = reconcileNarrative({
    overall: dedupeStrings(valid.map((r) => r.output.overall).filter((s) => s.trim().length > 0)).join(" "),
    modelFindingsSeen: merged.length,
    survivingFindings: findings.length,
    hallucinationDrops: tail.hallucinationDrops,
    ungroundedFindings: tail.ungroundedFindings,
    netNewFindings: tail.netNewFindings,
    duplicateFactDrops: tail.duplicateFactDrops,
    restatedFindings: tail.restatedFindings,
    withheldFindings: tail.withheldFindings,
  });

  const notReviewed = dedupeStrings([
    ...(deps.notReviewed ?? []),
    ...valid.flatMap((r) => r.output.notReviewed),
    ...routes.filter((r) => r.output === null).map((r) => `${r.route}: no valid critique`),
  ]);

  return {
    grade,
    overall: narrative.overall,
    ...(narrative.ungroundedNarrative !== undefined
      ? { ungroundedNarrative: narrative.ungroundedNarrative }
      : {}),
    findings,
    notReviewed,
    validation: {
      hallucinationDrops: tail.hallucinationDrops,
      captureUnstable: deps.captureUnstable === true,
      // What entered the tail, beside what came out of it. Same number the
      // narrative reconciliation above is given, so the prose and the wire
      // verdict cannot disagree about whether this run deleted everything.
      modelFindingsSeen: merged.length,
      ...(salvagedFindings > 0 ? { salvagedFindings } : {}),
      // Judge-unlock §4.4: the north-star counts, emitted only when the ledger
      // ran the duplicate gate (byte-identical otherwise).
      ...(deps.factLedger
        ? {
            duplicateFactDrops: tail.duplicateFactDrops,
            restatedFindings: tail.restatedFindings,
            netNewFindings: tail.netNewFindings,
          }
        : {}),
      // F3: what the trust-budget cap withheld, emitted only when it held
      // something back (byte-identical when it withheld nothing).
      ...(tail.withheldFindings.total > 0 ? { withheldFindings: tail.withheldFindings } : {}),
    },
    metadata: buildResultMetadata({
      engineVersion,
      model: deps.model,
      promptVersion,
      captureVersion: deps.captureVersion,
      uiDnaVersion: deps.uiDnaVersion,
    }),
    ...(calibration ? { calibration: calibration.reference } : {}),
    blockingEnabled,
    ...(!calibration
      ? {
          confidenceUnavailableReason:
            deps.calibration ? "mismatched_calibration_report" : deps.confidenceUnavailableReason ?? "missing_calibration_report",
        }
      : {}),
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
