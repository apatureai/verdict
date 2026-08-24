import type { Finding } from "@apatureai/verdict-types";

/**
 * Trust-budget post-filter (TRD §6.5, #33). After the hallucination gate (#32):
 *   1. drop findings below the promoted report's calibrated confidence floor,
 *   2. dedupe by `elementRef` + `dimension` across viewports (the same issue seen
 *      on mobile and desktop is one finding, using calibrated confidence only),
 *   3. cap at 1 blocker + 6 other findings, with deterministic ordering, so the
 *      reviewer's trust budget isn't blown by a wall of low-value nits.
 */
export interface PostFilterOptions {
  minConfidence?: number;
  maxBlockers?: number;
  maxOthers?: number;
  /** Confidence may influence ordering/dedupe only after calibration. */
  useConfidence?: boolean;
}

const SEVERITY_RANK: Record<Finding["severity"], number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

/** Stable ordering: severity, then confidence desc, then route/dimension for determinism. */
function compareFindings(a: Finding, b: Finding, useConfidence: boolean): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (useConfidence ? b.confidence - a.confidence : 0) ||
    a.route.localeCompare(b.route) ||
    a.dimension.localeCompare(b.dimension) ||
    (a.elementRef ?? "").localeCompare(b.elementRef ?? "")
  );
}

export function postFilter(findings: Finding[], options: PostFilterOptions = {}): Finding[] {
  // No raw-confidence floor exists. Serving supplies the promoted report's
  // threshold; absent calibration stays advisory without ranking on raw scores.
  const minConfidence = options.minConfidence ?? Number.NEGATIVE_INFINITY;
  const maxBlockers = options.maxBlockers ?? 1;
  const maxOthers = options.maxOthers ?? 6;
  const useConfidence = options.useConfidence ?? false;

  // 1. report-owned calibrated confidence floor (disabled without a binding)
  const confident = findings.filter((f) => f.confidence >= minConfidence);

  // 2. dedupe by elementRef + dimension. Findings are sorted best-first by
  // compareFindings (severity, THEN confidence), so the first finding per key is
  // the one to keep. Keeping the first (rather than replacing on raw confidence)
  // is load-bearing: an explicit `f.confidence > existing.confidence` swap would
  // downgrade a higher-severity finding (e.g. a mobile `blocker`) to a lower-
  // severity but higher-confidence one (a desktop `minor`) sharing the same
  // element+dimension, silently dropping the blocker. Confidence still breaks ties
  // WITHIN a severity via the sort.
  const best = new Map<string, Finding>();
  for (const f of [...confident].sort((a, b) => compareFindings(a, b, useConfidence))) {
    const key = `${f.dimension}|${f.elementRef ?? ""}`;
    if (!best.has(key)) best.set(key, f);
  }
  const deduped = [...best.values()].sort((a, b) => compareFindings(a, b, useConfidence));

  // 3. cap: 1 blocker + 6 others, deterministic.
  const blockers = deduped.filter((f) => f.severity === "blocker").slice(0, maxBlockers);
  const others = deduped.filter((f) => f.severity !== "blocker").slice(0, maxOthers);
  return [...blockers, ...others].sort((a, b) => compareFindings(a, b, useConfidence));
}
