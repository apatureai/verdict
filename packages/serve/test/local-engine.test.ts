import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signEngineRequest, type ApiRequest } from "@apatureai/verdict-api";
import {
  fixturesDir,
  parseArgs,
  runCli,
  serveDirectory,
  UI_DNA_FILENAME,
  UNGROUNDED_DISCLOSURE_PREFIX,
  type RunIo,
  type StaticSite,
} from "@apatureai/verdict-cli";
import { NO_MODEL_DISCLOSURE_PREFIX, type EngineReviewResult } from "@apatureai/verdict-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactToken, createLocalEngine, type LocalEngine } from "../src/index.js";
import { fakeBrowser } from "./fake-browser.js";

/**
 * The HTTP job API end to end against a FAKE browser: the bundled demo site is
 * really served, the request really goes through HMAC verification and the real
 * `JobStore`, the real orchestrator really runs, the grounding gate really
 * deletes the two ungrounded findings in the bundled script, and the artifacts
 * are really written. No Chromium, no model and no network.
 *
 * The load-bearing assertion is the comparison with the CLI: the same input
 * through the two front doors must produce the same review, because they are
 * the same pipeline. If they ever diverge, one of them is lying.
 */

const SECRET = "serve-hmac-secret";
const DEMO_ROOT = join(fixturesDir(), "demo-site");

let site: StaticSite;
let engine: LocalEngine;
let outRoot: string;

beforeAll(async () => {
  site = await serveDirectory(DEMO_ROOT);
  outRoot = await mkdtemp(join(tmpdir(), "je-serve-"));
  engine = await createLocalEngine({
    secret: SECRET,
    outRoot,
    contextDir: DEMO_ROOT,
    model: "canned",
    env: {},
    // Effectively disables the background poll so `drainOnce` is the only thing
    // that moves the queue, which keeps these tests deterministic.
    workerPollMs: 600_000,
    launchBrowser: async () => fakeBrowser(),
  });
  await engine.listen(0);
});

afterAll(async () => {
  await engine.close();
  await site.close();
});

function signed(method: string, path: string, installationId: string, bodyObj?: unknown): ApiRequest {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  return { method, path, headers: signEngineRequest({ body, installationId, secret: SECRET }), body };
}

/** Gate's `POST /jobs` request contract, which this server accepts verbatim. */
function reviewRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installationId: "local",
    repository: { owner: "apatureai", name: "demo", defaultBranch: "main" },
    pullRequest: { number: 7, headSha: "abc123", baseSha: "def456", title: "Demo", body: null },
    preview: { url: site.baseUrl, provider: "local", environment: null },
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
      routes: { always: ["/", "/pricing"], maxPerPr: 5, map: {} },
      viewports: ["mobile", "tablet", "desktop"],
      darkMode: false,
      brand: null,
      rules: { gate: "nits", minSeverityToComment: "nit", suppress: [] },
      tokens: { source: null, values: {} },
    },
    publishMode: "advisory",
    depth: "deep",
    ...overrides,
  };
}

/** Submit, drain the worker, and poll: the full cycle a consumer performs. */
async function review(
  idempotencyKey: string,
  request: Record<string, unknown> = reviewRequest(),
): Promise<{ jobId: string; body: { state: string; error?: string; result?: EngineReviewResult } }> {
  const post = await engine.handle(
    signed("POST", "/jobs", "local", { idempotencyKey, depth: request.depth, request }),
  );
  expect(post.status).toBe(202);
  const jobId = (post.body as { jobId: string }).jobId;
  await engine.drainOnce();
  const got = await engine.handle(signed("GET", `/jobs/${jobId}`, "local"));
  return { jobId, body: got.body as { state: string; error?: string; result?: EngineReviewResult } };
}

/** The same review through the CLI, for the equivalence comparison. */
async function viaCli(args: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "je-serve-cli-"));
  const io: RunIo = {
    log: () => undefined,
    error: () => undefined,
    env: {},
    launchBrowser: async () => fakeBrowser(),
  };
  const code = await runCli(
    parseArgs([
      "--url",
      site.baseUrl,
      "--routes",
      "/,/pricing",
      "--context-dir",
      DEMO_ROOT,
      "--model",
      "canned",
      "--out",
      dir,
      ...args,
    ]),
    io,
  );
  expect(code).toBe(0);
  return dir;
}

