import type { Dimension, Finding, WithheldFindings } from "@apatureai/verdict-types";

/**
 * Trust-budget post-filter (TRD §6.5, #33). After the hallucination gate (#32):
 *   1. drop findings below the promoted report's calibrated confidence floor,
 *   2. dedupe by `elementRef` + `dimension` across viewports (the same issue seen
 *      on mobile and desktop is one finding, using calibrated confidence only),
 *   3. cap at 1 blocker + N other findings, with deterministic ordering, so the
 *      reviewer's trust budget isn't blown by a wall of low-value nits.
 *
 * The cap is now DELIBERATE and DISCLOSED (F3). Two changes over the historic
 * `.slice(0, maxOthers)`:
 *   - Selection reserves one slot per rubric DIMENSION before any dimension gets a
 *     second, so a single dimension's minors can never crowd every other dimension
 *     out of the budget entirely (the field failure: five off-8px-scale spacing
 *     nits filled the budget and silently deleted every non-spacing finding).
 *   - Whatever the cap removes is RETURNED as `withheld`, not dropped in silence,
 *     so the result can disclose how many findings — and in which dimensions — it
 *     is not showing. Silently dropping findings contradicts the product's honesty
 *     thesis; the cap still protects the trust budget, it just says what it cost.
 */
export interface PostFilterOptions {
  minConfidence?: number;
  maxBlockers?: number;
  maxOthers?: number;
  /** Confidence may influence ordering/dedupe only after calibration. */
  useConfidence?: boolean;
}

export interface PostFilterResult {
  /** The findings that fit the cap, in deterministic display order. */
  findings: Finding[];
  /** What the cap withheld, for disclosure (never silently dropped). */
  withheld: WithheldFindings;
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

/**
 * Choose up to `max` of the non-blocker findings, DELIBERATELY: every dimension
 * that has a finding gets its best one reserved first (in dimension-severity
 * order), and only then are the remaining slots filled by global severity order.
 * This guarantees no dimension is crowded out ENTIRELY by another dimension's
 * lower-severity findings, while a higher-severity finding is never dropped for a
 * lower-severity one except to make that one-per-dimension guarantee.
 */
function selectAcrossDimensions(others: Finding[], max: number, useConfidence: boolean): Finding[] {
  if (max <= 0) return [];
  const groups = new Map<Dimension, Finding[]>();
  for (const f of others) {
    let group = groups.get(f.dimension);
    if (!group) {
      group = [];
      groups.set(f.dimension, group);
    }
    group.push(f);
  }
  // `others` is already best-first, so each group's [0] is that dimension's best.
  const orderedGroups = [...groups.values()].sort((a, b) =>
    compareFindings(a[0] as Finding, b[0] as Finding, useConfidence),
  );
  const selected = new Set<Finding>();
  // Phase 1: reserve one slot per dimension (its best), most-severe dimension first.
  for (const group of orderedGroups) {
    if (selected.size >= max) break;
    selected.add(group[0] as Finding);
  }
  // Phase 2: fill the remaining slots by global severity order.
  for (const f of others) {
    if (selected.size >= max) break;
    selected.add(f);
  }
  return [...selected];
}

/** Summarise the withheld findings for disclosure: total + per-dimension, dimension-sorted. */
function summariseWithheld(withheld: Finding[]): WithheldFindings {
  const byDim = new Map<Dimension, number>();
  for (const f of withheld) byDim.set(f.dimension, (byDim.get(f.dimension) ?? 0) + 1);
  const byDimension = [...byDim.entries()]
    .map(([dimension, count]) => ({ dimension, count }))
    .sort((a, b) => a.dimension.localeCompare(b.dimension));
  return { total: withheld.length, byDimension };
}

export function postFilter(findings: Finding[], options: PostFilterOptions = {}): PostFilterResult {
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

  // 3. cap: 1 blocker + N others, deliberate and disclosed.
  const blockers = deduped.filter((f) => f.severity === "blocker");
  const others = deduped.filter((f) => f.severity !== "blocker");
  const keptBlockers = blockers.slice(0, maxBlockers);
  const keptOthers = selectAcrossDimensions(others, maxOthers, useConfidence);

  const keptSet = new Set<Finding>([...keptBlockers, ...keptOthers]);
  const withheld = summariseWithheld(deduped.filter((f) => !keptSet.has(f)));

  return {
    findings: [...keptBlockers, ...keptOthers].sort((a, b) => compareFindings(a, b, useConfidence)),
    withheld,
  };
}
