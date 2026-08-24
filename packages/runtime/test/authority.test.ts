import { enforceGroundingAuthority } from "@apatureai/verdict-critique";
import type { EngineReviewResult } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  GroundingAuthorityError,
  compareAuthorityReceipts,
  monotonicGroundingAuthorityPort,
  validateGroundingAuthorityReceipt,
  type GroundingAuthorityKey,
  type GroundingAuthorityReceipt,
} from "../src/index.js";

const key: GroundingAuthorityKey = {
  tenantId: "tenant_1",
  repository: "apatureai/demo",
  dnaVersion: "dna@1",
};

function receipt(
  sequence: number,
  status: GroundingAuthorityReceipt["status"],
  head = String.fromCharCode(96 + sequence).repeat(64),
): GroundingAuthorityReceipt {
  return {
    contractVersion: "uidna-authority/1",
    status,
    sequence,
    headEventHash: `sha256:${head}`,
    checkedAt: "2026-07-14T20:00:00.000Z",
  };
}

function blockingResult(): EngineReviewResult {
  return {
    grade: "blocked",
    overall: "blocking issue",
    blockingEnabled: true,
    findings: [],
    notReviewed: [],
    artifacts: { annotatedScreenshots: [] },
    screenshotRetentionSeconds: 0,
    metadata: {
      engineVersion: "1",
      model: "test",
      promptVersion: "1",
      captureVersion: "1",
      uiDnaVersion: "dna@1",
    },
  };
}

describe("publication authority evidence", () => {
  it("rejects malformed and stale receipts rather than defaulting effective", () => {
    expect(() => validateGroundingAuthorityReceipt(
      { status: "effective" },
      { now: new Date("2026-07-14T20:00:01.000Z") },
    )).toThrow(GroundingAuthorityError);
    expect(() => validateGroundingAuthorityReceipt(
      receipt(1, "effective"),
      { now: new Date("2026-07-14T20:02:00.000Z"), maxAgeMs: 60_000 },
    )).toThrow(/freshness/);
  });

  it("two replicas receiving updates out of order converge on the highest sequence", async () => {
    const old = receipt(1, "effective");
    const revoked = receipt(2, "revoked");
    const queues = [[old, revoked], [revoked, old]];
    const replicas = queues.map((queue) => monotonicGroundingAuthorityPort({
      statusFor: async () => queue.shift() ?? revoked,
    }));

    await replicas[0]?.statusFor(key);
    await replicas[1]?.statusFor(key);
    await expect(replicas[0]?.statusFor(key)).resolves.toEqual(revoked);
    await expect(replicas[1]?.statusFor(key)).rejects.toMatchObject({ reason: "sequence_regression" });
    // The rejecting replica still retains the newer terminal head.
    await expect(replicas[1]?.statusFor(key)).resolves.toEqual(revoked);
  });

  it("rejects an equal-sequence conflict and a terminal revocation regression", () => {
    expect(() => compareAuthorityReceipts(
      receipt(2, "effective", "b".repeat(64)),
      receipt(2, "revoked", "c".repeat(64)),
    )).toThrow(/conflicts/);
    expect(() => compareAuthorityReceipts(
      receipt(2, "revoked"),
      receipt(3, "effective"),
    )).toThrow(/terminal/);
  });

  it("suppresses every one of 10,000 injected revoke-before-publish outcomes", () => {
    const initial = receipt(1, "effective");
    const revoked = receipt(2, "revoked");
    for (let trial = 0; trial < 10_000; trial++) {
      compareAuthorityReceipts(initial, revoked);
      const result = enforceGroundingAuthority(blockingResult(), { status: revoked.status });
      expect(result.blockingEnabled).toBe(false);
      expect(result.grade).not.toBe("blocked");
    }
  });
});
