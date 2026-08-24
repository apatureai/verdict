/**
 * Consumer replay for the canonical #72 authority vectors owned by canon (the
 * repository formerly named ui-dna). The JSON bytes are copied unchanged from
 * that repository and never generated here, which is why the mirrored fixture
 * still carries the old repository name inside it.
 */
import { authorizeGrounding, enforceGroundingAuthority } from "@apatureai/verdict-critique";
import type { EngineReviewResult } from "@apatureai/verdict-types";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_CONTRACT_VERSION,
  compareAuthorityReceipts,
  validateGroundingAuthorityReceipt,
  type GroundingAuthorityReceipt,
} from "../src/index.js";

type GoldenStatus = GroundingAuthorityReceipt["status"];
interface GoldenExpected {
  status: GoldenStatus;
  sequence: number;
  headEventHash: `sha256:${string}`;
}
interface Golden {
  contractVersion: string;
  scenarios: Record<string, Array<{ expected: GoldenExpected }>>;
  readDecisions: Array<{
    status: GoldenStatus;
    mode: "latest" | "pinned";
    expected: { serve: boolean; status: GoldenStatus; reason?: string };
  }>;
}

const fixturePath = fileURLToPath(new URL("./fixtures/authority-status.golden.json", import.meta.url));
const fixtureBytes = readFileSync(fixturePath, "utf8");
const golden = JSON.parse(fixtureBytes) as Golden;
const CHECKED_AT = "2026-07-14T20:00:00.000Z";

function receipt(expected: GoldenExpected): GroundingAuthorityReceipt {
  return {
    contractVersion: AUTHORITY_CONTRACT_VERSION,
    status: expected.status,
    sequence: expected.sequence,
    headEventHash: expected.headEventHash,
    checkedAt: CHECKED_AT,
  };
}

function blockingResult(version = "dna_A"): EngineReviewResult {
  return {
    grade: "blocked",
    overall: "blocking finding",
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
      uiDnaVersion: version,
    },
  };
}

describe("UI-DNA authority golden consumer (#72)", () => {
  it("pins a byte-identical copy of the producer fixture and contract", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "172de5431219025161134ebc445af304da3d0455705fbde1c58276cb13ba5958",
    );
    expect(golden.contractVersion).toBe(AUTHORITY_CONTRACT_VERSION);
  });

  it("accepts every published scenario receipt without changing status, sequence, or head", () => {
    for (const steps of Object.values(golden.scenarios)) {
      for (const step of steps) {
        expect(validateGroundingAuthorityReceipt(receipt(step.expected), {
          now: new Date(CHECKED_AT),
        })).toEqual(receipt(step.expected));
      }
    }
  });

  it("matches UI-DNA's exact-version pinned authorization decisions", () => {
    for (const decision of golden.readDecisions.filter((entry) => entry.mode === "pinned")) {
      expect(authorizeGrounding({ status: decision.status }).allowed).toBe(decision.expected.serve);
    }
  });

  it("replays approve A -> revoke A and removes blocking authority at publication", () => {
    const withdrawal = golden.scenarios["withdrawalDrill"] ?? [];
    const initial = receipt(withdrawal[0]!.expected);
    const revoked = receipt(withdrawal.at(-1)!.expected);
    compareAuthorityReceipts(initial, revoked);
    const result = enforceGroundingAuthority(blockingResult(), { status: revoked.status });
    expect(result.blockingEnabled).toBe(false);
    expect(result.grade).toBe("needs_work");
    expect(result.notReviewed.some((note) => note.includes("dna_A") && note.includes("revoked"))).toBe(true);
  });

  it("keeps the independent replacement B authorized", () => {
    const replacement = golden.scenarios["independentReplacement"]?.at(-1)?.expected;
    expect(replacement?.status).toBe("effective");
    const result = blockingResult("dna_B");
    expect(enforceGroundingAuthority(result, { status: replacement!.status })).toBe(result);
  });
});
