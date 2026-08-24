import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ObjectStore } from "@apatureai/verdict-storage";
import type { PreferenceExample } from "./preference-export.js";

/**
 * DVC-versioned preference-dataset export on R2 (TRD §10 E5, #75). The export
 * tuples (#43) are turned into a **content-addressed** dataset that mirrors DVC's
 * on-disk model so the existing `dvc` tooling (and an R2 remote) can pull/push it
 * with no new infra:
 *
 *  - Every tuple is serialized to canonical JSON and addressed by `md5(content)`,
 *    DVC's default hash. Identical tuples dedup across versions.
 *  - The dataset version is a DVC **`.dir` object**: a JSON listing of
 *    `{md5, relpath}` sorted by canonical UTF-8 bytes of `relpath`; the
 *    listing's own md5 (suffixed `.dir`) is the version id. Same tuples ⇒ same
 *    version id (point-in-time reproducible).
 *  - Each entry carries lineage back to its finding / verdict / screenshot, so a
 *    training set is auditable tuple→source.
 *  - Data-subject deletion is a re-version that drops a subject's tuples; because
 *    addressing is content-based, every *unaffected* object keeps its id and
 *    prior versions still resolve.
 *
 * The `dvc` CLI invocation + the R2 remote credentials are an ops edge; this
 * module produces exactly the bytes DVC stores (cache objects + `.dir`) and
 * pushes them to the R2-backed `ObjectStore`, which is the testable seam.
 */

/** A content-addressed cache object (one serialized preference tuple). */
export interface DvcObject {
  /** md5 of `content` (DVC's default file hash). */
  md5: string;
  /** Logical path inside the dataset, e.g. `stub@0/finding-1.json`. */
  relpath: string;
  /** Canonical JSON bytes that hash to `md5`. */
  content: string;
}

/** One row of a DVC `.dir` listing. */
export interface DvcDirEntry {
  md5: string;
  relpath: string;
}

/** Lineage from a dataset entry back to its source finding / verdict / screenshot. */
export interface DvcLineage {
  relpath: string;
  findingId: string;
  installationId: string;
  promptVersion: string;
  verdict: PreferenceExample["verdict"];
  label: PreferenceExample["label"];
  /** Object-storage ref to the screenshot artifact (null when no job is linked). */
  screenshotRef: string | null;
  /** Content hash of the context block (#63). */
  contextHash: string | null;
}

/** A reproducible, content-addressed dataset version. */
export interface DvcDataset {
  /** Version id: `<md5-of-dir-listing>.dir` (a DVC directory hash). */
  version: string;
  /** Sorted `.dir` listing (the manifest DVC tracks). */
  dir: DvcDirEntry[];
  /** The content-addressed cache objects to push to the remote. */
  objects: DvcObject[];
  /** Tuple→source lineage, parallel to `dir`. */
  lineage: DvcLineage[];
}

function md5hex(content: string): string {
  return createHash("md5").update(content, "utf8").digest("hex");
}

/**
 * Deterministic JSON with lexicographically sorted keys at every level. This is
 * the byte-exact serialization the content addressing depends on; the Python
 * mirror (`python/preference-dataset` `canonical_json`) reproduces it, and the
 * schema contract (`contracts/preference-example.contract.json`) pins samples of
 * its output so a drift on either side fails loudly.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/** Logical path for a tuple's cache object, stable across runs (point-in-time). */
function relpathFor(example: PreferenceExample): string {
  return `${example.promptVersion}/${example.findingId}.json`;
}

/** Canonical DVC `.dir` relpath ordering, mirrored by python/preference-dataset. */
function compareRelpathBytes(a: string, b: string): number {
  return Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8"));
}

/** Remote/cache path DVC stores an object at: `files/md5/<aa>/<rest>`. */
export function dvcCachePath(md5: string): string {
  // `.dir` objects keep their suffix on the filename; split only the 32-hex head.
  const hex = md5.endsWith(".dir") ? md5.slice(0, -4) : md5;
  const suffix = md5.endsWith(".dir") ? ".dir" : "";
  return `files/md5/${hex.slice(0, 2)}/${hex.slice(2)}${suffix}`;
}

