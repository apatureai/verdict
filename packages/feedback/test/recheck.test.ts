import { pgliteExecutor, runMigrations, type SqlExecutor } from "@apatureai/verdict-db";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedbackStore, weightedConsensus } from "../src/index.js";

let exec: SqlExecutor;
let store: FeedbackStore;
let findingId: string;

beforeEach(async () => {
  const db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  exec = pgliteExecutor(db);
  store = new FeedbackStore(exec);
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO findings (installation_id, route, viewport, dimension, severity, confidence, model, prompt_version, engine_version, capture_version)
     VALUES ('1','/','desktop','spacing','major',0.8,'qwen3-vl-plus','v1','1.0.0','c1') RETURNING id`,
  );
  findingId = rows[0]!.id;
});

describe("in-loop recheck labeling (#40)", () => {
  it("records resolved/unresolved automatically against the finding (implicit, no rater)", async () => {
    const resolved = await store.recordRecheck(findingId, true);
    expect(resolved).toMatchObject({ signal: "recheck_resolved", source: "implicit", raterId: null });

    await store.recordRecheck(findingId, false);
    const all = await store.forFinding(findingId);
    expect(all.map((f) => f.signal).sort()).toEqual(["recheck_resolved", "recheck_unresolved"]);
  });

  it("treats a resolved recheck as a positive training signal, unresolved as neutral", async () => {
    expect(weightedConsensus([await store.recordRecheck(findingId, true)]).score).toBeGreaterThan(0);
    const db2 = new PGlite();
    await runMigrations(pgliteExecutor(db2));
    const store2 = new FeedbackStore(pgliteExecutor(db2));
    const { rows } = await pgliteExecutor(db2).query<{ id: string }>(
      `INSERT INTO findings (installation_id, route, viewport, dimension, severity, confidence, model, prompt_version, engine_version, capture_version)
       VALUES ('1','/','desktop','spacing','major',0.8,'m','v','e','c') RETURNING id`,
    );
    expect(weightedConsensus([await store2.recordRecheck(rows[0]!.id, false)]).score).toBe(0);
  });
});
