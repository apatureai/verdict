import type { GeometryRect, StyleDigest } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  ContextBudgetError,
  citableSelectors,
  estimateImageTokens,
  estimateTextTokens,
  renderGeometry,
  resolveGeometryBudgetDecision,
  type DeepPassDeps,
  type DeepPassRoute,
  type GeometryBudget,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";
import { critiqueRouteTwoStep } from "../src/index.js";

/**
 * C2 regression: a prompt + expected completion larger than the endpoint's context
 * window makes ollama silently context-SHIFT and evict part of the geometry map
 * mid-generation, so the judge reviews a page it can no longer see. The preflight
 * must estimate the total against the window and either DEGRADE the map through
 * documented tiers (or drop it) or FAIL LOUDLY — never silently truncate.
 */

const baseStyle = (over: Partial<StyleDigest> = {}): StyleDigest => ({
  fontFamily: "Inter",
  fontSizePx: 14,
  fontWeight: 400,
  lineHeightPx: 20,
  color: "#111111",
  backgroundColor: "transparent",
  paddingPx: [8, 8, 8, 8],
  marginPx: [0, 0, 0, 0],
  gapPx: null,
  borderRadiusPx: 0,
  display: null,
  ...over,
});

/** A big geometry map: 120 distinct, long selectors — heavy on prompt chars. */
function bigGeometry(n = 120): GeometryRect[] {
  return Array.from({ length: n }, (_, i) => ({
    route: "/",
    viewport: "desktop" as const,
    selector: `body > main > section:nth-of-type(${i}) > article.card > div.inner > p.copy-${i}`,
    role: "generic",
    rect: { x: 0, y: 0, width: 200, height: 24 },
    style: baseStyle({ fontSizePx: 12 + (i % 8) }),
    label: `card ${i} body copy text long enough to matter for the budget`,
  }));
}

describe("token estimators", () => {
  it("estimates ~4 chars per token, biased to over-count", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
  });
  it("estimates image tokens from the pixel budget (~one token per 28x28 block)", () => {
    // 2 tiles at 784 px each → 2 tokens.
    expect(estimateImageTokens(2, 784)).toBe(2);
    expect(estimateImageTokens(0, 100000)).toBe(0);
  });
});

describe("resolveGeometryBudgetDecision (C2)", () => {
  const geometry = bigGeometry();
  const renderPromptText = (budget: GeometryBudget | undefined): string =>
    `SYSTEM PROMPT AND CONTEXT BLOCK\n${renderGeometry(geometry, budget)}`;

  it("returns no budget (byte-identical) when the full prompt comfortably fits", () => {
    const d = resolveGeometryBudgetDecision({
      contextWindow: 1_000_000,
      completionReserveTokens: 8192,
      imageTokens: 4115,
      renderPromptText,
    });
    expect(d.mode).toBe("fits");
    expect(d.budget).toBeUndefined();
  });

  it("degrades the geometry budget deterministically to fit a tight window", () => {
    // Choose a window that the full map overflows but a shrunk map fits.
    const full = estimateTextTokens(renderPromptText(undefined)) + 4115 + 2048;
    const window = full - 200; // just under the full total
    const d = resolveGeometryBudgetDecision({
      contextWindow: window,
      completionReserveTokens: 2048,
      imageTokens: 4115,
      renderPromptText,
    });
    expect(d.mode).toBe("degraded");
    expect(d.budget?.maxCharsPerViewport).toBeLessThan(6000);
    expect(d.estimatedTotalTokens).toBeLessThanOrEqual(window);
    // Deterministic: same inputs → same decision.
    const again = resolveGeometryBudgetDecision({
      contextWindow: window,
      completionReserveTokens: 2048,
      imageTokens: 4115,
      renderPromptText,
    });
    expect(again.budget).toEqual(d.budget);
  });

  it("drops the map entirely when no tier fits but a map-free prompt does", () => {
    const mapFree = estimateTextTokens(renderPromptText({ maxCharsPerViewport: 0 })) + 100 + 500;
    const d = resolveGeometryBudgetDecision({
      contextWindow: mapFree + 10,
      completionReserveTokens: 500,
      imageTokens: 100,
      renderPromptText,
    });
    expect(d.mode).toBe("map_dropped");
    expect(renderGeometry(geometry, d.budget)).toBe("");
  });

  it("FAILS LOUDLY when even a map-free prompt + completion overflows the window", () => {
    expect(() =>
      resolveGeometryBudgetDecision({
        // A 12,288 window with an 11,942-token expected completion cannot fit any
        // real prompt — exactly the measured 21,398-token blow-up. Fail, don't shift.
        contextWindow: 12_288,
        completionReserveTokens: 11_942,
        imageTokens: 4115,
        renderPromptText,
      }),
    ).toThrow(ContextBudgetError);
  });
});

/** A trivial backend that echoes a clean critique; records the prompt it received. */
class RecordingBackend implements ModelClient {
  readonly backend = "ollama" as const;
  readonly calls: ModelRequest[] = [];
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const text = request.thinking
      ? "Nav spacing looks off on desktop."
      : JSON.stringify({ grade: "needs_work", overall: "spacing", findings: [], notReviewed: [] });
    return { text, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
  }
}

describe("C2 — the deep pass applies the resolved budget and reports it", () => {
  const route: DeepPassRoute = {
    route: "/",
    images: [{ objectKey: "jobs/1/s/root.png", route: "/", viewport: "desktop" }],
    geometry: bigGeometry(),
  };

  it("degrades the rendered map under a tight window and returns the budget it used", async () => {
    // Measure the FULL deep prompt first (no window), then set a window just under
    // it so a shrunk map is required but a map-free prompt still fits comfortably.
    const probe = new RecordingBackend();
    await critiqueRouteTwoStep(
      { client: probe, model: "qwen3vl", systemPrompt: "rubric", contextBlock: "{}", maxPixels: 784 },
      route,
    );
    const fullChars = (probe.calls[0]?.messages ?? []).reduce((n, m) => n + m.content.length, 0);
    const reserve = 200;
    const fullTokens = Math.ceil(fullChars / 4) + 1 /* image */ + reserve;

    const backend = new RecordingBackend();
    const deps: DeepPassDeps = {
      client: backend,
      model: "qwen3vl-12k",
      systemPrompt: "rubric",
      contextBlock: "{}",
      maxPixels: 784,
      contextWindow: fullTokens - 150, // just under the full total → must shrink the map
      completionReserveTokens: reserve,
    };
    const result = await critiqueRouteTwoStep(deps, route);

    // A budget was chosen and reported, so the gate can match it.
    expect(result.geometryBudget).toBeDefined();
    // The rendered geometry the model actually saw is the degraded one, and the
    // gate's accept set derived at that budget matches what the prompt showed.
    const thinkingUser = backend.calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    const shown = new Set(
      thinkingUser
        .split("\n")
        .map((l) => /^- (.+?) \([^)]*\) box /.exec(l)?.[1])
        .filter((s): s is string => Boolean(s)),
    );
    const accept = citableSelectors(route.geometry, result.geometryBudget);
    for (const s of shown) expect(accept.has(s)).toBe(true);
  });

  it("leaves the prompt byte-identical when no window is configured", async () => {
    const backend = new RecordingBackend();
    const deps: DeepPassDeps = {
      client: backend,
      model: "qwen3vl",
      systemPrompt: "rubric",
      contextBlock: "{}",
      maxPixels: 784,
    };
    const result = await critiqueRouteTwoStep(deps, route);
    expect(result.geometryBudget).toBeUndefined();
  });
});
