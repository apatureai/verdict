import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assembleCritique,
  critiqueRouteTwoStep,
  extractJsonValues,
  salvageCritique,
  type DeepPassDeps,
  type DeepPassRoute,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";

/**
 * W1-04 regression: the deep pass must NEVER discard a pass that already found
 * real, cited findings. In the field, step 1 produced 12 correct, correctly-cited
 * findings; the blind step-2 coercion returned `{}`; Zod rejected it; ALL 12 were
 * discarded and the run published "no valid critique". This replays that exact
 * wire — the captured step-1 content with an empty `{}` step-2 — and asserts at
 * least one finding is published.
 */
const DD_STEP1_CONTENT = readFileSync(
  fileURLToPath(new URL("./fixtures/dd-step1-content.json", import.meta.url)),
  "utf8",
);

/** Step 1 (thinking) returns the captured prose/JSON; every coercion returns `{}`. */
function ddReplayClient(step1: string): ModelClient & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    backend: "dashscope",
    calls,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      calls.push(request);
      const text = request.thinking ? step1 : "{}";
      return { text, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
    },
  };
}

const deps = (client: ModelClient): DeepPassDeps => ({
  client,
  model: "qwen3-vl-plus",
  systemPrompt: "rubric",
  contextBlock: "{}",
  maxPixels: 1000,
});

const ROUTE: DeepPassRoute = {
  route: "/",
  images: [
    { objectKey: "jobs/1/s/root-desktop.png", route: "/", viewport: "desktop" },
    { objectKey: "jobs/1/s/root-mobile.png", route: "/", viewport: "mobile" },
  ],
};

describe("W1-04 — the deep pass never discards a pass it already made", () => {
  it("replays DD's step-1 (12 findings) + empty {} step-2 and publishes >= 1 finding", async () => {
    const client = ddReplayClient(DD_STEP1_CONTENT);
    const result = await critiqueRouteTwoStep(deps(client), ROUTE);

    // The whole point: nothing is discarded.
    expect(result.output).not.toBeNull();
    expect(result.salvaged).toBe(true);
    expect(result.output?.findings.length).toBeGreaterThanOrEqual(1);
    // All twelve are recovered, not just one.
    expect(result.output?.findings).toHaveLength(12);

    // The coercion genuinely returned {} (the DD failure), and the bounded repair
    // was attempted once before salvage: thinking + coercion + one repair.
    expect(client.calls).toHaveLength(3);
    expect(client.calls[1]?.responseFormat).toBe("json_object");
    expect(client.calls[2]?.maxTokens).toBeGreaterThan(0);
  });

  it("injects the route/viewport the caller knows onto every recovered finding", async () => {
    const client = ddReplayClient(DD_STEP1_CONTENT);
    const result = await critiqueRouteTwoStep(deps(client), ROUTE);
    const findings = result.output?.findings ?? [];

    expect(findings.every((f) => f.route === "/")).toBe(true);
    expect(findings.every((f) => f.viewport === "desktop" || f.viewport === "mobile")).toBe(true);
    // The model's real grounding is preserved: element_ref survives salvage.
    expect(findings.some((f) => f.elementRef === "#bell")).toBe(true);
    // Contrast findings are classified as color_contrast, not left blank.
    expect(findings.some((f) => f.dimension === "color_contrast")).toBe(true);
  });

  it("carries the salvage all the way to a published, marked critique", async () => {
    const client = ddReplayClient(DD_STEP1_CONTENT);
    const routeResult = await critiqueRouteTwoStep(deps(client), ROUTE);

    const critique = assembleCritique([routeResult], {
      // Every (route, viewport) the run captured for this route; the grounding
      // gate (W1-03) drops findings that name a shot the capture never produced,
      // so the salvaged findings' injected viewports must appear here.
      capturedShots: [
        { route: "/", viewport: "desktop" },
        { route: "/", viewport: "mobile" },
      ],
      model: "qwen3-vl-plus",
      captureVersion: "test@0",
      uiDnaVersion: null,
    });

    // Findings survive the global validation tail (uncalibrated: no confidence floor).
    expect(critique.findings.length).toBeGreaterThanOrEqual(1);
    // The recovery is not silent: the provenance marker is published.
    expect(critique.validation.salvagedFindings).toBeGreaterThan(0);
    // And the route is NOT recorded as "no valid critique".
    expect(critique.notReviewed.join(" ")).not.toContain("no valid critique");
  });
});

