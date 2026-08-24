/** Options for writing an object. */
export interface PutOptions {
  /** MIME type stored as object metadata (e.g. `image/png`, `application/json`). */
  contentType?: string;
  /**
   * Per-tenant SSE-KMS key id (§11, #51). When set, the artifact is encrypted at
   * rest under this key (`aws:kms`); a signed GET still serves decrypted bytes,
   * so the at-rest encryption is transparent to consumers. Resolve it from the
   * tenant's tier with `tenantKmsKeyId` (paid → per-tenant CMK, free/public →
   * shared CMK). Backends without native SSE-KMS (R2) ignore it and rely on the
   * envelope path (`@apatureai/verdict-secrets`).
   */
  kmsKeyId?: string;
}

/**
 * Object storage for capture artifacts: screenshots, DOM snapshots, critique
 * JSON (TRD §7.1/§11). All artifacts are addressed by job id (see `objectKey`).
 *
 * Signed URLs are minted **on demand** with a short TTL and are never persisted
 * anywhere; only the durable object key is stored, so a leaked record can't be
 * replayed into long-lived access.
 */
export interface ObjectStore {
  /** Write an object at `key`. */
  put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void>;
  /** Read an object, or `null` if it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /**
   * Delete an object. Idempotent, so deleting a missing key is a no-op. Used by
   * the retention sweep (#51) and the data-subject erasure workflow (#54).
   */
  delete(key: string): Promise<void>;
  /** Mint a short-TTL signed GET URL for `key`. The result must not be stored. */
  signedGetUrl(key: string, ttlSeconds: number): Promise<string>;
}
