import type { Dimension, Grade, Severity } from "@apatureai/verdict-types";

/**
 * Golden-set labeling tooling (TRD §10, #45). The 150 human-labeled PR snapshots
 * are a data-collection task (needs the capture worker #11 to freeze snapshots),
 * but the LABELING MODEL is pure and is what the metrics suite (#46) consumes:
 * per-finding labels + a grade from each of 2-3 design-literate raters, with the
 * inter-rater data needed for quadratic-weighted kappa.
 */

/** A single labeled finding (the ground-truth shape; matches a predicted Finding by key). */
export interface LabeledFinding {
  dimension: Dimension;
  severity: Severity;
  route: string;
  elementRef: string | null;
}

/** One rater's labels for a case. */
export interface RaterLabel {
  raterId: string;
  grade: Grade;
  findings: LabeledFinding[];
}

export interface GoldenCase {
  /** PR snapshot id. */
  id: string;
  source: "own" | "oss";
  /** Object-storage ref to the frozen capture (#11 produces; ops). */
  captureRef?: string;
  labels: RaterLabel[];
}

export interface GoldenSet {
  cases: GoldenCase[];
}

/** Stable key for matching/deduping findings across raters and predictions. */
export function findingKey(f: LabeledFinding): string {
  return `${f.dimension}|${f.route}|${f.elementRef ?? ""}`;
}

/** A case is usable for inter-rater stats only with >=2 raters. */
export function isUsableForKappa(c: GoldenCase): boolean {
  return new Set(c.labels.map((l) => l.raterId)).size >= 2;
}

/**
 * Consensus ground-truth findings: those labeled by at least `minAgreement`
 * raters (default 2). The severity is the max any agreeing rater assigned.
 */
export function consensusFindings(c: GoldenCase, minAgreement = 2): LabeledFinding[] {
  const byKey = new Map<string, { finding: LabeledFinding; raters: Set<string>; severities: Severity[] }>();
  for (const label of c.labels) {
    for (const f of label.findings) {
      const key = findingKey(f);
      const entry = byKey.get(key) ?? { finding: f, raters: new Set(), severities: [] };
      entry.raters.add(label.raterId);
      entry.severities.push(f.severity);
      byKey.set(key, entry);
    }
  }
  const SEV_RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 };
  const out: LabeledFinding[] = [];
  for (const { finding, raters, severities } of byKey.values()) {
    if (raters.size >= minAgreement) {
      const maxSeverity = severities.reduce((a, b) => (SEV_RANK[b] > SEV_RANK[a] ? b : a));
      out.push({ ...finding, severity: maxSeverity });
    }
  }
  return out;
}

/** Per-case grade from each rater, in rater-id order (input to kappa #46). */
export function raterGrades(c: GoldenCase): Record<string, Grade> {
  const grades: Record<string, Grade> = {};
  for (const label of c.labels) grades[label.raterId] = label.grade;
  return grades;
}

/** Parse a serialized golden set (e.g. labeling-tool export). */
export function parseGoldenSet(json: string): GoldenSet {
  return JSON.parse(json) as GoldenSet;
}
