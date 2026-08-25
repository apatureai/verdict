import type { Finding, Grade } from "@apatureai/verdict-types";
import type { DeterministicFinding } from "@apatureai/verdict-capture";
import { buildFactLedger } from "./fact-ledger.js";
import type { CapturedShot } from "./hallucination-gate.js";
import { runValidationTail } from "./validation-tail.js";

/**
 * Offline net-new evaluation harness (judge-unlock §6, requirement 4). Replays a
 * RECORDED model response (the findings a run produced) against a fixture page's
 * deterministic measurements and reports, with NO live model and NO GPU:
 *
 *   - raw findings the model produced,
 *   - gate drops by reason (hallucination vs duplicate-of-measurement),
 *   - findings demoted for restating a measurement,
 *   - survivors, and
 *   - NET-NEW survivors: findings that made a claim no deterministic check
 *     already reported — the north-star numerator.
 *
 * This is the metric instrument. It is a pure function over recorded data, so the
 * net-new number can be tracked in CI and a prompt regression that quietly
 * restores restatement is caught by a falling number rather than by a human
 * reading a review. It runs the SAME validation tail production runs, so what it
 * measures is what ships.
 */
export interface ReplayFixture {
  /** The `(route, viewport)` shots the fixture "captured"; findings off these are dropped. */
  capturedShots: CapturedShot[];
  /** The citable geometry selectors; a finding citing anything else is a hallucination. */
  geometrySelectors: Iterable<string>;
  /** The deterministic measurements (reported + declined) the checker produced. */
  deterministicFindings: DeterministicFinding[];
  /** The model's holistic grade, if the recording carried one (default `ship`). */
  modelGrade?: Grade;
}

export interface ReplayReport {
  /** Findings the model produced (entered the tail). */
  rawFindings: number;
  /** Dropped for citing an uncaptured shot or an unknown element_ref. */
  hallucinationDrops: number;
  /** Dropped for restating a measurement already reported. */
  duplicateFactDrops: number;
  /** Kept but demoted for restating a reported measurement (excluded from the grade). */
  restatedFindings: number;
  /** Findings published (grounded + ungrounded + restated). */
  survivors: number;
  /** Survivors that made a claim no deterministic check had already reported. */
  netNewFindings: number;
  /**
   * `netNewFindings / rawFindings`, the CI-trackable rate. 1 when the model
   * produced nothing (vacuously net-new — there was nothing to restate).
   */
  netNewFindingRate: number;
  /** The advisory grade the tail settled on. */
  grade: Grade;
  /** The surviving findings, for inspection. */
  survivorFindings: Finding[];
}

/** Replay recorded findings against a fixture and report the net-new breakdown. */
export function replayNetNew(findings: Finding[], fixture: ReplayFixture): ReplayReport {
  const factLedger = buildFactLedger(fixture.deterministicFindings);
  const tail = runValidationTail({
    findings,
    modelGrade: fixture.modelGrade ?? "ship",
    capturedShots: fixture.capturedShots,
    geometrySelectors: fixture.geometrySelectors,
    captureUnstable: false,
    factLedger,
    // No calibration: the harness is advisory, which is exactly the production
    // state right after a prompt version bump (§8). The gate decisions it
    // measures — hallucination and duplicate — do not depend on calibration.
    identity: {
      model: "offline-replay",
      promptVersion: "offline",
      engineVersion: "offline",
      captureVersion: "offline",
      rubricVersion: "offline",
    },
  });
  const rawFindings = findings.length;
  return {
    rawFindings,
    hallucinationDrops: tail.hallucinationDrops,
    duplicateFactDrops: tail.duplicateFactDrops,
    restatedFindings: tail.restatedFindings,
    survivors: tail.findings.length,
    netNewFindings: tail.netNewFindings,
    netNewFindingRate: rawFindings === 0 ? 1 : tail.netNewFindings / rawFindings,
    grade: tail.grade,
    survivorFindings: tail.findings,
  };
}
