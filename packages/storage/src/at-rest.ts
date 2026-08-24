import type { ObjectStore } from "./types.js";

/**
 * At-rest policy for artifacts (§11, #51): per-tenant SSE-KMS key selection and
 * tenant-tier retention. Screenshots, DOM snapshots, and critique JSON are
 * encrypted at rest under a per-tenant key (resolved here) and reaped on a
 * tier-based retention clock: 0 (ephemeral) on free/public, 30 days on paid
 * under a DPA. Access is signed-URL only; raw keys/URLs are never logged.
 */

/** Tenant tier for at-rest policy (distinct from the model-selection tier). */
export type RetentionTier = "free" | "public" | "paid";

const DAY_SECONDS = 86_400;

/**
 * Retention window per tier, in seconds. `0` means "do not retain", i.e. the
 * artifact is ephemeral (kept only for the in-flight job/delivery, then reaped);
 * paid tenants retain for 30 days under a DPA for re-checks and disputes.
 */
export const RETENTION_SECONDS: Readonly<Record<RetentionTier, number>> = {
  free: 0,
  public: 0,
  paid: 30 * DAY_SECONDS,
};

/** Retention window (seconds) for a tenant tier. */
export function retentionSecondsForTier(tier: RetentionTier): number {
  return RETENTION_SECONDS[tier];
}

/**
 * Resolve the SSE-KMS key id for a tenant (§11 hierarchy): paid tenants get
 * their own per-tenant CMK; free/public share the managed CMK. The per-repo DEK
 * envelope (`@apatureai/verdict-secrets`) sits under whichever CMK this returns.
 */
export function tenantKmsKeyId(
  tier: RetentionTier,
  keys: { perTenantKeyId?: string; sharedKeyId: string },
): string {
  if (tier === "paid" && keys.perTenantKeyId) return keys.perTenantKeyId;
  return keys.sharedKeyId;
}

/**
 * Whether an artifact uploaded at `uploadedAt` (ms epoch) is past its retention
 * and must be reaped. A `0` window is always expired the instant the job is no
 * longer in flight (ephemeral); a positive window expires strictly after it
 * elapses. `now` defaults to the wall clock.
 */
export function isExpired(args: {
  uploadedAt: number;
  retentionSeconds: number;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  if (args.retentionSeconds <= 0) return true;
  return now - args.uploadedAt > args.retentionSeconds * 1000;
}

/** An artifact record the retention sweep considers. */
export interface RetainedObject {
  key: string;
  uploadedAt: number;
  retentionSeconds: number;
}

/**
 * Keys whose retention has elapsed: the input to the deletion sweep (the actual
 * delete + S3/R2 lifecycle config is ops; this is the engine-owned policy).
 */
export function expiredKeys(objects: readonly RetainedObject[], now: number = Date.now()): string[] {
  return objects
    .filter((o) => isExpired({ uploadedAt: o.uploadedAt, retentionSeconds: o.retentionSeconds, now }))
    .map((o) => o.key);
}

/**
 * Retention sweep: delete every object past its retention from `store` and
 * return the keys reaped. Ties the retention policy (#51) to the deletion
 * primitive; S3/R2 bucket lifecycle rules are the bulk mechanism, this is the
 * engine-driven sweep for targeted/immediate reaping.
 */
export async function reapExpired(
  store: Pick<ObjectStore, "delete">,
  objects: readonly RetainedObject[],
  now: number = Date.now(),
): Promise<string[]> {
  const keys = expiredKeys(objects, now);
  for (const key of keys) await store.delete(key);
  return keys;
}
