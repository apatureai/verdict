import type { GeometryRect, PreviewBuildFact } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  MAX_BUILD_FACTS,
  MAX_GEOMETRY_ENTRIES,
  critiqueRouteSingleCall,
  critiqueRouteTwoStep,
  mapWithConcurrency,
  renderBuildFacts,
  renderGenomeRules,
  renderGeometry,
  runDeepPass,
  type DeepPassDeps,
  type DeepPassRoute,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";

/** Extract the `element_ref` selectors the model was shown in a rendered geometry block. */
function selectorsInBlock(block: string): Set<string> {
  const out = new Set<string>();
  for (const line of block.split("\n")) {
    const m = /^- (.+?) \([^)]*\) box /.exec(line);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

const geom = (route: string, viewport: "mobile" | "desktop", selector: string, role: string | null = null): GeometryRect => ({
  route,
  viewport,
  selector,
  role,
  rect: { x: 12, y: 34, width: 56, height: 78 },
});

/** Records calls; returns prose for the Thinking step and JSON for the coercion step. */
class TwoStepMock implements ModelClient {
  readonly backend = "mock" as const;
  readonly calls: ModelRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    this.calls.push(request);
    this.inFlight--;
    const text = request.thinking
      ? "The CTA spacing is uneven."
      : JSON.stringify({ grade: "needs_work", overall: "spacing", findings: [] });
    return { text, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
  }
}

const deps = (client: ModelClient, concurrency?: number): DeepPassDeps => ({
  client,
  model: "qwen3-vl-plus",
  systemPrompt: "rubric",
  contextBlock: '{"tokens":{}}',
  maxPixels: 1000,
  concurrency,
});

const route = (r: string): DeepPassRoute => ({
  route: r,
  images: [{ objectKey: `jobs/1/s/${r}.png`, route: r, viewport: "desktop" }],
  facts: ["contrast 2.1:1 below AA"],
});

describe("critiqueRouteTwoStep (#29)", () => {
  it("does a Thinking step then a non-thinking json_object coercion", async () => {
    const mock = new TwoStepMock();
    const result = await critiqueRouteTwoStep(deps(mock), route("/pricing"));

    expect(result.output?.grade).toBe("needs_work");
    expect(mock.calls).toHaveLength(2);
    // Step 1 = Thinking, no json; step 2 = non-thinking json_object coercion.
    expect(mock.calls[0]?.thinking).toBe(true);
    expect(mock.calls[0]?.responseFormat).toBeUndefined();
    expect(mock.calls[1]?.thinking).toBe(false);
    expect(mock.calls[1]?.responseFormat).toBe("json_object");
  });

  it("returns null output (no partial) when coercion isn't valid JSON", async () => {
    const badCoercion: ModelClient = {
      backend: "mock",
      async complete(req) {
        return {
          text: req.thinking ? "prose" : "not json at all",
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      },
    };
    const result = await critiqueRouteTwoStep(deps(badCoercion), route("/x"));
    expect(result.output).toBeNull();
  });
});

describe("runDeepPass concurrency cap", () => {
  it("runs one request per route, capped at 3 concurrent, order preserved", async () => {
    const mock = new TwoStepMock();
    const routes = ["/a", "/b", "/c", "/d", "/e"].map(route);
    const results = await runDeepPass(deps(mock, 3), routes);

    expect(results.map((r) => r.route)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
    expect(mock.maxInFlight).toBeLessThanOrEqual(3);
    expect(mock.calls).toHaveLength(10); // 5 routes x 2 steps
  });
});

describe("previewBuildFacts grounding (#98)", () => {
  const facts: PreviewBuildFact[] = [
    { kind: "hydration", message: "Text content did not match. Hydration failed.", source: "next" },
    { kind: "asset_error", message: "GET /fonts/inter.woff2 404" },
  ];

  it("renders nothing when there are no build facts (prompt byte-identical)", () => {
    expect(renderBuildFacts(undefined)).toBe("");
    expect(renderBuildFacts([])).toBe("");
  });

  it("renders a labeled, deduped, capped trusted-facts block", () => {
    const out = renderBuildFacts([...facts, ...facts]); // duplicated
    expect(out).toContain("Build/runtime signals");
    expect(out).toContain("[hydration] Text content did not match. Hydration failed. (next)");
    expect(out).toContain("[asset_error] GET /fonts/inter.woff2 404");
    expect(out.match(/\[hydration\]/g)).toHaveLength(1); // deduped
    const many = Array.from({ length: 50 }, (_, i) => ({ kind: "warning" as const, message: `w${i}` }));
    expect(renderBuildFacts(many).split("\n").filter((l) => l.startsWith("- ")).length).toBe(MAX_BUILD_FACTS);
  });

  it("threads the build facts into every route's deep-pass prompt", async () => {
    const mock = new TwoStepMock();
    await runDeepPass({ ...deps(mock), buildFacts: facts }, ["/a", "/b"].map(route));
    // The thinking step (step 1) of each route carries the build-facts block.
    const thinkingCalls = mock.calls.filter((c) => c.thinking);
    expect(thinkingCalls).toHaveLength(2);
    for (const call of thinkingCalls) {
      const userMsg = call.messages.find((m) => m.role === "user");
      expect(userMsg?.content).toContain("Build/runtime signals");
      expect(userMsg?.content).toContain("[hydration]");
    }
  });

  it("leaves the prompt without a build block when no facts are supplied", async () => {
    const mock = new TwoStepMock();
    await critiqueRouteTwoStep(deps(mock), route("/x"));
    const userMsg = mock.calls[0]?.messages.find((m) => m.role === "user");
    expect(userMsg?.content).not.toContain("Build/runtime signals");
  });
});

describe("UI-DNA genome grounding (#104)", () => {
  it("renderGenomeRules: labeled trusted block, or empty when none", () => {
    expect(renderGenomeRules(undefined)).toBe("");
    expect(renderGenomeRules([])).toBe("");
    const out = renderGenomeRules(["Buttons use the accent token", "Cards use 16px spacing"]);
    expect(out).toContain("Design-system rules (UI-DNA; trusted):");
    expect(out).toContain("- Buttons use the accent token");
  });

  it("injects the route's retrieved genome rules into its deep-pass prompt", async () => {
    const mock = new TwoStepMock();
    const r: DeepPassRoute = { ...route("/pricing"), genomeRules: ["Buttons use the accent color token"] };
    await critiqueRouteTwoStep(deps(mock), r);
    const userMsg = mock.calls.find((c) => c.thinking)?.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("Design-system rules (UI-DNA; trusted):");
    expect(userMsg?.content).toContain("accent color token");
  });

  it("leaves the prompt without a genome block when no rules are supplied", async () => {
    const mock = new TwoStepMock();
    await critiqueRouteTwoStep(deps(mock), route("/x"));
    const userMsg = mock.calls[0]?.messages.find((m) => m.role === "user");
    expect(userMsg?.content).not.toContain("Design-system rules (UI-DNA");
  });
});

describe("DOM geometry grounding (#W1-02)", () => {
  it("renders nothing when there is no geometry (prompt byte-identical)", () => {
    expect(renderGeometry(undefined)).toBe("");
    expect(renderGeometry([])).toBe("");
  });

  it("renders a labeled block grouped by viewport with selector, role, and rect", () => {
    const out = renderGeometry([
      geom("/", "desktop", "body > div > h1", "heading"),
      geom("/", "mobile", "#cta", "button"),
    ]);
    expect(out).toContain("DOM geometry (cite element_ref EXACTLY as written");
    expect(out).toContain("[desktop]");
    expect(out).toContain("[mobile]");
    expect(out).toContain("- body > div > h1 (heading) box 12,34 56x78");
    expect(out).toContain("- #cta (button) box 12,34 56x78");
  });

  it("labels a null role as generic so every entry names a role", () => {
    expect(renderGeometry([geom("/", "desktop", "#x", null)])).toContain("- #x (generic) box ");
  });

  it("INVARIANT: every selector is present — rendered ⊇ the gate's accept set", () => {
    // The gate (#32) accepts exactly the geometry selectors; the block must carry
    // every one of them or the prompt would ask for a selector the gate rejects.
    const geometry = [
      geom("/", "desktop", "body > header > nav", "navigation"),
      geom("/", "desktop", "body > main > p:nth-of-type(1)", "generic"),
      geom("/", "mobile", "#upgrade", "button"),
      geom("/", "mobile", "body > main > section:nth-of-type(3) > p:nth-of-type(2)", "generic"),
    ];
    const gateAccepts = new Set(geometry.map((g) => g.selector));
    const rendered = selectorsInBlock(renderGeometry(geometry));
    for (const selector of gateAccepts) expect(rendered.has(selector)).toBe(true);
    expect(rendered.size).toBe(gateAccepts.size);
  });

  it("caps a pathological map at MAX_GEOMETRY_ENTRIES, keeping input order", () => {
    const many: GeometryRect[] = Array.from({ length: MAX_GEOMETRY_ENTRIES + 25 }, (_, i) =>
      geom("/", "desktop", `#e${i}`, "generic"),
    );
    const rendered = selectorsInBlock(renderGeometry(many));
    expect(rendered.size).toBe(MAX_GEOMETRY_ENTRIES);
    expect(rendered.has("#e0")).toBe(true);
    expect(rendered.has(`#e${MAX_GEOMETRY_ENTRIES - 1}`)).toBe(true);
    expect(rendered.has(`#e${MAX_GEOMETRY_ENTRIES}`)).toBe(false);
  });

  it("threads the route's geometry into its deep-pass prompt, ahead of the facts", async () => {
    const mock = new TwoStepMock();
    const r: DeepPassRoute = {
      route: "/",
      images: [{ objectKey: "jobs/1/s/root.png", route: "/", viewport: "mobile" }],
      facts: ["[contrast] #upgrade (mobile): 2.39:1 below AA"],
      geometry: [geom("/", "mobile", "#upgrade", "button")],
    };
    await critiqueRouteTwoStep(deps(mock), r);
    const userMsg = mock.calls.find((c) => c.thinking)?.messages.find((m) => m.role === "user");
    const content = userMsg?.content ?? "";
    expect(content).toContain("DOM geometry (cite element_ref EXACTLY as written");
    expect(content).toContain("- #upgrade (button) box ");
    // Geometry (the map) precedes the deterministic facts (measurements on it).
    expect(content.indexOf("DOM geometry")).toBeLessThan(content.indexOf("Deterministic facts"));
  });

  it("leaves the prompt without a geometry block when none is supplied", async () => {
    const mock = new TwoStepMock();
    await critiqueRouteTwoStep(deps(mock), route("/x"));
    const userMsg = mock.calls[0]?.messages.find((m) => m.role === "user");
    expect(userMsg?.content).not.toContain("DOM geometry");
  });

  it("carries geometry on the single-call guided-decoding path too", async () => {
    const mock = new GuidedMock();
    const r: DeepPassRoute = {
      route: "/",
      images: [{ objectKey: "jobs/1/s/root.png", route: "/", viewport: "desktop" }],
      geometry: [geom("/", "desktop", "#hero", "heading")],
    };
    await critiqueRouteSingleCall(deps(mock), r);
    const userMsg = mock.calls[0]?.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("- #hero (heading) box ");
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and respects the limit", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });
});

/** Self-host vLLM mock: ONE call returns thinking + schema-valid JSON together. */
class GuidedMock implements ModelClient {
  readonly backend = "self-host" as const;
  readonly calls: ModelRequest[] = [];
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    return {
      text: JSON.stringify({ grade: "needs_work", overall: "spacing", findings: [], notReviewed: [] }),
      thinkingText: "reasoned about spacing",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      finishReason: "stop",
    };
  }
}

describe("critiqueRouteSingleCall — self-host guided decoding (#76)", () => {
  it("does ONE call combining thinking + json_schema and yields schema-valid output", async () => {
    const mock = new GuidedMock();
    const result = await critiqueRouteSingleCall(deps(mock), route("/pricing"));

    expect(result.output?.grade).toBe("needs_work");
    expect(mock.calls).toHaveLength(1); // not the two-step
    expect(mock.calls[0]?.thinking).toBe(true);
    expect(mock.calls[0]?.responseFormat).toBe("json_schema");
    expect(mock.calls[0]?.jsonSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["grade"]) });
  });

  it("runDeepPass routes to the single call when guidedDecoding is set", async () => {
    const mock = new GuidedMock();
    const results = await runDeepPass({ ...deps(mock), guidedDecoding: true }, ["/a", "/b"].map(route));
    expect(results.map((r) => r.route)).toEqual(["/a", "/b"]);
    expect(mock.calls).toHaveLength(2); // one call per route, not two
  });

  it("keeps the no-partial contract when guided output fails Zod", async () => {
    const bad: ModelClient = {
      backend: "self-host",
      async complete() {
        return {
          text: JSON.stringify({ grade: "not-a-grade" }),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      },
    };
    const result = await critiqueRouteSingleCall(deps(bad), route("/x"));
    expect(result.output).toBeNull();
  });
});
