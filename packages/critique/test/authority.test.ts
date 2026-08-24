import { describe, expect, it } from "vitest";
import type { Critique } from "@apatureai/verdict-types";
import { authorizeGrounding, enforceGroundingAuthority, inMemoryGroundingAuthority } from "../src/index.js";

function critique(over: Partial<Critique> = {}): Critique {
  return {
    grade: "blocked",
    overall: "blocking issues found",
    findings: [],
    notReviewed: [],
    validation: { hallucinationDrops: 0, captureUnstable: false, modelFindingsSeen: 0 },
    metadata: {
      engineVersion: "1",
      model: "qwen3-vl",
      promptVersion: "1",
      captureVersion: "1",
      uiDnaVersion: "dna_1",
    },
    blockingEnabled: true,
    ...over,
  };
}

describe("JE grounding-authority enforcement (#64 consumer side)", () => {
  it("authorizeGrounding allows effective/superseded and refuses revoked/unknown", () => {
    expect(authorizeGrounding({ status: "effective" })).toEqual({ allowed: true });
    expect(authorizeGrounding({ status: "superseded" })).toEqual({ allowed: true });
    expect(authorizeGrounding({ status: "revoked" })).toEqual({ allowed: false, reason: "revoked" });
    expect(authorizeGrounding({ status: "unknown" })).toEqual({ allowed: false, reason: "unknown" });
  });

  it("an effective grounding version passes the critique through unchanged", () => {
    const c = critique();
    expect(enforceGroundingAuthority(c, { status: "effective" })).toBe(c);
  });

  it("a revoked grounding version suppresses blocking and floors a blocked grade to needs_work", () => {
    const out = enforceGroundingAuthority(critique(), { status: "revoked" });
    expect(out.blockingEnabled).toBe(false);
    expect(out.grade).toBe("needs_work");
    // the withdrawn version is named (disclosed, not silent)
    expect(out.notReviewed.some((n) => n.includes("dna_1") && n.includes("revoked"))).toBe(true);
  });

  it("preserves findings + provenance advisorily (not deletion)", () => {
    const withFindings = critique({ grade: "ship_with_nits", findings: [{ id: "f1" } as never] });
    const out = enforceGroundingAuthority(withFindings, { status: "revoked" });
    expect(out.findings).toHaveLength(1); // findings intact
    expect(out.metadata.uiDnaVersion).toBe("dna_1"); // provenance intact
    expect(out.grade).toBe("ship_with_nits"); // a non-blocking grade is untouched
    expect(out.blockingEnabled).toBe(false);
  });

  it("is idempotent (a second pass adds no duplicate note)", () => {
    const once = enforceGroundingAuthority(critique(), { status: "revoked" });
    const twice = enforceGroundingAuthority(once, { status: "revoked" });
    expect(twice.notReviewed).toEqual(once.notReviewed);
  });

  it("unknown evidence also fails closed without deleting findings", () => {
    const out = enforceGroundingAuthority(
      critique({ findings: [{ id: "f1" } as never] }),
      { status: "unknown" },
    );
    expect(out.blockingEnabled).toBe(false);
    expect(out.grade).toBe("needs_work");
    expect(out.findings).toHaveLength(1);
    expect(out.notReviewed.some((n) => n.includes("unknown at publish"))).toBe(true);
  });

  it("the in-memory mirror never defaults an unlisted version to effective", () => {
    const mirror = inMemoryGroundingAuthority([{ uiDnaVersion: "dna_1", status: "revoked" }]);
    expect(mirror.statusFor("dna_1").status).toBe("revoked");
    expect(mirror.statusFor("dna_2").status).toBe("unknown");
    expect(mirror.statusFor(null).status).toBe("unknown");
  });
});
