import type {
  GroundingAuthorityProvenance,
  GroundingAuthorityUnknownReason,
} from "@apatureai/verdict-types";

export const AUTHORITY_CONTRACT_VERSION = "uidna-authority/1" as const;
export const DEFAULT_AUTHORITY_MAX_AGE_MS = 60_000;

export type GroundingAuthorityStatus = "effective" | "superseded" | "revoked";

/** Fresh evidence for one exact UI-DNA version. */
export interface GroundingAuthorityReceipt {
  contractVersion: typeof AUTHORITY_CONTRACT_VERSION;
  status: GroundingAuthorityStatus;
  sequence: number;
  headEventHash: `sha256:${string}`;
  checkedAt: string;
}

/** Exact approval-authority key. */
export interface GroundingAuthorityKey {
  tenantId: string;
  repository: string;
  dnaVersion: string;
}

export interface GroundingAuthorityPort {
  statusFor(key: GroundingAuthorityKey): Promise<GroundingAuthorityReceipt>;
}

export class GroundingAuthorityError extends Error {
  constructor(
    readonly reason: GroundingAuthorityUnknownReason,
    message: string,
    /** Highest trustworthy receipt observed before this failure, when known. */
    readonly lastKnown?: GroundingAuthorityReceipt,
  ) {
    super(message);
    this.name = "GroundingAuthorityError";
  }
}

export interface AuthorityValidationOptions {
  now: Date;
  maxAgeMs?: number;
  futureSkewMs?: number;
}

/** Validate the mirror at the trust boundary; absence never means effective. */
export function validateGroundingAuthorityReceipt(
  value: unknown,
  options: AuthorityValidationOptions,
): GroundingAuthorityReceipt {
  if (value === null || typeof value !== "object") {
    throw new GroundingAuthorityError("malformed", "authority receipt must be an object");
  }
  const receipt = value as Partial<GroundingAuthorityReceipt>;
  const validStatus =
    receipt.status === "effective" || receipt.status === "superseded" || receipt.status === "revoked";
  const validHash =
    typeof receipt.headEventHash === "string" && /^sha256:[a-f0-9]{64}$/.test(receipt.headEventHash);
  const checkedAtMs = typeof receipt.checkedAt === "string" ? Date.parse(receipt.checkedAt) : Number.NaN;
  if (
    receipt.contractVersion !== AUTHORITY_CONTRACT_VERSION ||
    !validStatus ||
    !Number.isInteger(receipt.sequence) ||
    (receipt.sequence ?? 0) < 1 ||
    !validHash ||
    !Number.isFinite(checkedAtMs)
  ) {
    throw new GroundingAuthorityError("malformed", "authority receipt failed contract validation");
  }
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_AUTHORITY_MAX_AGE_MS;
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 0) {
    throw new Error("authority maxAgeMs must be a non-negative integer");
  }
  const ageMs = options.now.getTime() - checkedAtMs;
  if (ageMs > maxAgeMs || ageMs < -(options.futureSkewMs ?? 5_000)) {
    throw new GroundingAuthorityError("stale", "authority receipt is outside its freshness window");
  }
  return receipt as GroundingAuthorityReceipt;
}

function authorityKey(key: GroundingAuthorityKey): string {
  return `${key.tenantId}\u0000${key.repository}\u0000${key.dnaVersion}`;
}

/**
 * Reject an out-of-order or contradictory mirror response after a newer head
 * was observed. Each replica applies the same sequence rule and converges on
 * the highest valid receipt even when delivery order differs.
 */
export function monotonicGroundingAuthorityPort(source: GroundingAuthorityPort): GroundingAuthorityPort {
  const highest = new Map<string, GroundingAuthorityReceipt>();
  return {
    async statusFor(key) {
      const next = await source.statusFor(key);
      const mapKey = authorityKey(key);
      const previous = highest.get(mapKey);
      if (previous) {
        if (next.sequence < previous.sequence) {
          throw new GroundingAuthorityError("sequence_regression", "authority sequence regressed", previous);
        }
        if (
          next.sequence === previous.sequence &&
          (next.headEventHash !== previous.headEventHash || next.status !== previous.status)
        ) {
          throw new GroundingAuthorityError(
            "conflicting_sequence",
            "authority sequence has conflicting content",
            previous,
          );
        }
        if (previous.status === "revoked" && next.status !== "revoked") {
          throw new GroundingAuthorityError(
            "revocation_regression",
            "revoked authority is terminal",
            previous,
          );
        }
      }
      if (!previous || next.sequence > previous.sequence || Date.parse(next.checkedAt) > Date.parse(previous.checkedAt)) {
        highest.set(mapKey, next);
      }
      return highest.get(mapKey) ?? next;
    },
  };
}

export function compareAuthorityReceipts(
  initial: GroundingAuthorityReceipt,
  publication: GroundingAuthorityReceipt,
): void {
  if (publication.sequence < initial.sequence) {
    throw new GroundingAuthorityError(
      "sequence_regression",
      "publication authority sequence regressed",
      initial,
    );
  }
  if (
    publication.sequence === initial.sequence &&
    (publication.headEventHash !== initial.headEventHash || publication.status !== initial.status)
  ) {
    throw new GroundingAuthorityError(
      "conflicting_sequence",
      "publication authority conflicts with resolve receipt",
      initial,
    );
  }
  if (initial.status === "revoked" && publication.status !== "revoked") {
    throw new GroundingAuthorityError("revocation_regression", "revoked authority is terminal", initial);
  }
}

export function authorityProvenance(
  receipt: GroundingAuthorityReceipt,
  publicationCheckedAt: string,
): GroundingAuthorityProvenance {
  return {
    contractVersion: AUTHORITY_CONTRACT_VERSION,
    status: receipt.status,
    sequence: receipt.sequence,
    headEventHash: receipt.headEventHash,
    evidenceCheckedAt: receipt.checkedAt,
    publicationCheckedAt,
  };
}

export function unknownAuthorityProvenance(
  lastKnown: GroundingAuthorityReceipt | null,
  publicationCheckedAt: string,
  reason: GroundingAuthorityUnknownReason,
): GroundingAuthorityProvenance {
  return {
    contractVersion: AUTHORITY_CONTRACT_VERSION,
    status: "unknown",
    sequence: lastKnown?.sequence ?? null,
    headEventHash: lastKnown?.headEventHash ?? null,
    evidenceCheckedAt: lastKnown?.checkedAt ?? null,
    publicationCheckedAt,
    reason,
  };
}
