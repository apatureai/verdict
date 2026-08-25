import type { Dimension, Grade } from "@apatureai/verdict-types";
import { findingKey, type LabeledFinding } from "./golden-set.js";
import { mulberry32 } from "./rng.js";

/**
 * Eval metrics suite (TRD §10, #46). Per-dimension precision/recall over the
 * golden set, the headline **blocker recall** (did we catch the serious ones?)
 * and the trust metric **nit precision** (are our nits real?), plus
 * **quadratic-weighted kappa** with bootstrapped CIs for inter-rater / model-vs-
 * human grade agreement. Pure stats, no model calls.
 */
export interface PrecisionRecall {
  precision: number;
  recall: number;
  tp: number;
  fp: number;
  fn: number;
}

function prFromCounts(tp: number, fp: number, fn: number): PrecisionRecall {
  return {
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    tp,
    fp,
    fn,
  };
}

/** Detection precision/recall by matching findings on dimension+route+elementRef. */
export function precisionRecall(predicted: LabeledFinding[], truth: LabeledFinding[]): PrecisionRecall {
  const predKeys = new Set(predicted.map(findingKey));
  const truthKeys = new Set(truth.map(findingKey));
  let tp = 0;
  for (const k of predKeys) if (truthKeys.has(k)) tp++;
  return prFromCounts(tp, predKeys.size - tp, truthKeys.size - tp);
}

/** Precision/recall per rubric dimension. */
export function perDimensionPR(
  predicted: LabeledFinding[],
  truth: LabeledFinding[],
): Partial<Record<Dimension, PrecisionRecall>> {
  const dims = new Set<Dimension>([...predicted, ...truth].map((f) => f.dimension));
  const out: Partial<Record<Dimension, PrecisionRecall>> = {};
  for (const dim of dims) {
    out[dim] = precisionRecall(
      predicted.filter((f) => f.dimension === dim),
      truth.filter((f) => f.dimension === dim),
    );
  }
  return out;
}

/** Headline metric: recall over ground-truth blocker findings. */
export function blockerRecall(predicted: LabeledFinding[], truth: LabeledFinding[]): number {
  const blockers = truth.filter((f) => f.severity === "blocker");
  if (blockers.length === 0) return 1; // vacuous
  const predKeys = new Set(predicted.map(findingKey));
  const caught = blockers.filter((f) => predKeys.has(findingKey(f))).length;
  return caught / blockers.length;
}

/** Trust metric: precision over predicted nit findings (are our nits real?). */
export function nitPrecision(predicted: LabeledFinding[], truth: LabeledFinding[]): number {
  const nits = predicted.filter((f) => f.severity === "nit");
  if (nits.length === 0) return 1; // vacuously precise
  const truthKeys = new Set(truth.map(findingKey));
  return nits.filter((f) => truthKeys.has(findingKey(f))).length / nits.length;
}

/**
 * A minimal, structurally-compatible view of the critique package's `FactLedger`
 * (judge-unlock §4.1), kept here so the eval boundary depends only on `types`. A
 * real `FactLedger` is assignable: its entries carry these fields and more.
 */
export interface NetNewLedgerEntry {
  claimClass: string;
  route: string;
  selector: string;
  reported: boolean;
}
export interface NetNewLedger {
  entries: NetNewLedgerEntry[];
}

/** Dimension → the deterministic claim class it restates, when it restates one. */
const DIMENSION_TO_CLAIM: Partial<Record<Dimension, string>> = {
  color_contrast: "contrast",
  responsiveness: "element_overflow",
  accessibility: "target_size",
};

/** The page-level claim class keyed to the reserved `document` selector (judge-unlock §4.1). */
const PAGE_OVERFLOW_CLASS = "page_overflow";

