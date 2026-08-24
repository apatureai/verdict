import { passModelsFromEnv } from "../src/model-choice.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArgError, USAGE, parseArgs } from "../src/index.js";

describe("parseArgs", () => {
  it("defaults to the bundled demo site, both routes and all three viewports", () => {
    const options = parseArgs([]);
    expect(options.url).toBeUndefined();
    expect(options).toMatchObject({
      routes: ["/", "/pricing"],
      viewports: ["mobile", "tablet", "desktop"],
      outDir: "out",
      model: "auto",
      verifyStability: false,
    });
  });

  it("narrows the default routes to / when an external URL is given", () => {
    expect(parseArgs(["--url", "https://preview.example.com"]).routes).toEqual(["/"]);
  });

  it("keeps explicit routes regardless of flag order", () => {
    expect(parseArgs(["--routes", "/a,/b", "--url", "https://x.example"]).routes).toEqual(["/a", "/b"]);
    expect(parseArgs(["--url", "https://x.example", "--routes", "/a,/b"]).routes).toEqual(["/a", "/b"]);
  });

  it("parses the remaining flags", () => {
    const options = parseArgs([
      "--out",
      "artifacts",
      "--context-dir",
      "site",
      "--script",
      "s.json",
      "--model",
      "mock",
      "--viewports",
      "mobile,desktop",
      "--verify-stability",
    ]);
    expect(options).toMatchObject({
      outDir: "artifacts",
      contextDir: "site",
      script: "s.json",
      model: "mock",
      viewports: ["mobile", "desktop"],
      verifyStability: true,
    });
  });

  it("rejects unknown flags, values and empty lists", () => {
    expect(() => parseArgs(["--nope"])).toThrow(ArgError);
    expect(() => parseArgs(["--url"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--viewports", "phone"])).toThrow(/unknown viewport/);
    expect(() => parseArgs(["--model", "gpt"])).toThrow(/unknown --model/);
    expect(() => parseArgs(["--routes", " , "])).toThrow(/at least one route/);
  });

  it("ignores the bare -- that pnpm run forwards", () => {
    expect(parseArgs(["--", "--verify-stability"]).verifyStability).toBe(true);
  });

  it("recognises both help spellings", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("USAGE", () => {
  it("names an install command that exists as a root package script", () => {
    // The footer used to read `pnpm exec playwright-core install chromium`,
    // which fails from the repository root, because playwright-core is a dependency of
    // @apatureai/verdict-capture, not of the workspace root. A reader who runs --help is
    // exactly the reader who has no browser yet, so the command has to work.
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(USAGE).toContain("pnpm browser:install");
    expect(Object.keys(pkg.scripts)).toContain("browser:install");
    expect(USAGE).not.toContain("pnpm exec playwright-core");
  });

  it("documents every flag the parser accepts", () => {
    for (const flag of [
      "--url",
      "--routes",
      "--viewports",
      "--out",
      "--context-dir",
      "--script",
      "--model",
      "--verify-stability",
      "--help",
    ]) {
      expect(USAGE).toContain(flag);
    }
  });
});

describe("naming the models your endpoint actually serves", () => {
  // MODEL_BASE_URL lets a caller point anywhere, but the request still named the
  // built-in Qwen ids, so "any OpenAI-compatible endpoint" was only true for an
  // endpoint that happened to serve qwen3-vl-flash and qwen3-vl-plus. The
  // deployable runtime has read these two variables since it was written; the
  // documented quickstart did not.
  it("reads the same variable names the runtime path reads", () => {
    expect(passModelsFromEnv({ TRIAGE_MODEL: "gpt-4o-mini", DEEP_MODEL: "gpt-4o" })).toEqual({
      triage: { model: "gpt-4o-mini" },
      deep: { model: "gpt-4o" },
    });
  });

  it("lets one pass be overridden without the other", () => {
    expect(passModelsFromEnv({ DEEP_MODEL: "llava" })).toEqual({ deep: { model: "llava" } });
  });

  it("changes nothing when neither is set, so the defaults stand", () => {
    expect(passModelsFromEnv({})).toBeUndefined();
    expect(passModelsFromEnv({ TRIAGE_MODEL: "   " })).toBeUndefined();
  });
});