describe("POST /jobs -> GET /jobs/:id (the real cycle)", () => {
  it("returns a real review: grounded findings, artifacts and version metadata", async () => {
    const { body } = await review("real-cycle");
    expect(body.state).toBe("completed");
    const result = body.result as EngineReviewResult;

    // The bundled script emits five findings; two cite a route and an element
    // the capture never produced and the gate deletes both.
    expect(result.findings.map((finding) => finding.element).sort()).toEqual([
      "#hero-title",
      "#icon-close",
      "#plan-scale-cta",
    ]);
    expect(JSON.stringify(result)).not.toContain("#pricing-table");
    expect(JSON.stringify(result)).not.toContain("/checkout");

    expect(result.metadata.captureVersion).toBe("chromium-playwright@1");
    expect(result.metadata.promptVersion).not.toBe("stub@0");
    expect(result.metadata.captureVersion).not.toBe("stub@0");
    expect(result.artifacts.annotatedScreenshots.length).toBeGreaterThan(0);
    expect(result.artifacts.engineDebugUrl).toContain("/artifacts/jobs/");
  });

  it("produces the same review as the CLI for the same input", async () => {
    const cliDir = await viaCli([]);
    const { jobId, body } = await review("cli-equivalence");
    const http = body.result as EngineReviewResult;
    const cli = JSON.parse(await readFile(join(cliDir, "review.json"), "utf8")) as EngineReviewResult;

    // Everything the two front doors must agree on, which is the whole result
    // except the two things that are legitimately per-front-door: where the
    // bytes live (`artifacts`, and the screenshot id that indexes them) and
    // which front door ran (`provenance.engine`). Comparing the remainder as
    // one object, rather than field by field, is what turns a future
    // divergence into a failing test instead of an unnoticed difference.
    const comparable = (result: EngineReviewResult): unknown => {
      const { artifacts: _artifacts, findings, provenance, ...rest } = result;
      const { engine: _engine, ...attestation } = provenance ?? {};
      return {
        ...rest,
        provenance: attestation,
        findings: findings.map(({ screenshotId: _screenshotId, ...finding }) => finding),
      };
    };
    expect(comparable(http)).toEqual(comparable(cli));
    expect(http.provenance?.engine).toBe("verdict-http");
    expect(cli.provenance?.engine).toBe("verdict-cli");

    // The measurements and the geometry map are the same page, measured twice.
    const jobDir = join(outRoot, "jobs", jobId);
    expect(await readFile(join(jobDir, "deterministic-facts.txt"), "utf8")).toBe(
      await readFile(join(cliDir, "deterministic-facts.txt"), "utf8"),
    );
    expect(await readFile(join(jobDir, "geometry.json"), "utf8")).toBe(
      await readFile(join(cliDir, "geometry.json"), "utf8"),
    );
    expect(await readFile(join(jobDir, "system-prompt.txt"), "utf8")).toBe(
      await readFile(join(cliDir, "system-prompt.txt"), "utf8"),
    );
  });

  it("writes the CLI's artifact set per job, including the screenshots", async () => {
    const { jobId } = await review("artifact-set");
    const jobDir = join(outRoot, "jobs", jobId);
    expect((await readdir(jobDir)).sort()).toEqual([
      "deterministic-facts.txt",
      "geometry.json",
      "review.json",
      "screenshots",
      "system-prompt.txt",
    ]);
    expect((await readdir(join(jobDir, "screenshots"))).sort()).toEqual(["index", "pricing"]);
    expect((await readdir(join(jobDir, "screenshots", "index"))).sort()).toEqual([
      "desktop.png",
      "mobile.png",
      "tablet.png",
    ]);
  });

  it("serves review.json byte-identical to the polled result", async () => {
    const { jobId, body } = await review("artifact-bytes");
    const onDisk = JSON.parse(
      await readFile(join(outRoot, "jobs", jobId, "review.json"), "utf8"),
    ) as EngineReviewResult;
    expect(onDisk).toEqual(body.result);
  });
});

