import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 verification for consumer -> engine requests (TRD §8/§15.2). The
 * consumer (Gate, MCP, ...) signs the canonical payload
 * `${timestamp}.${installationId}.${body}`, binding `installationId` into the
 * signature. The engine verifies before processing and scopes ALL tenant access
 * to the *verified* installationId, so a bug or compromise can't misroute a job
 * into another tenant's data. Header names match Gate's client. The secret comes
 * from the KMS-backed store (`@apatureai/verdict-secrets` `engineHmacSecret`).
 */
export const SIGNATURE_HEADER = "x-gate-signature";
export const INSTALLATION_HEADER = "x-gate-installation";
export const TIMESTAMP_HEADER = "x-gate-timestamp";

function canonical(timestamp: string, installationId: string, body: string): string {
  return `${timestamp}.${installationId}.${body}`;
}

export type VerifyFailureReason =
  | "missing_signature"
  | "missing_installation"
  | "signature_mismatch"
  | "timestamp_skew";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

/** Verify a signed request. Constant-time compare; optional anti-replay skew window. */
export function verifyEngineRequest(params: {
  body: string;
  installationId: string;
  timestamp: string;
  signature: string;
  secret: string;
  maxSkewMs?: number;
  now?: number;
}): VerifyResult {
  if (!params.installationId) return { ok: false, reason: "missing_installation" };
  if (!params.signature) return { ok: false, reason: "missing_signature" };

  const expected = createHmac("sha256", params.secret)
    .update(canonical(params.timestamp, params.installationId, params.body))
    .digest("hex");
  const provided = params.signature.startsWith("sha256=")
    ? params.signature.slice("sha256=".length)
    : params.signature;

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  if (params.maxSkewMs !== undefined) {
    const now = params.now ?? Date.now();
    const ts = Number(params.timestamp);
    // A non-numeric/empty timestamp must FAIL the skew check, not silently pass
    // it (NaN comparisons are always false).
    if (!Number.isFinite(ts) || Math.abs(now - ts) > params.maxSkewMs) {
      return { ok: false, reason: "timestamp_skew" };
    }
  }
  return { ok: true };
}

/** Sign a request (consumer-side helper, also used in tests). */
export function signEngineRequest(params: {
  body: string;
  installationId: string;
  secret: string;
  timestamp?: number;
}): Record<string, string> {
  const ts = String(params.timestamp ?? Date.now());
  const mac = createHmac("sha256", params.secret)
    .update(canonical(ts, params.installationId, params.body))
    .digest("hex");
  return {
    [INSTALLATION_HEADER]: params.installationId,
    [TIMESTAMP_HEADER]: ts,
    [SIGNATURE_HEADER]: `sha256=${mac}`,
  };
}
