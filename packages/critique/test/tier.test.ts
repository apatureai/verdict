import type { RepoContext } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { critique, passModelsForTier, resolvePassModel } from "../src/index.js";

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: null,
  contentHash: "abc",
};

describe("billing-tier model swap (#35)", () => {
  it("paid tier keeps qwen3-vl-plus Thinking for the deep pass", () => {
    const cfg = resolvePassModel("deep", passModelsForTier("paid"));
    expect(cfg).toEqual({ model: "qwen3-vl-plus", backend: "dashscope", thinking: true });
  });

  it("free tier routes the deep pass to qwen3-vl-flash (non-thinking)", () => {
    const cfg = resolvePassModel("deep", passModelsForTier("free"));
    expect(cfg.model).toBe("qwen3-vl-flash");
    expect(cfg.thinking).toBe(false);
  });

  it("is a config-only swap through critique() (no call-site change)", async () => {
    const free = await critique([], context, { depth: "deep" }, { passModels: passModelsForTier("free") });
    expect(free.metadata.model).toBe("qwen3-vl-flash");
    const paid = await critique([], context, { depth: "deep" }, { passModels: passModelsForTier("paid") });
    expect(paid.metadata.model).toBe("qwen3-vl-plus");
  });
});