describe("provenance: a result nothing judged says so in the payload", () => {
  it("stamps model_backed false and discloses it in notReviewed and overall", async () => {
    const { body } = await review("provenance-canned");
    const result = body.result as EngineReviewResult;

    expect(result.provenance).toMatchObject({
      model_backed: false,
      source: "canned",
      engine: "verdict-http",
      model: null,
    });
    expect(result.provenance?.detail).toContain("canned client");
    expect(result.notReviewed[0]?.startsWith(NO_MODEL_DISCLOSURE_PREFIX)).toBe(true);
    expect(result.overall.startsWith(NO_MODEL_DISCLOSURE_PREFIX)).toBe(true);
    // The disclosure has to name the grade, because the payload still carries one.
    expect(result.notReviewed[0]).toContain("the grade");
  });

  it("is stamped under the mock client too, where there is not even replayed text", async () => {
    const mockRoot = await mkdtemp(join(tmpdir(), "je-serve-mock-"));
    const mock = await createLocalEngine({
      secret: SECRET,
      outRoot: mockRoot,
      contextDir: DEMO_ROOT,
      model: "mock",
      env: {},
      workerPollMs: 600_000,
      launchBrowser: async () => fakeBrowser(),
    });
    try {
      await mock.listen(0);
      const post = await mock.handle(
        signed("POST", "/jobs", "local", {
          idempotencyKey: "mock-run",
          depth: "deep",
          request: reviewRequest(),
        }),
      );
      const jobId = (post.body as { jobId: string }).jobId;
      await mock.drainOnce();
      const got = await mock.handle(signed("GET", `/jobs/${jobId}`, "local"));
      const result = (got.body as { result: EngineReviewResult }).result;

      expect(result.findings).toEqual([]);
      expect(result.provenance?.model_backed).toBe(false);
      expect(result.notReviewed[0]?.startsWith(NO_MODEL_DISCLOSURE_PREFIX)).toBe(true);
      // The measurements are real even here, which is the whole point of the split.
      const facts = await readFile(join(mockRoot, "jobs", jobId, "deterministic-facts.txt"), "utf8");
      expect(facts).toContain("[contrast] / mobile #hero-subtitle");
    } finally {
      await mock.close();
    }
  });
});

describe("failures are typed, never an empty success", () => {
  it("fails the job with invalid_review_request instead of reviewing nothing", async () => {
    const { body } = await review("bad-request", reviewRequest({ preview: { url: "ftp://nope", provider: "local", environment: null } }));
    expect(body.state).toBe("failed");
    expect(body.error).toContain("invalid_review_request");
    expect(body.result).toBeUndefined();
  });

  it("fails a request whose installation does not match the signed job", async () => {
    const { body } = await review("tenant-mismatch", reviewRequest({ installationId: "someone-else" }));
    expect(body.state).toBe("failed");
    expect(body.error).toContain("invalid_review_request");
  });

  it("refuses an unsigned submission", async () => {
    const body = JSON.stringify({ idempotencyKey: "unsigned", depth: "deep", request: reviewRequest() });
    const res = await engine.handle({ method: "POST", path: "/jobs", headers: {}, body });
    expect(res.status).toBe(401);
  });
});

