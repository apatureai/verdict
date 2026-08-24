import type { CaptureImage, RepoContext } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  activeDimensions,
  critique,
  MockModelClient,
  UNTRUSTED_CONTENT_TAG,
  type ModelRequest,
} from "../src/index.js";

/**
 * The rubric prompt was written, versioned and unit-tested long before anything
 * sent it: `critique()` shipped a one-line placeholder, so a live model would
 * have received no rubric, no grounding rules and no instruction-hierarchy
 * defense. These tests assert the wiring itself, not the prompt's wording
 * (`prompt.test.ts` owns that), so the placeholder cannot come back.
 */

const IMAGES: CaptureImage[] = [
  { route: "/", viewport: "mobile", objectKey: "a.png", width: 780, height: 1688 },
];

function context(brand: string | null): RepoContext {
  return {
    installationId: "1",
    repository: { owner: "acme", name: "site", defaultBranch: "main" },
    brand,
    tokens: {},
    uiDnaVersion: null,
    contentHash: "abc123",
  };
}

function systemMessage(request: ModelRequest | undefined): string {
  return request?.messages.find((m) => m.role === "system")?.content ?? "";
}

describe("critique() system prompt", () => {
  it("sends the frozen rubric, the grounding rules and the injection defense", async () => {
    const client = new MockModelClient();
    await critique(IMAGES, context(null), { depth: "deep" }, { modelFactory: () => client });

    const system = systemMessage(client.calls[0]);
    expect(system).toContain("You are Apature, a senior product designer");
    expect(system).toContain("RUBRIC — evaluate each finding against exactly one dimension:");
    expect(system).toContain("GROUNDING RULES (mandatory):");
    expect(system).toContain("INSTRUCTION HIERARCHY");
    expect(system).toContain(UNTRUSTED_CONTENT_TAG);
    for (const dimension of activeDimensions(false)) {
      expect(system).toContain(`- ${dimension}:`);
    }
  });

  it("suppresses the brand dimension when the repo has no brand block", async () => {
    const client = new MockModelClient();
    await critique(IMAGES, context(null), { depth: "deep" }, { modelFactory: () => client });
    const system = systemMessage(client.calls[0]);
    expect(system).toContain("The brand dimension is suppressed for this repo");
    expect(system).not.toContain("- brand: Does the UI fit the stated brand");
  });

  it("scores the brand dimension when a brand block exists", async () => {
    const client = new MockModelClient();
    await critique(
      IMAGES,
      context("tone: plain and factual"),
      { depth: "deep" },
      { modelFactory: () => client },
    );
    const system = systemMessage(client.calls[0]);
    expect(system).toContain("- brand: Does the UI fit the stated brand");
    expect(system).not.toContain("The brand dimension is suppressed for this repo");
  });
});
