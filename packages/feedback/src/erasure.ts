import type { SqlExecutor } from "@apatureai/verdict-db";
import { jobPrefix, type ObjectStore } from "@apatureai/verdict-storage";

/**
 * Data-subject erasure workflow (GDPR Art. 17 / DPA, #54), tied to the at-rest
 * retention policy (#51). A deletion request for an installation purges, in one
 * workflow:
 *   - the durable DB records (findings → feedback cascade, #37; training consent)
 *   - the object-storage artifacts (screenshots / DOM / critique JSON) for that
 *     tenant's jobs, via the same `ObjectStore.delete` primitive the retention
 *     sweep uses.
 *
 * Object enumeration uses an injected `listKeys` (prod = S3/R2 `ListObjectsV2`
 * under `jobPrefix(jobId)`; tests inject an in-memory lister), so the workflow
 * is engine-driven and testable without a live bucket. Idempotent: re-running an
 * erasure for an already-purged tenant is a no-op.
 */

/** Lists the object keys stored under a job's prefix (S3/R2 ListObjectsV2 in prod). */
export type KeyLister = (prefix: string) => Promise<string[]>;

export interface EraseResult {
  installationId: string;
  findingsDeleted: number;
  consentDeleted: number;
  jobIds: string[];
  objectsPurged: number;
}

/**
 * Delete an installation's DB records and return the job ids whose artifacts must
 * also be purged. Findings deletion cascades to feedback (FK ON DELETE CASCADE).
 */
export async function eraseInstallationData(
  exec: SqlExecutor,
  installationId: string,
): Promise<{ findingsDeleted: number; consentDeleted: number; jobIds: string[] }> {
  const deleted = await exec.query<{ id: string; job_id: string | null }>(
    "DELETE FROM findings WHERE installation_id = $1 RETURNING id, job_id",
    [installationId],
  );
  const consent = await exec.query<{ installation_id: string }>(
    "DELETE FROM tenant_training_consent WHERE installation_id = $1 RETURNING installation_id",
    [installationId],
  );
  const jobIds = [...new Set(deleted.rows.map((r) => r.job_id).filter((j): j is string => j !== null))];
  return { findingsDeleted: deleted.rows.length, consentDeleted: consent.rows.length, jobIds };
}

/** Idempotently delete a set of object keys, returning how many were purged. */
export async function purgeObjects(store: ObjectStore, keys: readonly string[]): Promise<number> {
  for (const key of keys) await store.delete(key);
  return keys.length;
}

/**
 * Full data-subject erasure for an installation: DB records + every artifact
 * under each affected job's prefix. Returns a summary for the processing record.
 */
export async function eraseTenant(
  exec: SqlExecutor,
  store: ObjectStore,
  installationId: string,
  listKeys: KeyLister,
): Promise<EraseResult> {
  const { findingsDeleted, consentDeleted, jobIds } = await eraseInstallationData(exec, installationId);

  let objectsPurged = 0;
  for (const jobId of jobIds) {
    const keys = await listKeys(jobPrefix(jobId));
    objectsPurged += await purgeObjects(store, keys);
  }

  return { installationId, findingsDeleted, consentDeleted, jobIds, objectsPurged };
}
