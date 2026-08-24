import type { ContextBlockInput } from "@apatureai/verdict-context";
import { describe, expect, it } from "vitest";
import {
  contextGroundingParts,
  resolveGrounding,
  ungroundedDisclosure,
  withDisclosure,
  UNGROUNDED_DISCLOSURE_PREFIX,
} from "../src/index.js";

/**
 * The disclosure is the whole of what an ungrounded run tells a reader, so it is
 * held to the same rule as `JudgmentProvenance`: say what this run knows and
 * never more. Understating the loss hides a rubric-only critique; OVERSTATING it
 * is the same failure in the other direction, and would tell someone with a
 * `tokens.json` that their tokens were ignored when they were not.
 */
function context(over: Partial<ContextBlockInput> = {}): ContextBlockInput {
  return { tokens: {}, brand: null, componentLibraries: [], uiDnaVersion: null, ...over };
}

const BRAND = { description: "calm", tone: null, audience: null, do: [], dont: [] };

describe("contextGroundingParts", () => {
  it("counts only what is actually there", () => {
    expect(contextGroundingParts(context())).toEqual([]);
    expect(
      contextGroundingParts(
        context({
          tokens: { "color.brand": "#4f46e5", "space.2": "8px" },
          brand: BRAND,
          componentLibraries: [{ id: "shadcn", rubricAddendum: "…" }],
        }),
      ),
    ).toEqual(["2 design token(s)", "a brand block", "1 detected component librar(ies)"]);
  });
});

describe("ungroundedDisclosure", () => {
  it("names the reason and the greppable prefix a consumer keys on", () => {
    const line = ungroundedDisclosure("no_genome_file", "no snapshot at /repo/ui-dna.json", context());
    expect(line.startsWith(UNGROUNDED_DISCLOSURE_PREFIX)).toBe(true);
    expect(line).toContain("(no_genome_file)");
    expect(line).toContain("/repo/ui-dna.json");
    expect(line).toContain("No approved design-system rule was retrieved for any route");
  });

  it("does not deny the grounding a run did have", () => {
    const line = ungroundedDisclosure(
      "no_genome_file",
      "no snapshot",
      context({ tokens: { "color.brand": "#4f46e5" }, brand: BRAND }),
    );
    expect(line).toContain("1 design token(s), a brand block");
    expect(line).toContain("a weaker review, not an empty one");
    expect(line).not.toContain("built-in rubric alone");
  });

  it("says plainly when the repository stated nothing about its design", () => {
    const line = ungroundedDisclosure("no_genome_file", "no snapshot", context());
    expect(line).toContain("no design tokens, no brand block and no component library were resolved");
    expect(line).toContain("built-in rubric alone");
  });
});

describe("resolveGrounding", () => {
  it("reports a genome with rules as grounding, and records what ranked it", () => {
    expect(
      resolveGrounding(
        {
          available: true,
          version: "ui-dna@1",
          rules: [{ id: "a", text: "rule" }],
          source: "/repo/ui-dna.json",
        },
        context(),
        "lexical-hash-256@1",
      ),
    ).toEqual({
      grounded: true,
      uiDnaVersion: "ui-dna@1",
      ruleCount: 1,
      source: "/repo/ui-dna.json",
      embedder: "lexical-hash-256@1",
      authorityChecked: false,
    });
  });

  it("refuses to call a rule-less genome grounding, however valid its version", () => {
    const grounding = resolveGrounding(
      { available: true, version: "ui-dna@1", rules: [], source: "/repo/ui-dna.json" },
      context(),
      "lexical-hash-256@1",
    );
    expect(grounding).toMatchObject({ grounded: false, reason: "genome_has_no_rules" });
  });

  it("distinguishes a caller that resolved nothing from one that looked and found nothing", () => {
    const silent = resolveGrounding(undefined, context(), "e");
    const looked = resolveGrounding(
      { available: false, reason: "no_genome_file", detail: "no snapshot at /repo/ui-dna.json" },
      context(),
      "e",
    );
    expect(silent).toMatchObject({ grounded: false, reason: "no_genome_resolved" });
    expect(looked).toMatchObject({ grounded: false, reason: "no_genome_file" });
    if (looked.grounded) return;
    expect(looked.disclosure).toContain("/repo/ui-dna.json");
  });

  it("carries an unreadable snapshot through as its own reason", () => {
    const grounding = resolveGrounding(
      { available: false, reason: "genome_unreadable", detail: "it is not valid JSON" },
      context(),
      "e",
    );
    expect(grounding).toMatchObject({ grounded: false, reason: "genome_unreadable" });
    if (grounding.grounded) return;
    expect(grounding.disclosure).toContain("not valid JSON");
  });
});

describe("withDisclosure", () => {
  it("appends once and leaves an identical existing line alone", () => {
    expect(withDisclosure(["a"], "b")).toEqual(["a", "b"]);
    expect(withDisclosure(["a", "b"], "b")).toEqual(["a", "b"]);
  });
});
