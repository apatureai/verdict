import type { CalibrationRuntimeBinding, Finding } from "@apatureai/verdict-types";
import type { RepoContext } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { applyConfidenceCeiling, critique } from "../src/index.js";

const finding = (confidence: number): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence,
  route: "/",
  viewport: "desktop",
  elementRef: null,
  title: "x",
  description: "x",
  suggestion: null,
  introducedByThisPr: true,
});

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: null,
  contentHash: "abc",
};

const calibration: CalibrationRuntimeBinding = {
  reference: {
    reportId: "report-1",
    reportHash: `sha256:${"a".repeat(64)}`,
    calibrationVersion: "isotonic@1",
    confidenceSource: "post_hoc_isotonic",
  },
  identity: {
    model: "qwen3-vl-plus",
    promptVersion: "system-prompt@v4",
    engineVersion: "0.1.0",
    captureVersion: "capture@1",
    rubricVersion: "design-rubric@1",
  },
  promotionMode: "advisory",
  thresholds: {
    postFilterMinConfidence: 0.55,
    blockingMinConfidence: 0.9,
    unstableCaptureMaxConfidence: 0.6,
  },
  calibrate: (raw) => raw,
};

describe("applyConfidenceCeiling (#70)", () => {
  it("caps confidences above the ceiling, leaves lower ones untouched", () => {
    const out = applyConfidenceCeiling([finding(0.95), finding(0.5)], 0.6);
    expect(out.map((f) => f.confidence)).toEqual([0.6, 0.5]);
  });
});

describe("critique propagates the capture-unstable ceiling", () => {
  it("marks captureUnstable when a confidence ceiling is supplied", async () => {
    const stable = await critique([], context, { depth: "deep" });
    expect(stable.validation.captureUnstable).toBe(false);

    const unstable = await critique(
      [],
      context,
      { depth: "deep", captureUnstable: true },
      { captureVersion: "capture@1", calibration },
    );
    expect(unstable.validation.captureUnstable).toBe(true);
  });
});
