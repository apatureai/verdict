/**
 * Cross-repo calibration contract (sigil#2). @apatureai/verdict-eval's ECE/Brier math is
 * the org's canonical calibration IP; the standalone assurance lane (sigil)
 * mirrors it rather than importing it (private repos, no registry; a literal
 * dependency would also complicate sigil's independence provenance). This
 * module renders deterministic golden vectors (LCG-generated calibration
 * pairs INCLUDING exact bin-boundary confidences, where implementations
 * diverge first) with this package's computed ECE/Brier/reliability outputs.
 *
 * The committed `fixtures/calibration-contract.golden.json` is the contract
 * artifact, the same discipline as the TS↔Python preference-schema seam
 * (#123) and the wire golden: a sync test here fails if this package's math
 * drifts from the committed file, and sigil's mirror test consumes a copy of
 * the file, so a deliberate change breaks BOTH repos' checks, which is the
 * point.
 */

import { brierScore, expectedCalibrationError, type CalibrationPair } from "./calibration.js";

export interface ContractVectorSpec {
  name: string;
  /** 32-bit LCG seed (numerical-recipes constants). */
  seed: number;
  count: number;
}

/** The specs are part of the contract: both repos regenerate pairs from them. */
export const CONTRACT_VECTORS: readonly ContractVectorSpec[] = [
  { name: "uniform-200", seed: 42, count: 200 },
  { name: "uniform-37", seed: 7, count: 37 },
  { name: "uniform-1000", seed: 20260710, count: 1000 },
];

/**
 * Deterministic pair generation, mirrored byte-for-byte in sigil's contract
 * test. Confidences are quantized to 1/40 steps so exact bin-edge values
 * (0.1, 0.3, 0.7, 1.0 at 10 bins) occur often: the FP-sensitive region where
 * a binning-convention drift shows up first. Integer math only until the
 * final division, so both repos generate identical inputs.
 */
export function contractPairs(spec: ContractVectorSpec): CalibrationPair[] {
  let s = spec.seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s;
  };
  const pairs: CalibrationPair[] = [];
  for (let i = 0; i < spec.count; i++) {
    const confidence = (next() % 41) / 40; // 0, 0.025, …, 1; hits every 10-bin edge
    const correct = next() % 1000 < confidence * 1000; // correlated outcome
    pairs.push({ confidence, correct });
  }
  return pairs;
}

/** Render the contract artifact (the exact bytes of the committed golden). */
export function renderCalibrationContract(): string {
  const bins = 10;
  const vectors = CONTRACT_VECTORS.map((spec) => {
    const pairs = contractPairs(spec);
    const report = expectedCalibrationError(pairs, bins);
    return {
      name: spec.name,
      seed: spec.seed,
      count: spec.count,
      bins,
      ece: report.ece,
      brier: brierScore(pairs),
      reliability: report.reliability,
    };
  });
  return `${JSON.stringify(
    {
      $comment:
        "Cross-repo calibration contract (@apatureai/verdict-eval is canonical; sigil mirrors — sigil#2). Regenerate: pnpm --filter @apatureai/verdict-eval gen:calibration-contract. Consumed by packages/eval tests here and by sigil's calibration-contract test.",
      vectors,
    },
    null,
    2,
  )}\n`;
}
