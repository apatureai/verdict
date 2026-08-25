import { describe, expect, it } from "vitest";
import { endpointProfile, resolveContextWindowTokens } from "../src/index.js";

/**
 * F5 — the endpoint profile carries the deep-pass context window, so the C2
 * preflight resolves the same number on every surface (and actually runs). A
 * deployment overrides it with `MODEL_CONTEXT_WINDOW`; the recommended local tag
 * is `qwen3vl-32k`.
 */
describe("resolveContextWindowTokens (C2)", () => {
  it("falls back to the backend profile default when nothing is configured", () => {
    expect(resolveContextWindowTokens("ollama", {})).toBe(endpointProfile("ollama").contextWindowTokens);
    expect(resolveContextWindowTokens("dashscope", {})).toBe(32_768);
    expect(resolveContextWindowTokens("openai", {})).toBe(128_000);
  });

  it("honours a positive-integer MODEL_CONTEXT_WINDOW override on any backend", () => {
    // The 12k tag overflows: a deployment says so here and the preflight degrades.
    expect(resolveContextWindowTokens("ollama", { MODEL_CONTEXT_WINDOW: "12288" })).toBe(12_288);
    expect(resolveContextWindowTokens("dashscope", { MODEL_CONTEXT_WINDOW: "65536" })).toBe(65_536);
  });

  it("ignores a blank / non-numeric / non-positive override (keeps the profile default)", () => {
    for (const bad of ["", "  ", "lots", "0", "-4096", "3.5"]) {
      expect(resolveContextWindowTokens("ollama", { MODEL_CONTEXT_WINDOW: bad })).toBe(32_768);
    }
  });

  it("every backend profile advertises a positive context window", () => {
    for (const backend of ["dashscope", "vllm", "self-host", "openai", "ollama", "openrouter"] as const) {
      expect(endpointProfile(backend).contextWindowTokens).toBeGreaterThan(0);
    }
  });
});
