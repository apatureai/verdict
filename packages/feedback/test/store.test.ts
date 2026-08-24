import { pgliteExecutor, runMigrations, type SqlExecutor } from "@apatureai/verdict-db";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedbackStore } from "../src/index.js";

let exec: SqlExecutor;
let store: FeedbackStore;
let findingId: string;

async function seedFinding(): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO findings (installation_id, route, viewport, dimension, severity, confidence, model, prompt_version, engine_version, capture_version)
     VALUES ('1','/pricing','desktop','spacing','minor',0.7,'qwen3-vl-plus','v1','1.0.0','c1') RETURNING id`,
  );
  return rows[0]!.id;
}

beforeEach(async () => {
  const db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  exec = pgliteExecutor(db);
  store = new FeedbackStore(exec);
  findingId = await seedFinding();
});

describe("FeedbackStore.recordExplicit (#38)", () => {
  it("persists a thumbs/ignore signal with source + permission, linked to the finding", async () => {
    const rec = await store.recordExplicit({ findingId, raterId: "u1", signal: "thumbs_down", raterPermission: "owner" });
    expect(rec).toMatchObject({ findingId, raterId: "u1", signal: "thumbs_down", source: "explicit", raterPermission: "owner" });
    expect(await store.forFinding(findingId)).toHaveLength(1);
  });

  it("latest signal per (finding, rater) wins", async () => {
    await store.recordExplicit({ findingId, raterId: "u1", signal: "thumbs_up", raterPermission: "write" });
    await store.recordExplicit({ findingId, raterId: "u1", signal: "ignore", raterPermission: "write" });

    const feedback = await store.forFinding(findingId);
    expect(feedback).toHaveLength(1); // prior signal superseded
    expect(feedback[0]?.signal).toBe("ignore");
  });

  it("keeps signals from different raters", async () => {
    await store.recordExplicit({ findingId, raterId: "u1", signal: "thumbs_up", raterPermission: "owner" });
    await store.recordExplicit({ findingId, raterId: "u2", signal: "thumbs_down", raterPermission: "read" });
    expect(await store.forFinding(findingId)).toHaveLength(2);
  });
});
