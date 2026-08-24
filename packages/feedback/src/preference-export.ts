import type { SqlExecutor } from "@apatureai/verdict-db";
import { objectKey } from "@apatureai/verdict-storage";
import type { Dimension, Severity, Viewport } from "@apatureai/verdict-types";
import { isPiiClean } from "./pii.js";
import type { FeedbackSignal, RaterPermission } from "./store.js";
import { isTrainingGrade, weightedConsensus } from "./weighting.js";

/**
 * Preference-dataset export (TRD §8, #43). Joins findings + feedback + artifacts
 * into labeled examples for training the owned judge (#78). Versioned by
 * prompt_version; gated by tenant training consent (#74); each example carries
 * BOTH a pairwise verdict (ORPO/SimPO) and a KTO-style binary label (#85). The
 * image/context bytes live as object-storage artifacts referenced here (DVC #75).
 */
export interface PreferenceExample {
  findingId: string;
  installationId: string;
  promptVersion: string;
  /** Object-storage ref to the screenshot artifact, or null when no job is linked. */
  imageRef: string | null;
  /** Content hash of the context block (#63); the bytes are an artifact. */
  contextHash: string | null;
  finding: {
    dimension: Dimension;
    severity: Severity;
    route: string;
    viewport: Viewport;
    elementRef: string | null;
  };
  /** Net human verdict from weighted consensus (#42). */
  verdict: "endorsed" | "dismissed";
  /** KTO-style binary label (#85). */
  label: "desirable" | "undesirable";
  /** Provenance of the label (#85 AC1): which feedback channel produced it. */
  source: KtoSource;
  /** Whether at least one collaborator (training-grade) signal backs the verdict. */
  trainingGrade: boolean;
}

/** KTO label provenance (#85): the human channel the binary label came from. */
export type KtoSource = "thumbs" | "ignore" | "implicit";

/**
 * Map a raw feedback signal to its KTO source channel (#38/#39). Explicit thumbs
 * are the strongest provenance, then `/ignore`, then implicit accept/merge.
 */
export function ktoSourceForSignal(signal: FeedbackSignal): KtoSource {
  if (signal === "thumbs_up" || signal === "thumbs_down") return "thumbs";
  if (signal === "ignore") return "ignore";
  return "implicit";
}

/** Pick the example's source from its signals (thumbs > ignore > implicit). */
function dominantKtoSource(signals: Array<{ signal: FeedbackSignal }>): KtoSource {
  const sources = signals.map((s) => ktoSourceForSignal(s.signal));
  if (sources.includes("thumbs")) return "thumbs";
  if (sources.includes("ignore")) return "ignore";
  return "implicit";
}

export interface PreferenceExportOptions {
  /** Only export findings produced under this prompt version. */
  promptVersion?: string;
}

interface ExportRow {
  finding_id: string;
  installation_id: string;
  prompt_version: string;
  job_id: string | null;
  route: string;
  viewport: Viewport;
  dimension: Dimension;
  severity: Severity;
  element_ref: string | null;
  context_hash: string | null;
  signal: FeedbackSignal;
  rater_permission: RaterPermission;
}

/**
 * Export labeled preference examples. Only **consenting** tenants (#74) are
 * included; only findings with a non-neutral weighted verdict are emitted;
 * PII-bearing text is skipped defensively.
 */
export async function exportPreferenceDataset(
  exec: SqlExecutor,
  options: PreferenceExportOptions = {},
): Promise<PreferenceExample[]> {
  const params: unknown[] = [];
  let promptFilter = "";
  if (options.promptVersion !== undefined) {
    params.push(options.promptVersion);
    promptFilter = `AND f.prompt_version = $${params.length}`;
  }

  const { rows } = await exec.query<ExportRow>(
    `SELECT f.id AS finding_id, f.installation_id, f.prompt_version, f.job_id, f.route, f.viewport,
            f.dimension, f.severity, f.element_ref, f.context_hash, fb.signal, fb.rater_permission
       FROM findings f
       JOIN feedback fb ON fb.finding_id = f.id
       JOIN tenant_training_consent c
         ON c.installation_id = f.installation_id AND c.consent = true
      WHERE 1 = 1 ${promptFilter}`,
    params,
  );

  // Group feedback per finding.
  const byFinding = new Map<string, { meta: ExportRow; signals: Pick<ExportRow, "signal" | "rater_permission">[] }>();
  for (const r of rows) {
    const entry = byFinding.get(r.finding_id) ?? { meta: r, signals: [] };
    entry.signals.push({ signal: r.signal, rater_permission: r.rater_permission });
    byFinding.set(r.finding_id, entry);
  }

  const examples: PreferenceExample[] = [];
  for (const { meta, signals } of byFinding.values()) {
    if (!isPiiClean(meta.route, meta.element_ref)) continue; // defensive
    const consensus = weightedConsensus(
      signals.map((s) => ({ signal: s.signal, raterPermission: s.rater_permission })),
    );
    if (consensus.score === 0) continue; // ambiguous -> not a labeled example

    const endorsed = consensus.score > 0;
    examples.push({
      findingId: meta.finding_id,
      installationId: meta.installation_id,
      promptVersion: meta.prompt_version,
      imageRef: meta.job_id ? objectKey(meta.job_id, "screenshot", `${meta.route}-${meta.viewport}`) : null,
      contextHash: meta.context_hash,
      finding: {
        dimension: meta.dimension,
        severity: meta.severity,
        route: meta.route,
        viewport: meta.viewport,
        elementRef: meta.element_ref,
      },
      verdict: endorsed ? "endorsed" : "dismissed",
      label: endorsed ? "desirable" : "undesirable",
      source: dominantKtoSource(signals),
      trainingGrade: signals.some((s) => isTrainingGrade(s.rater_permission)),
    });
  }
  return examples.sort((a, b) => a.findingId.localeCompare(b.findingId));
}
