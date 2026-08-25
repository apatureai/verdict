import { describe, expect, it } from "vitest";
import {
  critiqueRouteTwoStep,
  substantiveText,
  type DeepPassDeps,
  type DeepPassRoute,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";

/**
 * C1 regression: when the backend streams the substantive critique on the
 * REASONING channel (ollama qwen3vl with thinking:true streams 100% of its output
 * there — measured res-002.sse: content 0 chars, reasoning 43,678 chars), the
 * pipeline must feed that reasoning payload to the coercion step, not the empty
 * content channel. The historic bug fed `thinking.text` (content only), so step 2
 * coerced "" and the model returned an empty-but-VALID `{findings:[]}` that parsed
 * and published as a clean review — the exact W1-04 silent-degradation class.
 */

const deps = (client: ModelClient): DeepPassDeps => ({
  client,
  model: "qwen3vl",
  systemPrompt: "rubric",
  contextBlock: "{}",
  maxPixels: 1000,
});

const ROUTE: DeepPassRoute = {
  route: "/",
  images: [{ objectKey: "jobs/1/s/root-desktop.png", route: "/", viewport: "desktop" }],
};

/** The finding-shaped prose a Thinking pass emits (partial JSON, no full schema). */
const REASONING_PROSE = JSON.stringify({
  findings: [
    {
      title: "Footer link is low contrast",
      description: "The `body > footer > a` link sits at roughly 2.4:1 against its background.",
      element_ref: "body > footer > a",
    },
  ],
});

/**
 * Backend that streams EVERYTHING on the reasoning channel (content empty), like
 * ollama qwen3vl. The coercion step (thinking:false) converts whatever user prose
 * it is actually given into JSON — so it produces a finding IFF the pipeline
 * forwarded the reasoning payload, and an empty critique if it forwarded "".
 */
class ReasoningOnlyBackend implements ModelClient {
  readonly backend = "ollama" as const;
  readonly calls: ModelRequest[] = [];
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    if (request.thinking) {
      // The whole critique lands on reasoning; content is empty.
      return {
        text: "",
        thinkingText: REASONING_PROSE,
        usage: { inputTokens: 2000, outputTokens: 500, cachedTokens: 0 },
        finishReason: "stop",
      };
    }
    // Coercion: echo the finding only when it actually received the prose.
    const userMsg = request.messages.find((m) => m.role === "user");
    const prose = userMsg?.content ?? "";
    const findings = prose.includes("Footer link is low contrast")
      ? [
          {
            dimension: "color_contrast",
            severity: "major",
            confidence: 0.7,
            route: "/",
            viewport: "desktop",
            elementRef: "body > footer > a",
            title: "Footer link is low contrast",
            description: "The footer link sits at roughly 2.4:1 against its background.",
            suggestion: null,
            introducedByThisPr: false,
          },
        ]
      : [];
    const grade = findings.length > 0 ? "needs_work" : "ship";
    const overall = findings.length > 0 ? "one contrast issue" : "Review missing: no review provided.";
    return {
      text: JSON.stringify({ grade, overall, findings, notReviewed: [] }),
      usage: { inputTokens: 100, outputTokens: 40, cachedTokens: 0 },
      finishReason: "stop",
    };
  }
}

describe("substantiveText — picks the channel the answer is actually on", () => {
  it("returns content when the backend put the answer there", () => {
    expect(
      substantiveText({ text: "real answer", thinkingText: "cot", usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" }),
    ).toBe("real answer");
  });

  it("falls back to the reasoning channel when content is empty (ollama qwen3vl)", () => {
    expect(
      substantiveText({ text: "", thinkingText: "the whole critique", usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" }),
    ).toBe("the whole critique");
  });

  it("is empty only when BOTH channels are empty", () => {
    expect(
      substantiveText({ text: "   ", thinkingText: undefined, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" }),
    ).toBe("");
  });
});

describe("C1 — a content-empty / reasoning-full stream still produces findings", () => {
  it("forwards the reasoning payload to coercion and publishes the finding", async () => {
    const backend = new ReasoningOnlyBackend();
    const result = await critiqueRouteTwoStep(deps(backend), ROUTE);

    // The coercion step received the reasoning-derived prose, not "".
    const coercionUser = backend.calls[1]?.messages.find((m) => m.role === "user");
    expect(coercionUser?.content).toContain("Footer link is low contrast");

    // The finding survives rather than being published as an empty clean review.
    expect(result.output).not.toBeNull();
    expect(result.output?.findings).toHaveLength(1);
    expect(result.output?.findings[0]?.elementRef).toBe("body > footer > a");
    expect(result.output?.grade).toBe("needs_work");
  });
});

/** Backend that returns a genuinely EMPTY response on both channels. */
class EmptyBackend implements ModelClient {
  readonly backend = "ollama" as const;
  readonly calls: ModelRequest[] = [];
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    return { text: "", thinkingText: "", usage: { inputTokens: 2000, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
  }
}

describe("C1 — a genuinely empty model response is a FAILURE, not an empty critique", () => {
  it("reports the route as unreviewed (output null) rather than a clean pass", async () => {
    const backend = new EmptyBackend();
    const result = await critiqueRouteTwoStep(deps(backend), ROUTE);

    // Reported as a failure, not published as `{findings:[]}` "nothing wrong".
    expect(result.output).toBeNull();
    // And we never even ran the coercion on an empty payload — it cannot succeed.
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.thinking).toBe(true);
  });
});
