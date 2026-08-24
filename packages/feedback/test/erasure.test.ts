import { pgliteExecutor, runMigrations, type SqlExecutor } from "@apatureai/verdict-db";
import { InMemoryObjectStore, jobPrefix, objectKey } from "@apatureai/verdict-storage";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  eraseInstallationData,
  eraseTenant,
  FeedbackStore,
  TrainingConsentStore,
} from "../src/index.js";

let exec: SqlExecutor;
let store: FeedbackStore;
let consent: TrainingConsentStore;

async function mkFinding(installation: string, jobId: string): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO findings (installation_id, job_id, route, viewport, dimension, severity, confidence, model, prompt_version, engine_version, capture_version)
     VALUES ($1, $2, '/p', 'desktop', 'spacing', 'minor', 0.7, 'qwen3-vl-plus', 'v1', '1.0.0', 'c1') RETURNING id`,
    [installation, jobId],
  );
  return rows[0]!.id;
}

beforeEach(async () => {
  const db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  exec = pgliteExecutor(db);
  store = new FeedbackStore(exec);
  consent = new TrainingConsentStore(exec);
});

describe("eraseInstallationData (#54)", () => {
  it("deletes a tenant's findings (cascading feedback) + consent and returns its job ids", async () => {
    const jobA = "11111111-1111-1111-1111-111111111111";
    const f1 = await mkFinding("erase-me", jobA);
    await store.recordExplicit({ findingId: f1, raterId: "u1", signal: "thumbs_up", raterPermission: "owner" });
    await consent.setConsent("erase-me", true);
    // Another tenant must be untouched.
    await mkFinding("keep", "22222222-2222-2222-2222-222222222222");

    const res = await eraseInstallationData(exec, "erase-me");
    expect(res.findingsDeleted).toBe(1);
    expect(res.consentDeleted).toBe(1);
    expect(res.jobIds).toEqual([jobA]);

    // Feedback cascaded; the other tenant survives.
    expect((await exec.query("SELECT 1 FROM feedback")).rows).toHaveLength(0);
    expect((await exec.query("SELECT installation_id FROM findings")).rows).toEqual([
      { installation_id: "keep" },
    ]);
  });

  it("is idempotent — erasing an already-clean tenant deletes nothing", async () => {
    const res = await eraseInstallationData(exec, "ghost");
    expect(res).toMatchObject({ findingsDeleted: 0, consentDeleted: 0, jobIds: [] });
  });
});

describe("eraseTenant (full workflow)", () => {
  it("purges DB records AND every artifact under each affected job's prefix", async () => {
    const objects = new InMemoryObjectStore();
    const jobA = "33333333-3333-3333-3333-333333333333";
    await mkFinding("erase-me", jobA);
    // Two artifacts for the job + one belonging to another tenant's job.
    await objects.put(objectKey(jobA, "screenshot", "home-desktop"), "img");
    await objects.put(objectKey(jobA, "critique", "result.json"), "{}");
    const otherKey = objectKey("44444444-4444-4444-4444-444444444444", "screenshot", "x");
    await objects.put(otherKey, "keep");

    // Lister mirrors S3/R2 ListObjectsV2 under a prefix.
    const listKeys = (prefix: string) =>
      Promise.resolve(
        [objectKey(jobA, "screenshot", "home-desktop"), objectKey(jobA, "critique", "result.json"), otherKey].filter(
          (k) => k.startsWith(prefix),
        ),
      );

    const res = await eraseTenant(exec, objects, "erase-me", listKeys);
    expect(res).toMatchObject({ installationId: "erase-me", findingsDeleted: 1, objectsPurged: 2, jobIds: [jobA] });
    expect(jobPrefix(jobA)).toBe(`jobs/${jobA}/`);

    // The tenant's artifacts are gone; the other tenant's artifact remains.
    expect(await objects.get(objectKey(jobA, "screenshot", "home-desktop"))).toBeNull();
    expect(await objects.get(otherKey)).not.toBeNull();
  });
});