describe("artifact serving", () => {
  it("serves a screenshot to a correctly signed URL and refuses an unsigned one", async () => {
    const { jobId } = await review("artifact-serving");
    const key = `jobs/${jobId}/screenshots/index/mobile.png`;
    const base = engine.baseUrl();

    const ok = await fetch(`${base}/artifacts/${key}?token=${artifactToken(SECRET, key)}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await ok.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const unsigned = await fetch(`${base}/artifacts/${key}`);
    expect(unsigned.status).toBe(401);
    const wrongKey = await fetch(
      `${base}/artifacts/${key}?token=${artifactToken(SECRET, "jobs/other/screenshots/index/mobile.png")}`,
    );
    expect(wrongKey.status).toBe(401);
  });

  it("answers a directory key with an index of what the review left behind", async () => {
    const { jobId } = await review("artifact-index");
    const key = `jobs/${jobId}`;
    const res = await fetch(`${engine.baseUrl()}/artifacts/${key}?token=${artifactToken(SECRET, key)}`);
    expect(res.status).toBe(200);
    const index = (await res.json()) as { entries: Array<{ name: string }> };
    expect(index.entries.map((entry) => entry.name).sort()).toEqual([
      "deterministic-facts.txt",
      "geometry.json",
      "review.json",
      "screenshots",
      "system-prompt.txt",
    ]);
  });
});

describe("health", () => {
  it("reports live and ready over the real socket", async () => {
    const base = engine.baseUrl();
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: "ready",
      components: { database: true, capture: true, worker: true },
    });
  });
});

/**
 * `routes.max_per_pr` is the per-PR cost ceiling and it stays. What it used to
 * do besides capping was disappear: `routes.always.slice(0, maxPerPr)` was the
 * whole implementation, so the dropped tail was not in `notReviewed`, not in
 * coverage, and not in the comment. A config asking for eight routes got a
 * review of the first three that read like a review of everything.
 *
 * This is the assertion over the REAL HTTP cycle: a signed submission, the real
 * job store, the real orchestrator, and the served `review.json` a consumer
 * actually reads.
 */
describe("the route cap says which routes it dropped", () => {
  const EIGHT = ["/", "/pricing", "/checkout", "/docs", "/blog", "/about", "/careers", "/legal"];

  function cappedRequest(maxPerPr: number): Record<string, unknown> {
    const base = reviewRequest();
    const config = base.config as Record<string, unknown>;
    return {
      ...base,
      config: { ...config, routes: { always: EIGHT, maxPerPr, map: {} } },
    };
  }

  it("names every truncated route on the wire result, and reports partial coverage", async () => {
    const { body } = await review("gate:local:pr_review:capped", cappedRequest(3));
    expect(body.state).toBe("completed");
    const result = body.result as EngineReviewResult;

    // The ask is the configured eight, not the capped three, so a consumer sees
    // a partial review rather than "3 of 3 routes reviewed".
    expect(result.coverage?.routesRequested).toEqual(EIGHT);
    expect(result.coverage?.routesReviewed).toEqual(["/", "/pricing", "/checkout"]);

    for (const route of ["/docs", "/blog", "/about", "/careers", "/legal"]) {
      expect(result.notReviewed).toContain(
        `route ${route} (over the routes.max_per_pr limit of 3)`,
      );
    }
  });

  it("says nothing extra when the config fits under the cap", async () => {
    const { body } = await review("gate:local:pr_review:uncapped");
    const result = body.result as EngineReviewResult;
    expect(result.coverage?.routesRequested).toEqual(["/", "/pricing"]);
    expect(result.notReviewed.some((line) => line.includes("max_per_pr"))).toBe(false);
  });
});

/**
 * The local HTTP server had the same gap the CLI did: `runLocalReview` passed no
 * genome and no embedder, so every job this server ever completed was critiqued
 * without the repository's own design system, which is the thing the product is
 * for. Both front doors now resolve one from the operator's `--context-dir`, and
 * both say so when there is none, which is what keeps the equivalence test above
 * meaningful rather than an agreement between two ungrounded runs.
 */
describe("design-system grounding over the job API", () => {
  it("discloses on the wire result that nothing grounded a review of a genome-less directory", async () => {
    // The bundled demo site has tokens and a brand block and no UI-DNA snapshot,
    // which is the common case and is exactly what the disclosure describes.
    const { body } = await review("grounding-absent");
    const result = body.result as EngineReviewResult;

    expect(result.metadata.uiDnaVersion).toBeNull();
    const disclosure = result.notReviewed.find((line) =>
      line.startsWith(UNGROUNDED_DISCLOSURE_PREFIX),
    );
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain("no_genome_file");
    expect(disclosure).toContain(UI_DNA_FILENAME);
    // It states the loss without overstating it: the tokens and the brand block
    // this directory does carry still grounded the critique.
    expect(disclosure).toContain("design token(s)");
    expect(disclosure).toContain("a brand block");
  });

  it("grounds a review on a snapshot the operator's directory does carry", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "je-serve-dna-"));
    await writeFile(
      join(contextDir, UI_DNA_FILENAME),
      JSON.stringify({
        snapshot: {
          id: "snap_1",
          dna_version: "ui-dna@2026.06.12",
          approval_state: "approved",
          authority: {
            contract_version: "uidna-authority/1",
            status: "effective",
            sequence: 1,
            head_event_hash: `sha256:${"b".repeat(64)}`,
            checked_at: "2026-06-12T00:00:00.000Z",
          },
        },
        items: [
          {
            field_id: "spacing.scale",
            kind: "spacing",
            value: { scale: [4, 8, 12, 16] },
            applicability: { component_kinds: ["card"] },
          },
        ],
      }),
    );
    const grounded = await createLocalEngine({
      secret: SECRET,
      outRoot: await mkdtemp(join(tmpdir(), "je-serve-out-")),
      contextDir,
      model: "canned",
      env: {},
      workerPollMs: 600_000,
      launchBrowser: async () => fakeBrowser(),
    });
    try {
      await grounded.listen(0);
      const post = await grounded.handle(
        signed("POST", "/jobs", "local", {
          idempotencyKey: "grounding-present",
          depth: "deep",
          request: reviewRequest(),
        }),
      );
      expect(post.status).toBe(202);
      const jobId = (post.body as { jobId: string }).jobId;
      await grounded.drainOnce();
      const got = await grounded.handle(signed("GET", `/jobs/${jobId}`, "local"));
      const result = (got.body as { result?: EngineReviewResult }).result as EngineReviewResult;

      expect(result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12");
      expect(result.notReviewed.some((line) => line.startsWith(UNGROUNDED_DISCLOSURE_PREFIX))).toBe(
        false,
      );
      // Grounded, and honest about the one check a local run cannot perform.
      expect(result.notReviewed.join("\n")).toContain(
        "grounding withheld: authority for UI-DNA version ui-dna@2026.06.12 was unknown at publish",
      );
      expect(result.blockingEnabled).toBe(false);
    } finally {
      await grounded.close();
    }
  });
});
