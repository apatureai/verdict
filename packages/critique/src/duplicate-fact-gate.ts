import type { Dimension, Finding } from "@apatureai/verdict-types";
import {
  literalKey,
  measurementLiterals,
  type ClaimClass,
  type FactLedger,
  type LedgerEntry,
} from "./fact-ledger.js";

/**
 * The duplicate-of-measurement gate (judge-unlock §4.2): a deterministic,
 * no-model-call invariant that drops or demotes a model finding whose substance
 * is a measurement the deterministic checker has ALREADY REPORTED. Without it a
 * restating model produces an invisibly worthless review that looks like a
 * working product; with it, restatement produces a visibly EMPTY review, and the
 * north-star metric (net-new accepted findings) cannot be gamed by paraphrase.
 *
 * The gate keys on the CLAIM CLASS, not on wording: a model cannot survive by
 * rephrasing "2.10:1 contrast" as "the nav text is hard to read against its
 * background" — both classify as `contrast`, and both are dropped on an element
 * the contrast check already reported. It cannot survive by changing the
 * `elementRef` either: a wrong ref is deleted by the hallucination gate, a right
 * ref on a reported class is dropped here. The only way through is to make a
 * claim the checker did not make. That is the intended incentive.
 *
 * Declined measurements (`reported: false`) NEVER suppress anything: a
 * WCAG-excused touch target is in the ledger for the prompt but not for the gate,
 * so a repo-rule finding on it is correctly counted as net-new.
 */

export type Novelty = "novel" | "duplicate_of_measurement" | "restates_measurement";

export interface DuplicateFactGateResult {
  /** Novel findings, in input order. These drive the grade and the trust budget. */
  findings: Finding[];
  /** Kept but demoted: ranked last, excluded from the grade and from netNew. */
  restatements: Finding[];
  /** Hard-dropped duplicates. */
  duplicateFactDrops: number;
}

/** Dimension → prior claim class (judge-unlock §4.2). */
const DIMENSION_PRIOR: Partial<Record<Dimension, ClaimClass>> = {
  color_contrast: "contrast",
  responsiveness: "element_overflow",
  accessibility: "target_size",
};

/** Lexical markers per claim class (judge-unlock §4.2). */
const MARKERS: Record<ClaimClass, RegExp[]> = {
  contrast: [/\bcontrast\b/, /\d+(\.\d+)?\s*:\s*1\b/, /wcag aa 4\.5/, /\bratio\b/],
  element_overflow: [
    /\boverflow(s|ing)?\b/,
    /content width \d+px/,
    /exceeds (its )?container/,
    /spills? (outside|past)/,
  ],
  page_overflow: [
    /document (scroll )?width/,
    /horizontal(ly)? scroll(s|ing)? the page/,
    /wider than the viewport/,
  ],
  target_size: [
    /touch target/,
    /target size/,
    /\b24\s*[x×]\s*24\b/,
    /\b44\s*[x×]\s*44\b/,
    /2\.5\.[58]/,
    /tap(pable)? area/,
  ],
};

const ALL_CLASSES: ClaimClass[] = ["contrast", "element_overflow", "page_overflow", "target_size"];

/**
 * The claim class a finding's OWN primary claim makes, or `null` when it is not
 * a measurement class (judge-unlock §4.2). Deterministic:
 *   1. the dimension prior;
 *   2. lexical markers on `title + " " + description` OVERRIDE the prior — the
 *      class with the most marker hits wins; a tie (or a competing prior) → null.
 */
export function classifyClaim(finding: Finding): ClaimClass | null {
  const text = `${finding.title} ${finding.description}`.toLowerCase();
  const counts = new Map<ClaimClass, number>();
  let anyHit = false;
  for (const cls of ALL_CLASSES) {
    let n = 0;
    for (const re of MARKERS[cls]) if (re.test(text)) n += 1;
    if (n > 0) {
      counts.set(cls, n);
      anyHit = true;
    }
  }
  if (anyHit) {
    let best: ClaimClass | null = null;
    let bestN = 0;
    let tie = false;
    for (const [cls, n] of counts) {
      if (n > bestN) {
        best = cls;
        bestN = n;
        tie = false;
      } else if (n === bestN) {
        tie = true;
      }
    }
    return tie ? null : best;
  }
  return DIMENSION_PRIOR[finding.dimension] ?? null;
}

/** Whether the finding's text shares a measurement literal with the reported entries for its element. */
function sharesMeasurementLiteral(finding: Finding, ledger: FactLedger): boolean {
  if (finding.elementRef === null) return false;
  const key = literalKey(finding.elementRef, finding.viewport);
  const reported = ledger.measurementLiterals.get(key);
  if (!reported || reported.size === 0) return false;
  const own = measurementLiterals(`${finding.title} ${finding.description}`);
  for (const lit of own) if (reported.has(lit)) return true;
  return false;
}

/** The REPORTED ledger entries that name this finding's element on its page. */
function reportedEntriesFor(finding: Finding, ledger: FactLedger): LedgerEntry[] {
  return ledger.entries.filter(
    (e) =>
      e.reported &&
      e.selector === finding.elementRef &&
      e.viewport === finding.viewport &&
      e.route === finding.route,
  );
}

/**
 * Classify one finding's novelty against the ledger (judge-unlock §4.2):
 *   - class matches a reported measurement on the same element → DROP (duplicate);
 *   - no class, but shares a measured literal on the same element → DEMOTE
 *     (restatement — the ambiguous branch demotes rather than drops, because
 *     publishing a demoted possibly-real finding is a smaller error than dropping
 *     one, and demotion still keeps the metric honest);
 *   - otherwise → KEEP (novel).
 */
export function classifyNovelty(finding: Finding, ledger: FactLedger): Novelty {
  const entries = reportedEntriesFor(finding, ledger);
  const cls = classifyClaim(finding);
  if (cls !== null && entries.some((e) => e.claimClass === cls)) {
    return "duplicate_of_measurement";
  }
  if (cls === null && sharesMeasurementLiteral(finding, ledger)) {
    return "restates_measurement";
  }
  return "novel";
}

export function duplicateFactGate(findings: Finding[], ledger: FactLedger): DuplicateFactGateResult {
  const kept: Finding[] = [];
  const restatements: Finding[] = [];
  let duplicateFactDrops = 0;
  for (const finding of findings) {
    switch (classifyNovelty(finding, ledger)) {
      case "duplicate_of_measurement":
        duplicateFactDrops += 1;
        break;
      case "restates_measurement":
        restatements.push(finding);
        break;
      case "novel":
        kept.push(finding);
        break;
    }
  }
  return { findings: kept, restatements, duplicateFactDrops };
}