/** Absolute net-new count: published findings that made a claim no reported measurement covers. */
export function netNewFindingCount(published: LabeledFinding[], ledger: NetNewLedger): number {
  const reported = new Map<string, Set<string>>();
  const pageOverflowRoutes = new Set<string>();
  for (const e of ledger.entries) {
    if (!e.reported) continue;
    if (e.claimClass === PAGE_OVERFLOW_CLASS) pageOverflowRoutes.add(e.route);
    const key = `${e.route}\n${e.selector}`;
    let set = reported.get(key);
    if (!set) {
      set = new Set<string>();
      reported.set(key, set);
    }
    set.add(e.claimClass);
  }
  let netNew = 0;
  for (const f of published) {
    const cls = DIMENSION_TO_CLAIM[f.dimension];
    const classes = reported.get(`${f.route}\n${f.elementRef ?? ""}`);
    const restatesElement = cls !== undefined && classes !== undefined && classes.has(cls);
    // Page-overflow paraphrase leak (C4). `page_overflow` is keyed to the reserved
    // `document` selector, so a reworded page-overflow claim pinned to the WIDEST
    // ELEMENT (elementRef != "document") slipped past the element-keyed check and
    // was miscounted as net-new. A page-overflow measurement is PAGE-LEVEL: any
    // overflow-dimension finding on that route restates it, UNLESS the finding's own
    // element carries its OWN distinct element_overflow measurement (handled above,
    // which is a genuinely different, per-element fact).
    const restatesPage =
      cls === "element_overflow" && pageOverflowRoutes.has(f.route) && !restatesElement;
    if (!(restatesElement || restatesPage)) netNew += 1;
  }
  return netNew;
}

/**
 * The NORTH STAR (judge-unlock §4.4): the share of published findings that made a
 * claim no deterministic check had already REPORTED. A finding is a restatement
 * when its dimension maps to a claim class the checker already reported on the
 * same element+route (or, for page-level overflow, anywhere on the route);
 * everything else is net-new. Pure, no model, no GPU — so the number is trackable
 * in CI.
 *
 * The empty case is NOT vacuously 1 (C4). The old `if (published.length === 0)
 * return 1` let a judge that publishes NOTHING — the precise failure this metric
 * exists to catch — score a perfect 1.0 and pass the release gate. Zero published
 * findings is scored by the `measuredFactsCount`: a genuinely CLEAN page (the
 * checker measured nothing, so there was nothing for judgment to be net-new
 * against) is a vacuous pass (1); an EMPTY JUDGE (the checker measured facts on a
 * non-trivial page and the judge still added nothing) scores 0 and fails the gate.
 * The absolute net-new COUNT (`netNewFindingCount`) is the gate's second, rate-
 * independent guard (`netNewFindingsMin`).
 *
 * `duplicateFactDrops === 0` is deliberately NOT a pass condition anywhere: a
 * model that never restates and a model that stopped restating because the prompt
 * worked look identical there. The gate is on the NUMERATOR.
 */
export function netNewFindingRate(
  published: LabeledFinding[],
  ledger: NetNewLedger,
  measuredFactsCount: number = ledger.entries.length,
): number {
  if (published.length === 0) return measuredFactsCount === 0 ? 1 : 0;
  return netNewFindingCount(published, ledger) / published.length;
}

export const GRADE_SCALE: Grade[] = ["ship", "ship_with_nits", "needs_work", "blocked"];

/** Quadratic-weighted Cohen's kappa over the 4-level ordinal grade scale. */
export function quadraticWeightedKappa(a: Grade[], b: Grade[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error("kappa needs equal, non-empty grade arrays");
  const k = GRADE_SCALE.length;
  const idx = (g: Grade): number => GRADE_SCALE.indexOf(g);

  const observed: number[][] = Array.from({ length: k }, () => Array<number>(k).fill(0));
  const rowMarg = Array<number>(k).fill(0);
  const colMarg = Array<number>(k).fill(0);
  for (let n = 0; n < a.length; n++) {
    const i = idx(a[n] as Grade);
    const j = idx(b[n] as Grade);
    const row = observed[i] as number[];
    row[j] = (row[j] ?? 0) + 1;
    rowMarg[i] = (rowMarg[i] ?? 0) + 1;
    colMarg[j] = (colMarg[j] ?? 0) + 1;
  }

  const total = a.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = ((i - j) * (i - j)) / ((k - 1) * (k - 1));
      const expected = ((rowMarg[i] ?? 0) * (colMarg[j] ?? 0)) / total;
      numerator += w * ((observed[i] as number[])[j] ?? 0);
      denominator += w * expected;
    }
  }
  if (denominator === 0) return 1; // no expected disagreement -> perfect by convention
  return 1 - numerator / denominator;
}

export interface KappaCI {
  kappa: number;
  lower: number;
  upper: number;
}

export interface BootstrapOptions {
  iterations?: number;
  /** Two-sided alpha (default 0.05 -> 95% CI). */
  alpha?: number;
  seed?: number;
}

