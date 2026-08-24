import type { Grade } from "@apatureai/verdict-types";

/**
 * Final approval-authority decision for a UI-DNA-grounded result.
 *
 * UI-DNA is the sole writer. Judgment Engine only consumes its mirrored status
 * and removes blocking authority when the exact grounding version is revoked or
 * cannot be proven current. Findings remain visible and auditable.
 */
export type AuthorityStatus = "effective" | "superseded" | "revoked" | "unknown";

export interface AuthorityStatusRef {
  status: AuthorityStatus;
}

export type GroundingAuthorization =
  | { allowed: true }
  | { allowed: false; reason: "revoked" | "unknown" };

/** Exact pinned superseded versions remain valid; revoked/unknown never block. */
export function authorizeGrounding(ref: AuthorityStatusRef): GroundingAuthorization {
  if (ref.status === "revoked") return { allowed: false, reason: "revoked" };
  if (ref.status === "unknown") return { allowed: false, reason: "unknown" };
  return { allowed: true };
}

function withNote(notReviewed: readonly string[], note: string): string[] {
  return notReviewed.includes(note) ? [...notReviewed] : [...notReviewed, note];
}

interface AuthorityGatedResult {
  grade: Grade;
  blockingEnabled?: boolean;
  notReviewed: string[];
  metadata: { uiDnaVersion: string | null };
}

/**
 * Apply the final authority decision to either the internal critique or its
 * wire projection. Effective/superseded evidence passes through unchanged.
 * Revoked or unknown evidence preserves findings/provenance but makes the
 * result advisory and floors `blocked` to `needs_work`. Idempotent.
 */
export function enforceGroundingAuthority<T extends AuthorityGatedResult>(
  result: T,
  ref: AuthorityStatusRef,
): T {
  const authorization = authorizeGrounding(ref);
  if (authorization.allowed) return result;
  const version = result.metadata.uiDnaVersion ?? "unknown";
  const flooredGrade: Grade = result.grade === "blocked" ? "needs_work" : result.grade;
  const note = authorization.reason === "revoked"
    ? `grounding withheld: UI-DNA version ${version} was revoked before publish; blocking suppressed (advisory only)`
    : `grounding withheld: authority for UI-DNA version ${version} was unknown at publish; blocking suppressed (advisory only)`;
  return {
    ...result,
    grade: flooredGrade,
    blockingEnabled: false,
    notReviewed: withNote(result.notReviewed, note),
  };
}

/** Deterministic test mirror. Unlisted versions fail closed as `unknown`. */
export function inMemoryGroundingAuthority(
  entries: readonly { uiDnaVersion: string; status: AuthorityStatus }[] = [],
): { statusFor(uiDnaVersion: string | null): AuthorityStatusRef } {
  const byVersion = new Map<string, AuthorityStatusRef>();
  for (const entry of entries) byVersion.set(entry.uiDnaVersion, { status: entry.status });
  return {
    statusFor(uiDnaVersion) {
      if (uiDnaVersion === null) return { status: "unknown" };
      return byVersion.get(uiDnaVersion) ?? { status: "unknown" };
    },
  };
}
