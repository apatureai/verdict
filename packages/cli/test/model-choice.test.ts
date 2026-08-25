import { describe, expect, it } from "vitest";
import { backendFromEnv, contextWindowFromEnv } from "../src/index.js";

/**
 * F5 — the local front doors resolve the deep-pass context window from the SAME
 * `MODEL_BACKEND` the deep pass uses (default `dashscope`) and that backend's
 * endpoint profile, with a `MODEL_CONTEXT_WINDOW` override. This is what a real
 * CLI/serve path passes into the review request so the preflight runs.
 */
describe("contextWindowFromEnv (F5)", () => {
  it("defaults to the registry-default backend (dashscope, 32k) when MODEL_BACKEND is unset", () => {
    expect(backendFromEnv({})).toBeUndefined();
    expect(contextWindowFromEnv({} as NodeJS.ProcessEnv)).toBe(32_768);
  });

  it("resolves the window from the configured backend", () => {
    expect(contextWindowFromEnv({ MODEL_BACKEND: "openai" } as NodeJS.ProcessEnv)).toBe(128_000);
  });

  it("lets MODEL_CONTEXT_WINDOW override the profile default", () => {
    expect(
      contextWindowFromEnv({ MODEL_BACKEND: "ollama", MODEL_CONTEXT_WINDOW: "12288" } as NodeJS.ProcessEnv),
    ).toBe(12_288);
  });

  it("always returns a positive window (the preflight can always run)", () => {
    expect(contextWindowFromEnv({ MODEL_BACKEND: "self-host" } as NodeJS.ProcessEnv)).toBeGreaterThan(0);
  });
});
