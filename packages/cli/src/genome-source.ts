import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { GenomeRule } from "@apatureai/verdict-context";
import type { LocalGenome } from "./grounding.js";

/**
 * Where a local run gets a UI-DNA genome.
 *
 * The deployed composition resolves one over HTTP from the Source of Truth
 * (`HttpGenomeResolver`, `GENOME_ENDPOINT`). That service is not in this
 * repository and a local run cannot reach it, so the only genome a local run can
 * have is one that was exported from it and left on disk. This reads exactly
 * that: `ui-dna.json` in the same `--context-dir` that already supplies
 * `tokens.json`, `.designreview.yml` and `package.json`.
 *
 * The accepted document is the peer service's own response shape, not a local
 * dialect, and the mapping from items to rules below is character for character
 * the one `HttpGenomeResolver.resolve` performs. That is the whole point: the
 * rule text a model sees from a local snapshot and the rule text it sees from
 * the live service are the same string, so a local review and a deployed review
 * of the same genome are grounded on the same words. Inventing a friendlier
 * local format would have made them two different reviews.
 *
 * What this deliberately does NOT do:
 *
 *   - It does not verify the snapshot's authority receipt. Authority is a
 *     question about the CURRENT state of a version ("is it still effective?")
 *     and only the authority service can answer it. A file cannot: a revoked
 *     version's exported snapshot still carries the receipt it was exported
 *     with. So the receipt is not read, nothing pretends to have checked it, and
 *     the pipeline treats a locally-grounded review the way the deployed path
 *     treats an unverifiable one.
 *   - It does not apply the peer request's `max_items=100` cap. That cap bounds
 *     a network response, not what may ground a review; retrieval's top-k is
 *     what bounds the prompt, here and in production alike.
 *   - It does not degrade a malformed file to "no genome". A file that is there
 *     and unusable is a different fact from no file, and the review says which.
 */

/** The file a local run reads a genome from, inside `--context-dir`. */
export const UI_DNA_FILENAME = "ui-dna.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The approval states the peer contract emits; anything else is not a snapshot. */
const APPROVAL_STATES = new Set(["approved", "superseded"]);

class SnapshotError extends Error {}

/**
 * Validate the snapshot document and project its items into genome rules.
 * Throws `SnapshotError` with a reader-facing clause; never returns a partial
 * genome, because half a design system silently applied is worse than none.
 */
function toGenome(document: unknown, source: string): { version: string; rules: GenomeRule[] } {
  if (!isRecord(document)) throw new SnapshotError("the document is not a JSON object");
  const snapshot = document.snapshot;
  if (!isRecord(snapshot)) throw new SnapshotError("it has no `snapshot` object");
  if (!nonEmptyString(snapshot.dna_version)) {
    throw new SnapshotError("its `snapshot.dna_version` is missing or empty");
  }
  if (!nonEmptyString(snapshot.approval_state) || !APPROVAL_STATES.has(snapshot.approval_state)) {
    throw new SnapshotError(
      "its `snapshot.approval_state` is not `approved` or `superseded`, so it is not a published snapshot",
    );
  }
  const items = document.items;
  if (!Array.isArray(items)) throw new SnapshotError("it has no `items` array");

  const rules: GenomeRule[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!isRecord(item)) throw new SnapshotError(`item ${index} is not an object`);
    if (!nonEmptyString(item.field_id)) throw new SnapshotError(`item ${index} has no \`field_id\``);
    if (!nonEmptyString(item.kind)) throw new SnapshotError(`item ${index} has no \`kind\``);
    if (!isRecord(item.value)) throw new SnapshotError(`item ${index} has no \`value\` object`);
    if (seen.has(item.field_id)) {
      throw new SnapshotError(`\`field_id\` ${item.field_id} appears twice`);
    }
    seen.add(item.field_id);
    const applicability = isRecord(item.applicability) ? item.applicability : {};
    const componentKinds = applicability.component_kinds;
    const component =
      Array.isArray(componentKinds) && nonEmptyString(componentKinds[0]) ? componentKinds[0] : undefined;
    rules.push({
      id: item.field_id,
      // The exact projection `HttpGenomeResolver.resolve` performs.
      text: JSON.stringify({ kind: item.kind, value: item.value }),
      ...(component ? { component } : {}),
    });
  });

  if (rules.length === 0) {
    throw new SnapshotError(`it carries no items, so ${source} states no rule to ground against`);
  }
  return { version: snapshot.dna_version, rules };
}

/**
 * Read the genome for a review of `directory`. Never throws: an unreadable or
 * unusable snapshot is reported as a reason, because a design review is still
 * worth running without a genome and the run has to be able to say so.
 */
export async function loadRepoGenome(directory: string): Promise<LocalGenome> {
  const path = join(directory, UI_DNA_FILENAME);
  // WHAT A READER IS TOLD IS THE PATH INSIDE THEIR REPOSITORY, never the one on
  // the machine that ran the review. These sentences are published: they reach a
  // pull request comment, and they are typeset into this project's own README
  // image. An absolute path there is noise at best, since the checkout directory
  // on a runner means nothing to the person reading the comment, and at worst it
  // publishes the directory layout and the account name of whoever ran it.
  const shown = relative(process.cwd(), path) || path;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {
      available: false,
      reason: "no_genome_file",
      detail: `no UI-DNA snapshot was found at ${shown}`,
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return {
      available: false,
      reason: "genome_unreadable",
      detail: `the UI-DNA snapshot at ${shown} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }), so it was not used`,
    };
  }

  try {
    const genome = toGenome(document, path);
    return { available: true, version: genome.version, rules: genome.rules, source: path };
  } catch (error) {
    const detail = error instanceof SnapshotError ? error.message : String(error);
    // An empty-but-valid snapshot is its own reason: the file is fine, the
    // design system it describes is silent, and telling a reader "unreadable"
    // would send them to fix a file that has nothing wrong with it.
    const reason = detail.startsWith("it carries no items") ? "genome_has_no_rules" : "genome_unreadable";
    return {
      available: false,
      reason,
      detail:
        reason === "genome_has_no_rules"
          ? `the UI-DNA snapshot at ${path} carries no rules`
          : `the UI-DNA snapshot at ${path} was rejected: ${detail}`,
    };
  }
}
