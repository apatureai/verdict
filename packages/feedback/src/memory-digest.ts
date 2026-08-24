import type { SqlExecutor } from "@apatureai/verdict-db";
import type { Dimension } from "@apatureai/verdict-types";
import type { FeedbackSignal, RaterPermission } from "./store.js";
import { raterWeight, SIGNAL_POLARITY } from "./weighting.js";

/**
 * Per-repo memory digest (TRD §8/§16, #41). Condenses a repo's accepted/rejected
 * finding patterns into <=600 tokens, appended AFTER the stable context prefix in
 * the deep pass so it doesn't break prefix-cache reuse (#34). Per the 2026-06-19
 * research note: select by salience = (weighted evidence) x recency-decay, weight
 * by collaborator consensus (#42), and emit DETERMINISTIC extractive facts (not an
 * abstractive summary) so the suffix is reproducible/testable. Recompute per
 * feedback epoch, not every run.
 */
export interface MemoryPattern {
  /** Stable key (deterministic tie-break). */
  key: string;
  dimension: Dimension;
  /** Net weighted accept evidence. */
  acceptedWeight: number;
  /** Net weighted dismiss evidence. */
  dismissedWeight: number;
  /** Most recent feedback timestamp (ms). */
  lastSeenMs: number;
}

export interface MemoryDigestOptions {
  maxTokens?: number;
  now?: number;
  /** Recency decay per day (default ~0.02 ≈ 35-day half-life). */
  lambdaPerDay?: number;
}

/** ~4 chars/token estimate (good enough for a 600-token budget guardrail). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function salience(p: MemoryPattern, now: number, lambdaPerDay: number): number {
  const ageDays = Math.max(0, (now - p.lastSeenMs) / 86_400_000);
  const evidence = p.acceptedWeight + p.dismissedWeight;
  return evidence * Math.exp(-lambdaPerDay * ageDays);
}

function line(p: MemoryPattern): string {
  const verdict = p.acceptedWeight >= p.dismissedWeight ? "consistently accepted" : "often dismissed";
  return `- ${p.dimension}: ${verdict} (accept ${p.acceptedWeight.toFixed(1)} / dismiss ${p.dismissedWeight.toFixed(1)})`;
}

/**
 * Build the deterministic memory digest. Ranks patterns by salience, emits
 * extractive fact lines until the token budget is reached. Pure + reproducible.
 */
export function buildMemoryDigest(patterns: MemoryPattern[], options: MemoryDigestOptions = {}): string {
  const maxTokens = options.maxTokens ?? 600;
  const now = options.now ?? Date.now();
  const lambda = options.lambdaPerDay ?? 0.02;

  const ranked = [...patterns].sort(
    (a, b) => salience(b, now, lambda) - salience(a, now, lambda) || a.key.localeCompare(b.key),
  );

  const header = "Repo review memory (prior reviewer feedback on this repo):";
  const lines: string[] = [header];
  let tokens = estimateTokens(header);
  for (const p of ranked) {
    const l = line(p);
    const cost = estimateTokens(l) + 1;
    if (tokens + cost > maxTokens) break;
    lines.push(l);
    tokens += cost;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

interface PatternRow {
  dimension: Dimension;
  signal: FeedbackSignal;
  rater_permission: RaterPermission;
  created_at: Date;
}

/**
 * Aggregate a repo's findings+feedback into per-dimension `MemoryPattern`s,
 * weighting each signal by polarity x rater permission (#42). Deterministic given
 * the stored feedback up to now.
 */
export async function computeRepoPatterns(
  exec: SqlExecutor,
  installationId: string,
): Promise<MemoryPattern[]> {
  const { rows } = await exec.query<PatternRow>(
    `SELECT f.dimension, fb.signal, fb.rater_permission, fb.created_at
       FROM findings f JOIN feedback fb ON fb.finding_id = f.id
      WHERE f.installation_id = $1`,
    [installationId],
  );

  const byDim = new Map<Dimension, MemoryPattern>();
  for (const r of rows) {
    const p = byDim.get(r.dimension) ?? {
      key: r.dimension,
      dimension: r.dimension,
      acceptedWeight: 0,
      dismissedWeight: 0,
      lastSeenMs: 0,
    };
    const w = SIGNAL_POLARITY[r.signal] * raterWeight(r.rater_permission);
    if (w > 0) p.acceptedWeight += w;
    else if (w < 0) p.dismissedWeight += -w;
    p.lastSeenMs = Math.max(p.lastSeenMs, new Date(r.created_at).getTime());
    byDim.set(r.dimension, p);
  }
  return [...byDim.values()];
}
