import type { JobRecord } from "@apatureai/verdict-jobs";
import { describe, expect, it } from "vitest";
import { capRoutes, toReviewInput, truncatedRouteReason } from "../src/index.js";

/**
 * `routes.max_per_pr` is a cost ceiling and stays one. What was wrong is that
 * the routes it dropped left no trace: `routes.always.slice(0, maxPerPr)` and
 * nothing else, so eight configured routes under the default cap of five
 * produced a review of five that nowhere said the other three existed. Not in
 * `notReviewed`, not in coverage, not in the comment. The reader's only way to
 * notice was to count their own config.
 */

const EIGHT = ["/", "/pricing", "/checkout", "/docs", "/blog", "/about", "/careers", "/legal"];

function reviewRequest(routes: { always: string[]; maxPerPr: number }) {
  return {
    installationId: "verified-installation",
    repository: { owner: "apatureai", name: "demo", defaultBranch: "main" },
    pullRequest: {
      number: 42,
      headSha: "head-sha",
      baseSha: "base-sha",
      title: "Demo PR",
      body: null,
    },
    preview: {
      url: "https://preview.example.test",
      provider: "vercel" as const,
      environment: "Preview",
    },
    config: {
      preview: {
        source: "vercel" as const,
        environment: "Preview",
        urlTemplate: null,
        waitSeconds: 0,
        readySelector: null,
        readyPath: null,
        readyStatus: null,
        protectionBypassSecretName: null,
        authStateSecretName: null,
        forkPreview: false,
      },
      routes: { ...routes, map: {} },
      viewports: ["desktop" as const],
      darkMode: false,
      brand: null,
      rules: { gate: "none" as const, minSeverityToComment: "nit" as const, suppress: [] },
      tokens: { source: null, values: {} },
    },
    publishMode: "advisory" as const,
    depth: "deep" as const,
  };
}

function job(input: unknown): JobRecord {
  const now = new Date();
  return {
    id: "job_1",
    consumer: "gate",
    installationId: "verified-installation",
    intentType: "pr_review",
    idempotencyKey: "gate:verified-installation:pr_review:one",
    depth: "deep",
    status: "running",
    input,
    priority: 0,
    resultPointer: null,
    error: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    supersededBy: null,
  } as unknown as JobRecord;
}

describe("capRoutes", () => {
  it("keeps the dropped tail instead of discarding it", () => {
    const capped = capRoutes({ always: EIGHT, maxPerPr: 5 });
    expect(capped.requested).toEqual(EIGHT);
    expect(capped.routes).toEqual(["/", "/pricing", "/checkout", "/docs", "/blog"]);
    expect(capped.truncated).toEqual(["/about", "/careers", "/legal"]);
  });

  it("drops nothing when the config fits under the cap", () => {
    const capped = capRoutes({ always: ["/", "/pricing"], maxPerPr: 5 });
    expect(capped.routes).toEqual(["/", "/pricing"]);
    expect(capped.truncated).toEqual([]);
    expect(capped.requested).toEqual(capped.routes);
  });

  it("treats the empty-config default as the ask, not as truncation", () => {
    // No route was configured, so none was dropped: reporting "/" as skipped
    // would invent a skip out of a default.
    const capped = capRoutes({ always: [], maxPerPr: 5 });
    expect(capped.requested).toEqual(["/"]);
    expect(capped.routes).toEqual(["/"]);
    expect(capped.truncated).toEqual([]);
  });
});

describe("truncatedRouteReason", () => {
  it("names the route, the setting and the limit", () => {
    // "3 routes skipped" does not tell anyone which three, and a number with no
    // setting name does not tell them where to change it.
    const reason = truncatedRouteReason("/legal", 5);
    expect(reason).toContain("/legal");
    expect(reason).toContain("routes.max_per_pr");
    expect(reason).toContain("5");
  });
});

describe("toReviewInput under the route cap", () => {
  const input = toReviewInput(job(reviewRequest({ always: EIGHT, maxPerPr: 5 })));

  it("still captures only what the cap allows", () => {
    expect(input.captureContext.routes).toEqual(["/", "/pricing", "/checkout", "/docs", "/blog"]);
    expect(input.routes.map((r) => r.route)).toEqual(input.captureContext.routes);
    expect(input.context.routes).toEqual(input.captureContext.routes);
  });

  it("names every dropped route in notReviewed", () => {
    expect(input.notReviewed).toEqual([
      truncatedRouteReason("/about", 5),
      truncatedRouteReason("/careers", 5),
      truncatedRouteReason("/legal", 5),
    ]);
  });

  it("reports the ask as the CONFIGURED routes, so coverage reads partial", () => {
    // Without this the run states "5 of 5 routes reviewed", which is full
    // coverage over a config that asked for eight.
    expect(input.requestedRoutes).toEqual(EIGHT);
    expect(input.requestedRoutes?.length).toBeGreaterThan(input.captureContext.routes.length);
  });

  it("adds nothing when nothing was dropped", () => {
    const fits = toReviewInput(job(reviewRequest({ always: ["/", "/pricing"], maxPerPr: 5 })));
    expect(fits.notReviewed).toBeUndefined();
    expect(fits.requestedRoutes).toEqual(["/", "/pricing"]);
  });

  it("adds nothing for the empty-config default either", () => {
    const empty = toReviewInput(job(reviewRequest({ always: [], maxPerPr: 5 })));
    expect(empty.notReviewed).toBeUndefined();
    expect(empty.requestedRoutes).toEqual(["/"]);
    expect(empty.captureContext.routes).toEqual(["/"]);
  });
});
