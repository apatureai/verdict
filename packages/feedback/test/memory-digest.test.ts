import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  buildMemoryDigest,
  computeRepoPatterns,
  FeedbackStore,
  type MemoryPattern,
} from "../src/index.js";

const NOW = Date.UTC(2026, 5, 19);
const days = (n: number) => NOW - n * 86_400_000;

const pattern = (over: Partial<MemoryPattern>): MemoryPattern => ({
  key: "spacing",
  dimension: "spacing",
  acceptedWeight: 0,
  dismissedWeight: 0,
  lastSeenMs: days(1),
  ...over,
});

describe("buildMemoryDigest (#41)", () => {
  it("emits deterministic extractive facts ranked by salience, within the token budget", () => {
    const patterns = [
      pattern({ key: "accessibility", dimension: "accessibility", acceptedWeight: 5, lastSeenMs: days(1) }),
      pattern({ key: "color_contrast", dimension: "color_contrast", dismissedWeight: 4, lastSeenMs: days(2) }),
    ];
    const digest = buildMemoryDigest(patterns, { now: NOW });
    expect(digest).toContain("accessibility: consistently accepted");
    expect(digest).toContain("color_contrast: often dismissed");
    // Deterministic: same input -> identical output.
    expect(buildMemoryDigest(patterns, { now: NOW })).toBe(digest);
  });

  it("ranks recent high-evidence patterns above stale ones and respects the budget", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      pattern({ key: `d${i}`, dimension: "spacing", acceptedWeight: 1, lastSeenMs: days(i + 1) }),
    );
    const digest = buildMemoryDigest(many, { now: NOW, maxTokens: 40 });
    expect(Math.ceil(digest.length / 4)).toBeLessThanOrEqual(40);
    expect(digest.split("\n").length).toBeLessThan(50); // budget truncated
  });

  it("returns empty when there are no patterns", () => {
    expect(buildMemoryDigest([], { now: NOW })).toBe("");
  });
});

describe("computeRepoPatterns (#41)", () => {
  it("aggregates findings+feedback into per-dimension accept/dismiss weights", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const exec = pgliteExecutor(db);
    const store = new FeedbackStore(exec);

    const mk = async (dim: string): Promise<string> => {
      const { rows } = await exec.query<{ id: string }>(
        `INSERT INTO findings (installation_id, route, viewport, dimension, severity, confidence, model, prompt_version, engine_version, capture_version)
         VALUES ('1','/','desktop',$1,'minor',0.7,'m','v','e','c') RETURNING id`,
        [dim],
      );
      return rows[0]!.id;
    };

    const a11y = await mk("accessibility");
    await store.recordExplicit({ findingId: a11y, raterId: "u1", signal: "thumbs_up", raterPermission: "owner" });
    const color = await mk("color_contrast");
    await store.recordExplicit({ findingId: color, raterId: "u2", signal: "ignore", raterPermission: "public" });

    const patterns = await computeRepoPatterns(exec, "1");
    const byDim = Object.fromEntries(patterns.map((p) => [p.dimension, p]));
    expect(byDim.accessibility?.acceptedWeight).toBeCloseTo(1, 5); // owner thumbs_up
    expect(byDim.color_contrast?.dismissedWeight).toBeCloseTo(0.1, 5); // public ignore, down-weighted
  });
});
