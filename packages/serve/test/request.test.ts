import type { JobRecord } from "@apatureai/verdict-jobs";
import { describe, expect, it } from "vitest";
import { toLocalReviewRequest } from "../src/index.js";

/**
 * The local server parses Gate's `POST /jobs` contract with the SAME
 * `toReviewInput` the production composition root uses, so what the contract
 * gained has to arrive here too, and what the operator configured locally has
 * to keep working beside it.
 */

function reviewRequest(overrides: {
  componentLibraries?: string[];
  verifyStability?: boolean;
} = {}): Record<string, unknown> {
  return {
    installationId: "local",
    repository: { owner: "apatureai", name: "demo", defaultBranch: "main" },
    pullRequest: { number: 1, headSha: "abc123", baseSha: "def456", title: "Demo", body: null },
    preview: { url: "http://127.0.0.1:5000/", provider: "local", environment: null },
    config: {
      preview: {
        source: "local",
        environment: "preview",
        urlTemplate: null,
        waitSeconds: 0,
        readySelector: null,
        readyPath: null,
        readyStatus: null,
        protectionBypassSecretName: null,
        authStateSecretName: null,
        forkPreview: false,
      },
      routes: { always: ["/"], maxPerPr: 5, map: {} },
      viewports: ["desktop"],
      darkMode: false,
      brand: null,
      rules: { gate: "none", minSeverityToComment: "nit", suppress: [] },
      tokens: { source: null, values: {} },
      ...(overrides.verifyStability !== undefined ? { verifyStability: overrides.verifyStability } : {}),
    },
    publishMode: "advisory",
    depth: "deep",
    ...(overrides.componentLibraries !== undefined
      ? { componentLibraries: overrides.componentLibraries }
      : {}),
  };
}

function job(input: unknown): JobRecord {
  const now = new Date();
  return {
    id: "job_local",
    consumer: "gate",
    installationId: "local",
    intentType: "pr_review",
    idempotencyKey: "gate:local:pr_review:1",
    depth: "deep",
    status: "running",
    input,
    priority: 0,
    resultPointer: null,
    error: null,
    attempts: 1,
    claimGeneration: 1,
    leaseOwner: "w-test",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  } as unknown as JobRecord;
}

const KEY_PREFIX = "jobs/job_local/screenshots";

describe("the operator's flag and the request's ask", () => {
  it("runs the determinism check for a request that asked, on a server started without the flag", () => {
    const request = toLocalReviewRequest(job(reviewRequest({ verifyStability: true })), {
      keyPrefix: KEY_PREFIX,
    });
    expect(request.verifyStability).toBe(true);
  });

  it("keeps running it for every job when the operator asked for it", () => {
    const request = toLocalReviewRequest(job(reviewRequest()), {
      verifyStability: true,
      keyPrefix: KEY_PREFIX,
    });
    expect(request.verifyStability).toBe(true);
  });

  it("does not let one side switch the other off", () => {
    // "Do not verify" is not something either side is trying to say, so a
    // request that asked wins over a server whose flag is simply not set.
    const request = toLocalReviewRequest(job(reviewRequest({ verifyStability: true })), {
      verifyStability: false,
      keyPrefix: KEY_PREFIX,
    });
    expect(request.verifyStability).toBe(true);
  });

  it("leaves it alone when nobody asked", () => {
    const request = toLocalReviewRequest(job(reviewRequest()), { keyPrefix: KEY_PREFIX });
    expect(request.verifyStability).toBeUndefined();
  });
});

describe("component libraries from the request and from --context-dir", () => {
  const repoContext = {
    tokens: { "color.brand": "#4f46e5" },
    brand: null,
    componentLibraries: [{ id: "chakra", rubricAddendum: "from the operator's directory" }],
    uiDnaVersion: null,
  };

  it("prefers what the request detected in the repository it is reviewing", () => {
    const request = toLocalReviewRequest(job(reviewRequest({ componentLibraries: ["radix"] })), {
      repoContext,
      keyPrefix: KEY_PREFIX,
    });
    expect(request.context.componentLibraries.map((library) => library.id)).toEqual(["radix"]);
  });

  it("still fills in from the operator's directory when the request named none", () => {
    const request = toLocalReviewRequest(job(reviewRequest()), {
      repoContext,
      keyPrefix: KEY_PREFIX,
    });
    expect(request.context.componentLibraries.map((library) => library.id)).toEqual(["chakra"]);
  });
});
