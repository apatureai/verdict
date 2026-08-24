import type { RepoContext } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  assertVersionStamped,
  buildResultMetadata,
  critique,
  versionSpanAttributes,
} from "../src/index.js";

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: null,
  contentHash: "abc",
};

describe("buildResultMetadata (#68)", () => {
  it("stamps all four version fields", () => {
    const m = buildResultMetadata({
      engineVersion: "1.0.0",
      model: "qwen3-vl-plus",
      promptVersion: "p@3",
      captureVersion: "c@2",
      rubricVersion: "design-rubric@1",
      uiDnaVersion: "ui-dna@x",
    });
    expect(m).toEqual({
      engineVersion: "1.0.0",
      model: "qwen3-vl-plus",
      promptVersion: "p@3",
      captureVersion: "c@2",
      rubricVersion: "design-rubric@1",
      uiDnaVersion: "ui-dna@x",
    });
  });

  it("refuses a result with a missing version (no silent prompt/model change)", () => {
    expect(() =>
      buildResultMetadata({
        engineVersion: "1.0.0",
        model: "",
        promptVersion: "p@3",
        captureVersion: "c@2",
        uiDnaVersion: null,
      }),
    ).toThrow(/missing "model"/);
    expect(() => assertVersionStamped({ engineVersion: "1", model: "m", promptVersion: "", captureVersion: "c", uiDnaVersion: null })).toThrow();
  });
});

describe("versionSpanAttributes", () => {
  it("maps to the engine.* OTel attribute keys", () => {
    expect(
      versionSpanAttributes({
        engineVersion: "1",
        model: "m",
        promptVersion: "p",
        captureVersion: "c",
        rubricVersion: "design-rubric@1",
        uiDnaVersion: null,
      }),
    ).toEqual({
      "engine.engine_version": "1",
      "engine.model": "m",
      "engine.prompt_version": "p",
      "engine.capture_version": "c",
      "engine.rubric_version": "design-rubric@1",
    });
  });
});

describe("critique stamps every result", () => {
  it("carries all four versions with the resolved per-pass model + capture version", async () => {
    const result = await critique([], context, { depth: "deep" }, { captureVersion: "capture@7" });
    expect(result.metadata.model).toBe("qwen3-vl-plus");
    expect(result.metadata.captureVersion).toBe("capture@7");
    expect(result.metadata.engineVersion).toBeTruthy();
    expect(result.metadata.promptVersion).toBeTruthy();
    expect(() => assertVersionStamped(result.metadata)).not.toThrow();
  });
});