/** Quadratic-weighted kappa with a bootstrapped percentile CI (seeded, deterministic). */
export function bootstrapKappaCI(a: Grade[], b: Grade[], options: BootstrapOptions = {}): KappaCI {
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const rng = mulberry32(options.seed ?? 1);
  const n = a.length;

  const samples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const ra: Grade[] = [];
    const rb: Grade[] = [];
    for (let i = 0; i < n; i++) {
      const pick = Math.floor(rng() * n);
      ra.push(a[pick] as Grade);
      rb.push(b[pick] as Grade);
    }
    const value = quadraticWeightedKappa(ra, rb);
    if (Number.isFinite(value)) samples.push(value);
  }
  samples.sort((x, y) => x - y);
  const at = (q: number): number => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))] ?? 0;
  return { kappa: quadraticWeightedKappa(a, b), lower: at(alpha / 2), upper: at(1 - alpha / 2) };
}

/**
 * Multi-rater agreement coefficients (#84). Quadratic-weighted Cohen's kappa
 * (above) is strictly pairwise and prevalence-sensitive: on our heavily
 * `ship`-skewed grade distribution with 2-3 golden-set raters (#45) it can read
 * misleadingly low (the "kappa paradox") and miss raters/missing labels. These
 * add two coefficients better matched to the setup, both pure stats in the eval
 * boundary, additive to #46:
 *   - Krippendorff's alpha (ordinal/nominal/interval): native ≥2 raters +
 *     missing data, via the coincidence matrix.
 *   - Gwet's AC2 (ordinal weights): chance-correction robust to skewed marginals.
 * Read the HEADLINE agreement from AC2/alpha on skewed sets; keep weighted kappa
 * for continuity. (Sources: arXiv:2603.06865; Gwet 2014; K-Alpha, PMC 2024.)
 *
 * Ratings matrix: one row per unit/item, one column per rater; categories are
 * 0-based ordinal indices (map grades via `GRADE_SCALE.indexOf`); `null` = a
 * missing rating. Units with fewer than two present ratings are ignored.
 */
export type RatingsMatrix = ReadonlyArray<ReadonlyArray<number | null>>;
export type AgreementMetric = "ordinal" | "nominal" | "interval";
export type AgreementWeights = "quadratic" | "linear" | "identity";

export interface AgreementOptions {
  /** Number of ordinal categories; inferred from the data (max index + 1) if omitted. */
  categories?: number;
}

function categoryCount(ratings: RatingsMatrix, options: AgreementOptions): number {
  if (options.categories !== undefined) return options.categories;
  let max = -1;
  for (const row of ratings) for (const v of row) if (v !== null && v > max) max = v;
  return max + 1;
}

/** Per-unit category counts (only units with >= 2 present ratings). */
function unitCounts(ratings: RatingsMatrix, q: number): Array<{ counts: number[]; total: number }> {
  const units: Array<{ counts: number[]; total: number }> = [];
  for (const row of ratings) {
    const counts = Array<number>(q).fill(0);
    let total = 0;
    for (const v of row) {
      if (v === null) continue;
      if (v < 0 || v >= q) throw new Error(`rating ${v} out of range [0, ${q})`);
      counts[v] = (counts[v] ?? 0) + 1;
      total++;
    }
    if (total >= 2) units.push({ counts, total });
  }
  return units;
}

/**
 * Krippendorff's alpha over an ordinal (default), nominal, or interval scale.
 * Handles >= 2 raters and missing labels natively via the coincidence matrix.
 */
export function krippendorffAlpha(
  ratings: RatingsMatrix,
  metric: AgreementMetric = "ordinal",
  options: AgreementOptions = {},
): number {
  const q = categoryCount(ratings, options);
  if (q < 1) throw new Error("krippendorffAlpha needs at least one category");
  const units = unitCounts(ratings, q);
  if (units.length === 0) throw new Error("krippendorffAlpha needs a unit with >= 2 ratings");

  const o: number[][] = Array.from({ length: q }, () => Array<number>(q).fill(0));
  for (const { counts, total } of units) {
    for (let c = 0; c < q; c++) {
      const row = o[c] as number[];
      for (let k = 0; k < q; k++) {
        const pairs = c === k ? (counts[c] ?? 0) * ((counts[c] ?? 0) - 1) : (counts[c] ?? 0) * (counts[k] ?? 0);
        row[k] = (row[k] ?? 0) + pairs / (total - 1);
      }
    }
  }
  const marg = o.map((row) => row.reduce((a, b) => a + b, 0));
  const n = marg.reduce((a, b) => a + b, 0);

  const delta2 = (c: number, k: number): number => {
    if (c === k) return 0;
    if (metric === "nominal") return 1;
    if (metric === "interval") return (c - k) * (c - k);
    const lo = Math.min(c, k);
    const hi = Math.max(c, k);
    let sum = 0;
    for (let g = lo; g <= hi; g++) sum += marg[g] ?? 0;
    const d = sum - ((marg[lo] ?? 0) + (marg[hi] ?? 0)) / 2;
    return d * d;
  };

  let obs = 0;
  let exp = 0;
  for (let c = 0; c < q; c++) {
    for (let k = 0; k < q; k++) {
      const d = delta2(c, k);
      obs += ((o[c] as number[])[k] ?? 0) * d;
      exp += (marg[c] ?? 0) * (marg[k] ?? 0) * d;
    }
  }
  if (exp === 0) return 1; // no expected disagreement -> perfect by convention
  return 1 - ((n - 1) * obs) / exp;
}