describe("critiqueRouteTwoStep bounded repair", () => {
  it("uses the one repair re-ask and does NOT salvage when the repair succeeds", async () => {
    const good = JSON.stringify({
      grade: "needs_work",
      overall: "repaired",
      findings: [],
      notReviewed: [],
    });
    let nonThinkingCalls = 0;
    const client: ModelClient = {
      backend: "dashscope",
      async complete(request: ModelRequest): Promise<ModelResponse> {
        if (request.thinking) {
          return { text: "prose", usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
        }
        nonThinkingCalls++;
        // First coercion fails Zod; the repair returns valid JSON.
        const text = nonThinkingCalls === 1 ? "{}" : good;
        return { text, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
      },
    };
    const result = await critiqueRouteTwoStep(deps(client), ROUTE);
    expect(result.output?.overall).toBe("repaired");
    expect(result.salvaged).toBeUndefined();
  });
});

describe("critiqueRouteTwoStep injects the caller-known coordinates on the success path", () => {
  const MOBILE_ONLY: DeepPassRoute = {
    route: "/checkout",
    images: [{ objectKey: "jobs/1/s/checkout-mobile.png", route: "/checkout", viewport: "mobile" }],
  };

  /** Step 1 prose, then a VALID coercion whose finding names a different route. */
  function coercedClient(): ModelClient & { calls: ModelRequest[] } {
    const calls: ModelRequest[] = [];
    return {
      backend: "dashscope",
      calls,
      async complete(request: ModelRequest): Promise<ModelResponse> {
        calls.push(request);
        if (request.thinking) {
          return { text: "prose", usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
        }
        // Schema-valid JSON, but the blind coercion (it saw no image) names a
        // route the request never reviewed — the class of failure where a text→
        // JSON pass re-derives a coordinate it should never have been left to guess.
        const text = JSON.stringify({
          grade: "needs_work",
          overall: "coerced",
          findings: [
            {
              dimension: "spacing",
              severity: "minor",
              confidence: 0.7,
              route: "/somewhere-else",
              viewport: "mobile",
              elementRef: "#cta",
              title: "Button crowds its neighbour",
              description: "The primary button has too little gap.",
              suggestion: "Add spacing.",
              introducedByThisPr: true,
            },
          ],
          notReviewed: [],
        });
        return { text, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
      },
    };
  }

  it("overrides the route the blind coercion emitted with the route under review", async () => {
    const result = await critiqueRouteTwoStep(deps(coercedClient()), MOBILE_ONLY);
    // A clean coercion (not salvaged), but its route is injected, not trusted: a
    // deep-pass request reviews one route, so the route is a caller-known fact.
    expect(result.salvaged).toBeUndefined();
    const finding = result.output?.findings[0];
    expect(finding?.route).toBe("/checkout");
    // The model's real grounding (element_ref, dimension) is untouched.
    expect(finding?.elementRef).toBe("#cta");
    expect(finding?.dimension).toBe("spacing");
  });

  it("tells the coercion the route and the captured viewport set so it never invents one", async () => {
    const client = coercedClient();
    await critiqueRouteTwoStep(deps(client), MOBILE_ONLY);
    // The coercion is the second call (thinking first). Its system prompt must now
    // carry the coordinates the caller knows — the exact context the field failure
    // lacked, where a blind coercion invented "desktop" on a mobile-only run.
    const coercion = client.calls[1];
    const system = coercion?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system.startsWith("Convert the review")).toBe(true);
    expect(system).toContain('"/checkout"');
    // The captured set (mobile only) is pinned as the allowed viewports, so the
    // coercion is constrained to what the run rendered instead of inventing one.
    expect(system).toContain('"viewport" MUST be one of: mobile');
  });
});

describe("salvageCritique", () => {
  it("injects the known route even when step-1 named a different one", () => {
    const step1 = JSON.stringify({
      findings: [{ title: "t", description: "spacing looks off", route: "/somewhere-else" }],
    });
    const salvaged = salvageCritique([step1], { route: "/", viewports: ["desktop"] });
    expect(salvaged?.output.findings[0]?.route).toBe("/");
    expect(salvaged?.output.findings[0]?.viewport).toBe("desktop");
  });

  it("returns null when there is nothing finding-shaped to recover", () => {
    expect(salvageCritique(["just some prose, no json here"], { route: "/", viewports: ["desktop"] })).toBeNull();
    expect(salvageCritique(["{}"], { route: "/", viewports: ["desktop"] })).toBeNull();
  });

  it("extracts JSON embedded in prose and markdown fences", () => {
    const text = 'Here is my review:\n```json\n{"findings":[{"title":"a","description":"b"}]}\n```\nDone.';
    const values = extractJsonValues(text);
    const hasFindings = values.some(
      (v) => typeof v === "object" && v !== null && Array.isArray((v as { findings?: unknown }).findings),
    );
    expect(hasFindings).toBe(true);
  });
});
