import type { Viewport } from "@apatureai/verdict-types";
import type { DeterministicFinding } from "@apatureai/verdict-capture";

/**
 * The fact ledger (judge-unlock §4.1): ONE structure built once from the same
 * `DeterministicFinding[]` that produces the prompt fact lines, feeding TWO
 * consumers — the prompt's "ALREADY REPORTED" / "MEASURED AND DECLINED" blocks,
 * and the duplicate-of-measurement gate. That single source is the "stated once,
 * enforced in code" property: when a new deterministic check lands, the ledger
 * grows, the model's out-of-scope block grows, and the gate starts suppressing
 * that class — automatically, in one edit.
 *
 * The ledger is deliberately NOT the wire measurement report: a declined
 * measurement (an exception applied) is in the ledger for the prompt but is
 * EXCLUDED from the gate's suppression, because a finding on a declined element
 * is exactly the net-new judgment the product exists to produce.
 */

/** What kind of claim a measurement or a finding makes about an element. */
export type ClaimClass = "contrast" | "element_overflow" | "page_overflow" | "target_size";

export interface LedgerEntry {
  claimClass: ClaimClass;
  route: string;
  viewport: Viewport;
  /** Selector the measurement is about; `"document"` for page_overflow. */
  selector: string;
  detail: string;
  /**
   * Whether the checker REPORTED this measurement (published to the reviewer) or
   * looked and DECLINED it (an exception applied). Only `reported: true` entries
   * suppress a model finding.
   */
  reported: boolean;
  /** Present when `reported === false`: the criterion/exception applied. */
  declineReason?: string;
}

export interface FactLedger {
  entries: LedgerEntry[];
  /**
   * Every measurement-shaped literal in the REPORTED entries, keyed per
   * (selector, viewport). Drives the demote branch of the duplicate gate.
   */
  measurementLiterals: Map<string, Set<string>>;
}

/** Map a deterministic check kind to the claim class it makes. */
export function claimClassOfKind(kind: DeterministicFinding["kind"]): ClaimClass {
  switch (kind) {
    case "contrast":
      return "contrast";
    case "overflow":
      return "element_overflow";
    case "page_overflow":
      return "page_overflow";
    case "touch_target":
      return "target_size";
  }
}

/** `(selector, viewport)` key for the literal index. */
export function literalKey(selector: string, viewport: Viewport): string {
  return JSON.stringify([selector, viewport]);
}

/**
 * Measurement-shaped literals in a detail string: only the tokens that can have
 * come from the fact block the engine supplied — contrast ratios, pixel counts,
 * and NxN pixel boxes.
 */
export function measurementLiterals(detail: string): Set<string> {
  const out = new Set<string>();
  const patterns = [/\d+(\.\d+)?\s*:\s*1/g, /\b\d+px\b/g, /\b\d+\s*[x×]\s*\d+\s*px?\b/g];
  for (const re of patterns) {
    for (const m of detail.matchAll(re)) out.add(m[0].replace(/\s+/g, "").toLowerCase());
  }
  return out;
}

/** Build the fact ledger from the deterministic findings (reported + declined). */
export function buildFactLedger(findings: readonly DeterministicFinding[]): FactLedger {
  const entries: LedgerEntry[] = [];
  const literals = new Map<string, Set<string>>();
  for (const f of findings) {
    const reported = f.reported !== false;
    entries.push({
      claimClass: claimClassOfKind(f.kind),
      route: f.route,
      viewport: f.viewport,
      selector: f.selector,
      detail: f.detail,
      reported,
      ...(f.declineReason !== undefined ? { declineReason: f.declineReason } : {}),
    });
    if (!reported) continue;
    const key = literalKey(f.selector, f.viewport);
    let set = literals.get(key);
    if (!set) {
      set = new Set<string>();
      literals.set(key, set);
    }
    for (const lit of measurementLiterals(f.detail)) set.add(lit);
  }
  return { entries, measurementLiterals: literals };
}

/** The prompt's "ALREADY REPORTED" lines for one route (judge-unlock §3.3). */
export function renderReportedFacts(ledger: FactLedger, route: string): string[] {
  return ledger.entries
    .filter((e) => e.reported && e.route === route)
    .map((e) => `- [${e.claimClass}] ${e.selector} (${e.viewport}): ${e.detail}`);
}

/** The prompt's "MEASURED AND DECLINED" lines for one route (judge-unlock §3.3). */
export function renderDeclinedFacts(ledger: FactLedger, route: string): string[] {
  return ledger.entries
    .filter((e) => !e.reported && e.route === route)
    .map(
      (e) =>
        `- [${e.claimClass}] ${e.selector} (${e.viewport}): ${e.detail}` +
        (e.declineReason ? ` [declined: ${e.declineReason}]` : ""),
    );
}