function agreementWeight(k: number, l: number, q: number, weights: AgreementWeights): number {
  if (weights === "identity") return k === l ? 1 : 0;
  if (q < 2) return 1;
  const d = Math.abs(k - l);
  if (weights === "linear") return 1 - d / (q - 1);
  return 1 - (d * d) / ((q - 1) * (q - 1));
}

/**
 * Gwet's AC2 with ordinal agreement weights (quadratic by default). Robust to
 * skewed/prevalence-imbalanced category distributions; with identity weights it
 * reduces to Gwet's AC1.
 */
export function gwetAC2(
  ratings: RatingsMatrix,
  weights: AgreementWeights = "quadratic",
  options: AgreementOptions = {},
): number {
  const q = categoryCount(ratings, options);
  if (q < 2) return 1; // a single category -> everyone agrees
  const units = unitCounts(ratings, q);
  if (units.length === 0) throw new Error("gwetAC2 needs a unit with >= 2 ratings");

  let pa = 0;
  for (const { counts, total } of units) {
    let agree = 0;
    for (let k = 0; k < q; k++) {
      for (let l = 0; l < q; l++) {
        agree += agreementWeight(k, l, q, weights) * (counts[k] ?? 0) * (counts[l] ?? 0);
      }
    }
    agree -= total; // remove self-pairs (w_kk = 1)
    pa += agree / (total * (total - 1));
  }
  pa /= units.length;

  const pi = Array<number>(q).fill(0);
  for (const { counts, total } of units) {
    for (let k = 0; k < q; k++) pi[k] = (pi[k] ?? 0) + (counts[k] ?? 0) / total;
  }
  for (let k = 0; k < q; k++) pi[k] = (pi[k] ?? 0) / units.length;

  let tw = 0;
  for (let k = 0; k < q; k++) for (let l = 0; l < q; l++) tw += agreementWeight(k, l, q, weights);
  let sumPi = 0;
  for (let k = 0; k < q; k++) sumPi += (pi[k] ?? 0) * (1 - (pi[k] ?? 0));
  const pe = (tw / (q * (q - 1))) * sumPi;
  if (1 - pe === 0) return 1;
  return (pa - pe) / (1 - pe);
}

/** Map a matrix of grades (per unit, per rater; null = missing) to ordinal indices. */
export function gradeRatingsMatrix(rows: ReadonlyArray<ReadonlyArray<Grade | null>>): Array<Array<number | null>> {
  return rows.map((row) => row.map((g) => (g === null ? null : GRADE_SCALE.indexOf(g))));
}

export interface AgreementCI {
  value: number;
  lower: number;
  upper: number;
}

/**
 * Seeded bootstrap percentile CI for any matrix-based agreement estimator,
 * resampling UNITS (rows) with replacement. Reuses the #46 mulberry32 seed.
 */
export function bootstrapAgreementCI(
  ratings: RatingsMatrix,
  estimator: (m: RatingsMatrix) => number,
  options: BootstrapOptions = {},
): AgreementCI {
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const rng = mulberry32(options.seed ?? 1);
  const n = ratings.length;
  const samples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const resampled: ReadonlyArray<number | null>[] = [];
    for (let i = 0; i < n; i++) resampled.push(ratings[Math.floor(rng() * n)] ?? []);
    try {
      const v = estimator(resampled);
      if (Number.isFinite(v)) samples.push(v);
    } catch {
      // degenerate resample (e.g. no usable unit) -> skip
    }
  }
  samples.sort((x, y) => x - y);
  const at = (qf: number): number =>
    samples[Math.min(samples.length - 1, Math.max(0, Math.floor(qf * samples.length)))] ?? 0;
  return { value: estimator(ratings), lower: at(alpha / 2), upper: at(1 - alpha / 2) };
}
