import { PIXEL_BUDGETS } from "@apatureai/verdict-capture";
import type { RepoContext } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { critique, MockModelClient, type ModelClientFactory } from "../src/index.js";

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: null,
  contentHash: "abc",
};

describe("max_pixels budget enforcement (#69)", () => {
  it("sets the per-tier Qwen3-VL max_pixels on the model request", async () => {
    const mock = new MockModelClient();
    const factory: ModelClientFactory = () => mock;

    await critique([], context, { depth: "triage" }, { modelFactory: factory });
    expect(mock.calls[0]?.maxPixels).toBe(PIXEL_BUDGETS.triage);

    await critique([], context, { depth: "deep" }, { modelFactory: factory });
    expect(mock.calls[1]?.maxPixels).toBe(PIXEL_BUDGETS.deep);
    // deep gets a larger budget than triage (cost/quality lever).
    expect(PIXEL_BUDGETS.deep).toBeGreaterThan(PIXEL_BUDGETS.triage);
  });
});
