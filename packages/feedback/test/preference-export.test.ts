import { pgliteExecutor, runMigrations, type SqlExecutor } from "@apatureai/verdict-db";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { exportPreferenceDataset, FeedbackStore, ktoSourceForSignal, TrainingConsentStore } from "../src/index.js";

let exec: SqlExecutor;
let store: FeedbackStore;
let consent: TrainingConsentStore;

async function mkFinding(installation: string, dimension = "spacing"): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO findings (installation_id, job_id, route, viewport, dimension, severity, confidence, model, prompt_version, engine_version, capture_version, context_hash)
     VALUES ($1, gen_random_uuid(), '/pricing', 'desktop', $2, 'minor', 0.7, 'qwen3-vl-plus', 'v1', '1.0.0', 'c1', 'ctx-abc') RETURNING id`,
    [installation, dimension],
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

describe("exportPreferenceDataset (#43)", () => {
  it("exports labeled tuples only for consenting tenants, with verdict + KTO label", async () => {
    await consent.setConsent("yes", true);
    // "no" tenant does not consent.

    const consented = await mkFinding("yes");
    await store.recordExplicit({ findingId: consented, raterId: "u1", signal: "thumbs_up", raterPermission: "owner" });
    const notConsented = await mkFinding("no");
    await store.recordExplicit({ findingId: notConsented, raterId: "u2", signal: "thumbs_up", raterPermission: "owner" });

    const examples = await exportPreferenceDataset(exec);
    expect(examples).toHaveLength(1); // only the consenting tenant
    expect(examples[0]).toMatchObject({
      installationId: "yes",
      promptVersion: "v1",
      contextHash: "ctx-abc",
      verdict: "endorsed",
      label: "desirable",
      source: "thumbs",
      trainingGrade: true,
    });
    expect(examples[0]?.imageRef).toMatch(/^jobs\/.+\/screenshots\/\/pricing-desktop$/);
  });

  it("maps a dismissed verdict to the undesirable KTO label + source, and skips ambiguous findings", async () => {
    await consent.setConsent("yes", true);
    const dismissed = await mkFinding("yes", "color_contrast");
    await store.recordExplicit({ findingId: dismissed, raterId: "u1", signal: "ignore", raterPermission: "owner" });
    const ambiguous = await mkFinding("yes", "typography");
    await store.recordExplicit({ findingId: ambiguous, raterId: "u1", signal: "recheck", raterPermission: "owner" }); // polarity 0

    const examples = await exportPreferenceDataset(exec);
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({ verdict: "dismissed", label: "undesirable", source: "ignore" });
  });

  it("derives an implicit source from an applied-suggestion signal (#39)", async () => {
    await consent.setConsent("yes", true);
    const f = await mkFinding("yes", "consistency");
    await store.recordImplicit(f, "applied", "owner");
    const examples = await exportPreferenceDataset(exec);
    expect(examples[0]).toMatchObject({ label: "desirable", source: "implicit" });
  });

  it("maps each signal to its KTO source channel (#85 AC2)", () => {
    expect(ktoSourceForSignal("thumbs_up")).toBe("thumbs");
    expect(ktoSourceForSignal("thumbs_down")).toBe("thumbs");
    expect(ktoSourceForSignal("ignore")).toBe("ignore");
    expect(ktoSourceForSignal("applied")).toBe("implicit");
    expect(ktoSourceForSignal("recheck_resolved")).toBe("implicit");
  });

  it("filters by prompt_version", async () => {
    await consent.setConsent("yes", true);
    const f = await mkFinding("yes");
    await store.recordExplicit({ findingId: f, raterId: "u1", signal: "thumbs_up", raterPermission: "owner" });
    expect(await exportPreferenceDataset(exec, { promptVersion: "v1" })).toHaveLength(1);
    expect(await exportPreferenceDataset(exec, { promptVersion: "v2" })).toHaveLength(0);
  });
});
