import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadGoldenResult } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  applyCalibrationTransform,
  calibrationReportHash,
  createCalibrationRuntimeBinding,
  parseCalibrationReport,
  serializeCalibrationReport,
  validateCalibrationReport,
} from "../src/index.js";
import { sampleCalibrationReport } from "./calibration-report-fixture.js";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");
const fixturePath = fileURLToPath(new URL("../fixtures/calibration-report.v1.golden.json", import.meta.url));

describe("CalibrationReportV1 (#160)", () => {
  it("reconstructs the committed artifact byte-for-byte and content-addresses it", () => {
    const report = sampleCalibrationReport();
    const committed = readFileSync(fixturePath, "utf8");
    expect(committed).toBe(`${JSON.stringify(report, null, 2)}\n`);
    const parsed = parseCalibrationReport(committed, {}, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeCalibrationReport(parsed.report)).toBe(serializeCalibrationReport(report));
    expect(parsed.reportHash).toBe(calibrationReportHash(report));
    expect(parsed.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("binds the authoritative wire golden to this exact report and identity", () => {
    const report = sampleCalibrationReport();
    const wire = loadGoldenResult();
    expect(wire.calibration?.reportHash).toBe(calibrationReportHash(report));
    expect(report.identity).toMatchObject({
      model: wire.metadata.model,
      promptVersion: wire.metadata.promptVersion,
      engineVersion: wire.metadata.engineVersion,
      captureVersion: wire.metadata.captureVersion,
      rubricVersion: wire.metadata.rubricVersion,
    });
  });

  it("reconstructs and applies the serialized isotonic map", () => {
    const transform = sampleCalibrationReport().transform;
    expect(applyCalibrationTransform(transform, 0.65)).toBeCloseTo(0.55, 10);
    expect(applyCalibrationTransform(JSON.parse(JSON.stringify(transform)), 0.65)).toBeCloseTo(0.55, 10);
  });

  it.each([
    ["stale", { validUntil: "2026-07-12T00:00:00.000Z" }],
    ["insufficient_evidence", { evidenceStatus: "insufficient_evidence" as const }],
  ])("rejects %s reports", (_name, overrides) => {
    const result = validateCalibrationReport(sampleCalibrationReport({ overrides }), {}, NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects non-finite, malformed, cross-identity, and wrong-manifest reports", () => {
    const nonFinite = sampleCalibrationReport();
    nonFinite.thresholds.postFilterMinConfidence = Number.NaN;
    expect(validateCalibrationReport(nonFinite, {}, NOW)).toMatchObject({ ok: false, code: "malformed" });

    const malformed = sampleCalibrationReport();
    malformed.transform.knots[1]!.calibrated = -1;
    expect(validateCalibrationReport(malformed, {}, NOW)).toMatchObject({ ok: false, code: "malformed" });

    expect(
      validateCalibrationReport(sampleCalibrationReport(), { model: "different-model" }, NOW),
    ).toMatchObject({ ok: false, code: "wrong_identity" });
    expect(
      validateCalibrationReport(sampleCalibrationReport(), { evalManifestHash: `sha256:${"f".repeat(64)}` }, NOW),
    ).toMatchObject({ ok: false, code: "wrong_manifest" });
  });

  it("rejects empty or internally inconsistent evidence counts", () => {
    const empty = sampleCalibrationReport();
    empty.sampleCounts.fit = 0;
    expect(validateCalibrationReport(empty, {}, NOW)).toMatchObject({
      ok: false,
      code: "insufficient_evidence",
    });

    const inconsistent = sampleCalibrationReport();
    inconsistent.sampleCounts.byCohort.visual_text_conflict = 19;
    expect(validateCalibrationReport(inconsistent, {}, NOW)).toMatchObject({
      ok: false,
      code: "insufficient_evidence",
    });
  });

  it("creates a runtime binding with exact provenance and report-owned thresholds", () => {
    const report = sampleCalibrationReport();
    const resolved = createCalibrationRuntimeBinding(report, "blocking", report.identity, NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.binding.reference).toMatchObject({
      reportId: report.reportId,
      calibrationVersion: report.calibrationVersion,
      confidenceSource: "post_hoc_isotonic",
    });
    expect(resolved.binding.thresholds).toEqual(report.thresholds);
    expect(resolved.binding.promotionMode).toBe("blocking");
    expect(resolved.binding.calibrate(0.65)).toBeCloseTo(0.55, 10);
  });
});
