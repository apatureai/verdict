import type { RepoContext } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  critique,
  DEFAULT_PASS_MODELS,
  MockModelClient,
  resolvePassModel,
  type ModelClientFactory,
} from "../src/index.js";

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: "ui-dna@2026.06.12",
  contentHash: "abc",
};

describe("critique (per-pass model abstraction)", () => {
  it("returns a version-stamped Critique implementing the core contract", async () => {
    const result = await critique([], context, { depth: "deep" });
    expect(["ship", "ship_with_nits", "needs_work", "blocked"]).toContain(result.grade);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12");
    expect(result.metadata.engineVersion).toBeTruthy();
    expect(result.validation.hallucinationDrops).toBe(0);
  });

  it("stamps the default per-pass model (triage=flash, deep=plus)", async () => {
    expect((await critique([], context, { depth: "triage" })).metadata.model).toBe("qwen3-vl-flash");
    expect((await critique([], context, { depth: "deep" })).metadata.model).toBe("qwen3-vl-plus");
    expect(DEFAULT_PASS_MODELS.deep.thinking).toBe(true);
  });

  it("swaps the model by config with no call-site change", async () => {
    const result = await critique([], context, { depth: "deep" }, {
      passModels: { deep: { model: "claude-opus-vision", backend: "self-host" } },
    });
    expect(result.metadata.model).toBe("claude-opus-vision");
  });

  it("routes through an injected ModelClient with the resolved pass settings", async () => {
    const mock = new MockModelClient("dashscope");
    const factory: ModelClientFactory = () => mock;
    await critique([], context, { depth: "deep" }, { modelFactory: factory });

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.model).toBe("qwen3-vl-plus");
    expect(mock.calls[0]?.thinking).toBe(true); // deep -> Thinking pass
  });
});

describe("resolvePassModel", () => {
  it("applies overrides over the defaults", () => {
    expect(resolvePassModel("triage")).toEqual(DEFAULT_PASS_MODELS.triage);
    expect(resolvePassModel("triage", { triage: { backend: "self-host" } })).toEqual({
      model: "qwen3-vl-flash",
      backend: "self-host",
      thinking: false,
    });
  });
});

/**
 * `critique()` runs the SAME validation tail as `assembleCritique`, so it can
 * publish the same contradiction and has to record the same fact: how many
 * findings entered the tail. Pinned from this entry point too, because a fix
 * that landed in one producer and not the other is exactly how this family of
 * defect survives a round.
 */
describe("critique records what the model produced, not only what survived", () => {
  const scripted = (findings: unknown[]): ModelClientFactory => () => ({
    backend: "mock" as const,
    async complete() {
      return {
        text: JSON.stringify({
          grade: "needs_work",
          overall: "The hero block is misaligned.",
          findings,
          notReviewed: [],
        }),
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop" as const,
      };
    },
  });

  const modelFinding = (over: Record<string, unknown> = {}) => ({
    dimension: "spacing",
    severity: "major",
    confidence: 0.9,
    route: "/pricing",
    viewport: "desktop",
    elementRef: "#hero",
    title: "Uneven gap",
    description: "The gap above the CTA is off the spacing scale.",
    suggestion: null,
    introducedByThisPr: true,
    ...over,
  });

  it("counts the findings that entered the tail when the gate deleted them all", async () => {
    // No route was captured, so the grounding gate deletes both findings.
    const result = await critique([], context, { depth: "deep" }, {
      modelFactory: scripted([modelFinding(), modelFinding({ dimension: "typography" })]),
    });

    expect(result.findings).toEqual([]);
    expect(result.validation.hallucinationDrops).toBe(2);
    expect(result.validation.modelFindingsSeen).toBe(2);
    expect(result.overall).toContain("No finding in this review survived validation");
  });

  it("REGRESSION GUARD: a model that produced nothing reports nothing seen", async () => {
    const result = await critique([], context, { depth: "deep" }, {
      modelFactory: scripted([]),
    });

    expect(result.findings).toEqual([]);
    expect(result.validation.hallucinationDrops).toBe(0);
    expect(result.validation.modelFindingsSeen).toBe(0);
    expect(result.overall).toBe("The hero block is misaligned.");
  });
});
