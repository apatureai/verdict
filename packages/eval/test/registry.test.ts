import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { ModelPromptRegistry, type RegistryStamp } from "../src/index.js";
import { sampleCalibrationReport } from "./calibration-report-fixture.js";

let registry: ModelPromptRegistry;
let exec: ReturnType<typeof pgliteExecutor>;

const stamp = (over: Partial<RegistryStamp> = {}): RegistryStamp => ({
  model: "qwen3-vl-plus",
  promptVersion: "v1",
  engineVersion: "1.0.0",
  captureVersion: "c1",
  rubricVersion: "design-rubric@1",
  ...over,
});

beforeEach(async () => {
  const db = new PGlite();
  exec = pgliteExecutor(db);
  await runMigrations(exec);
  registry = new ModelPromptRegistry(exec, {
    now: () => Date.parse("2026-07-13T00:00:00.000Z"),
    verifyAttestation: async (report) => report.attestation?.signature === "fixture-signature",
  });
});

describe("ModelPromptRegistry (#71)", () => {
  it("registers a candidate and refuses promotion without a passing eval", async () => {
    const cand = await registry.registerCandidate(stamp());
    expect(cand.status).toBe("candidate");
    await expect(registry.promote(cand.id)).rejects.toThrow(/eval gate has not passed/);
  });

  it("promotes a candidate that passed eval to the single stable version", async () => {
    const cand = await registry.registerCandidate(stamp());
    await registry.recordEval(cand.id, true);
    const promoted = await registry.promote(cand.id);
    expect(promoted.status).toBe("stable");
    expect((await registry.current())?.id).toBe(cand.id);
  });

  it("a new promotion demotes the prior stable (at most one stable)", async () => {
    const a = await registry.registerCandidate(stamp({ promptVersion: "v1" }));
    await registry.recordEval(a.id, true);
    await registry.promote(a.id);

    const b = await registry.registerCandidate(stamp({ promptVersion: "v2" }));
    await registry.recordEval(b.id, true);
    await registry.promote(b.id);

    const current = await registry.current();
    expect(current?.id).toBe(b.id);
    expect((await registry.get(a.id))?.status).toBe("rolled_back");
  });

  it("rolls back to the previous stable version", async () => {
    const a = await registry.registerCandidate(stamp({ promptVersion: "v1" }));
    await registry.recordEval(a.id, true);
    await registry.promote(a.id);
    const b = await registry.registerCandidate(stamp({ promptVersion: "v2" }));
    await registry.recordEval(b.id, true);
    await registry.promote(b.id);

    const restored = await registry.rollback();
    expect(restored?.id).toBe(a.id); // back to the last stable
    expect((await registry.current())?.id).toBe(a.id);
    expect((await registry.get(b.id))?.status).toBe("rolled_back");
  });

  it("binds the exact report id/hash and promotes blocking only with verified attestation", async () => {
    const report = sampleCalibrationReport({
      attested: true,
      overrides: {
        identity: {
          model: "qwen3-vl-plus",
          promptVersion: "v1",
          engineVersion: "1.0.0",
          captureVersion: "c1",
          rubricVersion: "design-rubric@1",
        },
      },
    });
    // The identity override changes the attested payload, so sign that final value.
    report.attestation = null;
    const signed = sampleCalibrationReport({
      attested: true,
      overrides: { ...report, attestation: null },
    });
    const candidate = await registry.registerCandidate(stamp());
    await registry.recordEval(candidate.id, true);
    const bound = await registry.bindCalibrationReport(candidate.id, signed);
    expect(bound.calibrationReportId).toBe(signed.reportId);
    expect(bound.calibrationReportHash).toMatch(/^sha256:/);

    const promoted = await registry.promote(candidate.id, { mode: "blocking" });
    expect(promoted.promotionMode).toBe("blocking");
    expect((await registry.currentCalibration())?.reportHash).toBe(bound.calibrationReportHash);
  });

  it("fails blocking promotion closed when the report is absent or unattested", async () => {
    const missing = await registry.registerCandidate(stamp());
    await registry.recordEval(missing.id, true);
    await expect(registry.promote(missing.id, { mode: "blocking" })).rejects.toThrow(/report is absent/);

    const unsigned = sampleCalibrationReport({
      overrides: {
        identity: {
          model: "qwen3-vl-plus",
          promptVersion: "v2",
          engineVersion: "1.0.0",
          captureVersion: "c1",
          rubricVersion: "design-rubric@1",
        },
      },
    });
    const candidate = await registry.registerCandidate(stamp({ promptVersion: "v2" }));
    await registry.recordEval(candidate.id, true);
    await registry.bindCalibrationReport(candidate.id, unsigned);
    await expect(registry.promote(candidate.id, { mode: "blocking" })).rejects.toThrow(/attested/);
  });

  it("rejects a report from the wrong model/capture/rubric family", async () => {
    const candidate = await registry.registerCandidate(stamp());
    await expect(registry.bindCalibrationReport(candidate.id, sampleCalibrationReport())).rejects.toThrow(
      /does not match candidate/,
    );
  });

  it("fails serving closed when the stored report id no longer matches its body", async () => {
    const report = sampleCalibrationReport({
      overrides: {
        identity: {
          model: "qwen3-vl-plus",
          promptVersion: "v1",
          engineVersion: "1.0.0",
          captureVersion: "c1",
          rubricVersion: "design-rubric@1",
        },
      },
    });
    const candidate = await registry.registerCandidate(stamp());
    await registry.recordEval(candidate.id, true);
    await registry.bindCalibrationReport(candidate.id, report);
    await registry.promote(candidate.id);

    await exec.query(
      `UPDATE model_prompt_calibration_bindings SET calibration_report_id = $2 WHERE registry_id = $1`,
      [candidate.id, "different-report"],
    );

    await expect(registry.currentCalibration()).resolves.toBeNull();
  });
});
