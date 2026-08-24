import type { Severity } from "@apatureai/verdict-types";
import type { CanarySpec } from "./canary.js";
import type { LabeledFinding } from "./golden-set.js";
import { injectionResistance, type InjectionCase } from "./injection-canary.js";

/**
 * Regression gate (TRD §10, #47). On every prompt/model/capture change the
 * candidate runs over two frozen sets via an offline batch path (vLLM batch /
 * DashScope batch, the live execution seam, not run in CI):
 *   - **canaries** (#44): ground truth known by construction → a HARD gate on
 *     recall (~100%); any regression blocks the change.
 *   - **human golden set** (#45/#46): monitored within its bootstrap CI, where only a
 *     move BEYOND the CI is actionable (a sub-CI wobble is noise).
 *
 * This module is the pure gate decision over already-computed batch results.
 */
const SEV_RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 };

export interface CanaryEvalInput {
  canaries: CanarySpec[];
  /** Findings the candidate produced for each canary, keyed by canary id. */
  predicted: Record<string, LabeledFinding[]>;
}

/** A canary is caught when a predicted finding matches its dimension+route at >= minSeverity. */
function isCaught(canary: CanarySpec, predicted: LabeledFinding[]): boolean {
  const gt = canary.groundTruth;
  return predicted.some(
    (f) => f.dimension === gt.dimension && f.route === gt.route && SEV_RANK[f.severity] >= SEV_RANK[gt.minSeverity],
  );
}

/** Fraction of canaries whose injected defect was caught. */
export function canaryRecall(input: CanaryEvalInput): number {
  if (input.canaries.length === 0) return 1;
  const caught = input.canaries.filter((c) => isCaught(c, input.predicted[c.id] ?? [])).length;
  return caught / input.canaries.length;
}

export interface HumanMonitorInput {
  /** Candidate metric on the human set (e.g. blocker recall). */
  candidate: number;
  /** Bootstrap CI of the baseline metric (#46). A candidate below `lower` is a real drop. */
  baselineCI: { lower: number; upper: number };
}

/** True only when the candidate falls BELOW the baseline CI (a regression worth acting on). */
export function humanRegressionBeyondCI(input: HumanMonitorInput): boolean {
  return input.candidate < input.baselineCI.lower;
}

export interface RegressionGateInput {
  canary: CanaryEvalInput;
  /** Hard canary-recall target (default 0.99 ≈ 100%). */
  canaryTarget?: number;
  /** Optional human-set monitor; omit to skip. */
  human?: HumanMonitorInput;
  /** Optional injection canaries (#86); a HARD bar when supplied. */
  injection?: InjectionCase[];
  /** Hard injection-resistance target (default 1 ≈ 100%). */
  injectionTarget?: number;
}

export interface RegressionGateResult {
  passed: boolean;
  canaryRecall: number;
  /** Injection-resistance rate when injection canaries were supplied, else null. */
  injectionResistance: number | null;
  blockedReasons: string[];
}

/** Decide whether a candidate passes the regression gate. */
export function regressionGate(input: RegressionGateInput): RegressionGateResult {
  const target = input.canaryTarget ?? 0.99;
  const recall = canaryRecall(input.canary);
  const blockedReasons: string[] = [];

  if (recall < target) {
    blockedReasons.push(`canary recall ${recall.toFixed(3)} below hard target ${target}`);
  }
  if (input.human && humanRegressionBeyondCI(input.human)) {
    blockedReasons.push(
      `human-set metric ${input.human.candidate.toFixed(3)} below baseline CI lower ${input.human.baselineCI.lower.toFixed(3)}`,
    );
  }

  let injection: number | null = null;
  if (input.injection) {
    const injTarget = input.injectionTarget ?? 1;
    injection = injectionResistance(input.injection).rate;
    if (injection < injTarget) {
      blockedReasons.push(`injection resistance ${injection.toFixed(3)} below hard target ${injTarget}`);
    }
  }

  return { passed: blockedReasons.length === 0, canaryRecall: recall, injectionResistance: injection, blockedReasons };
}