/**
 * Build a content-addressed, reproducible DVC dataset version from export tuples.
 * Pure + deterministic: the same `examples` always yield the same `version`.
 */
export function buildDvcDataset(examples: PreferenceExample[]): DvcDataset {
  const objects: DvcObject[] = [];
  const lineage: DvcLineage[] = [];

  for (const ex of examples) {
    const relpath = relpathFor(ex);
    const content = canonicalJson(ex);
    objects.push({ md5: md5hex(content), relpath, content });
    lineage.push({
      relpath,
      findingId: ex.findingId,
      installationId: ex.installationId,
      promptVersion: ex.promptVersion,
      verdict: ex.verdict,
      label: ex.label,
      screenshotRef: ex.imageRef,
      contextHash: ex.contextHash,
    });
  }

  objects.sort((a, b) => compareRelpathBytes(a.relpath, b.relpath));
  lineage.sort((a, b) => compareRelpathBytes(a.relpath, b.relpath));

  const dir: DvcDirEntry[] = objects.map((o) => ({ md5: o.md5, relpath: o.relpath }));
  // DVC serializes the `.dir` listing compactly with canonical relpath ordering;
  // its md5 (+ `.dir`) is the directory's content address, i.e. the dataset version.
  const version = `${md5hex(canonicalJson(dir))}.dir`;

  return { version, dir, objects, lineage };
}

/**
 * Re-version a dataset with one data subject removed (GDPR erasure / DPA, #54).
 * Returns a fresh `DvcDataset` excluding every tuple matching `predicate`;
 * because addressing is content-based, all surviving objects keep their ids and
 * any previously-pushed version still resolves from the remote.
 */
export function removeSubject(
  examples: PreferenceExample[],
  predicate: (ex: PreferenceExample) => boolean,
): DvcDataset {
  return buildDvcDataset(examples.filter((ex) => !predicate(ex)));
}

/**
 * Push a dataset's cache objects + `.dir` manifest to the R2-backed remote.
 * Content-addressed, so an object already present is skipped (idempotent dedup).
 * Returns the objects pushed vs. skipped this run.
 */
export async function pushDataset(
  store: ObjectStore,
  dataset: DvcDataset,
): Promise<{ version: string; pushed: number; skipped: number }> {
  let pushed = 0;
  let skipped = 0;

  for (const obj of dataset.objects) {
    const path = dvcCachePath(obj.md5);
    if (await store.get(path)) {
      skipped += 1;
      continue;
    }
    await store.put(path, obj.content, { contentType: "application/json" });
    pushed += 1;
  }

  // The `.dir` manifest is itself a content-addressed object.
  const dirPath = dvcCachePath(dataset.version);
  if (await store.get(dirPath)) {
    skipped += 1;
  } else {
    await store.put(dirPath, canonicalJson(dataset.dir), { contentType: "application/json" });
    pushed += 1;
  }

  return { version: dataset.version, pushed, skipped };
}

/**
 * Reproduce a point-in-time dataset from the remote: given a version's `.dir`
 * entries, fetch each content-addressed object and return its bytes. Verifies
 * every object's content still hashes to its recorded id (integrity), and fails
 * if an object referenced by the manifest is missing.
 */
export async function pullDataset(
  store: ObjectStore,
  dir: DvcDirEntry[],
): Promise<{ relpath: string; content: string }[]> {
  const out: { relpath: string; content: string }[] = [];
  for (const entry of dir) {
    const bytes = await store.get(dvcCachePath(entry.md5));
    if (!bytes) throw new Error(`dvc object missing for ${entry.relpath} (${entry.md5})`);
    const content = new TextDecoder().decode(bytes);
    if (md5hex(content) !== entry.md5) {
      throw new Error(`dvc object integrity mismatch for ${entry.relpath}`);
    }
    out.push({ relpath: entry.relpath, content });
  }
  return out;
}
