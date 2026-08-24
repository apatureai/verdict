import type { RepoContext } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  critique,
  DEFAULT_MODEL_GENERATION,
  MODEL_GENERATIONS,
  passModelsForGeneration,
  passModelsForTier,
  resolvePassModel,
} from "../src/index.js";

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: null,
  contentHash: "abc",
};

describe("model-generation selection (#87)", () => {
  it("defaults to qwen3-vl (no blind swap pending the eval gate)", () => {
    expect(DEFAULT_MODEL_GENERATION).toBe("qwen3-vl");
  });

  it("pins the qwen3.5 snapshot ids and disables triage structured output (caveat)", () => {
    expect(MODEL_GENERATIONS["qwen3.5"]).toEqual({
      triageModel: "qwen3.5-flash-2026-02-23",
      deepModel: "qwen3.5-plus-2026-02-15",
      triageStructuredOutput: false,
    });
    expect(MODEL_GENERATIONS["qwen3-vl"].triageStructuredOutput).toBe(true);
  });

  it("selects a generation as a config-only swap, preserving backend + thinking flags", () => {
    const deep = resolvePassModel("deep", passModelsForGeneration("qwen3.5"));
    expect(deep).toEqual({ model: "qwen3.5-plus-2026-02-15", backend: "dashscope", thinking: true });
    const triage = resolvePassModel("triage", passModelsForGeneration("qwen3.5"));
    expect(triage).toEqual({ model: "qwen3.5-flash-2026-02-23", backend: "dashscope", thinking: false });
  });

  it("composes with the billing tier (tier override wins on the deep model)", () => {
    // Generation sets the base ids; the free-tier override still swaps the deep pass.
    const merged = { ...passModelsForGeneration("qwen3.5"), ...passModelsForTier("free") };
    expect(resolvePassModel("deep", merged).model).toBe("qwen3-vl-flash"); // tier override
    expect(resolvePassModel("triage", merged).model).toBe("qwen3.5-flash-2026-02-23"); // generation
  });

  it("flows through critique() with no call-site change", async () => {
    const res = await critique([], context, { depth: "deep" }, { passModels: passModelsForGeneration("qwen3.5") });
    expect(res.metadata.model).toBe("qwen3.5-plus-2026-02-15");
  });
});
