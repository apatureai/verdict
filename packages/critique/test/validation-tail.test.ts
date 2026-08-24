import type { CalibrationRuntimeBinding, Finding } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { runValidationTail } from "../src/validation-tail.js";
import type { CalibrationRuntimeIdentity } from "../src/calibration-binding.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence: 0.8,
  route: "/",
  viewport: "desktop",
  elementRef: null,
  title: "x",
  description: "x",
  suggestion: null,
  introducedByThisPr: true,
  ...over,
});

const identity: CalibrationRuntimeIdentity = {
  model: "qwen3-vl-plus",
  promptVersion: "system-prompt@v4",
  engineVersion: "0.1.0",
  captureVersion: "capture@1",
  rubricVersion: "design-rubric@1",
};

const calibration: CalibrationRuntimeBinding = {
  reference: {
    reportId: "report-1",
    reportHash: `sha256:${"a".repeat(64)}`,
    calibrationVersion: "isotonic@1",
    confidenceSource: "post_hoc_isotonic",
  },
  identity,
  promotionMode: "blocking",
  thresholds: { postFilterMinConfidence: 0.55, blockingMinConfidence: 0.9, unstableCaptureMaxConfidence: 0.6 },
  calibrate: (raw) => raw,
};

describe("runValidationTail — the shared gate/calibrate/filter/reconcile sequence", () => {
  it("drops findings on uncaptured routes and reconciles the grade to survivors (no calibration)", () => {
    const out = runValidationTail({
      findings: [finding({ route: "/" }), finding({ route: "/ghost", severity: "blocker" })],
      modelGrade: "blocked", // model over-graded on a finding that will be dropped
      capturedRoutes: ["/"],
      captureUnstable: false,
      identity,
    });
    expect(out.hallucinationDrops).toBe(1); // the /ghost blocker is dropped
    expect(out.findings).toHaveLength(1);
    expect(out.grade).toBe("needs_work"); // floored: the surviving minor supports needs_work, not blocked
    expect(out.blockingEnabled).toBe(false);
    expect(out.calibration).toBeUndefined();
  });

  it("applies calibration only when the binding matches the runtime identity", () => {
    const matched = runValidationTail({
      findings: [finding()],
      modelGrade: "ship_with_nits",
      capturedRoutes: ["/"],
      captureUnstable: false,
      calibration,
      identity,
    });
    expect(matched.calibration).toBe(calibration);
    expect(matched.blockingEnabled).toBe(true);

    const mismatched = runValidationTail({
      findings: [finding()],
      modelGrade: "ship_with_nits",
      capturedRoutes: ["/"],
      captureUnstable: false,
      calibration,
      identity: { ...identity, model: "retired-model" },
    });
    expect(mismatched.calibration).toBeUndefined(); // stays advisory on a mismatch
    expect(mismatched.blockingEnabled).toBe(false);
  });

  it("under blocking calibration, a sub-threshold blocker cannot block (downgraded)", () => {
    const out = runValidationTail({
      // 0.7 clears the postFilter floor (0.55) but is below blockingMinConfidence (0.9)
      findings: [finding({ severity: "blocker", confidence: 0.7, elementRef: "#a" })],
      modelGrade: "blocked",
      capturedRoutes: ["/"],
      captureUnstable: false,
      calibration,
      identity,
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("major"); // blocker downgraded, cannot block
    expect(out.grade).toBe("needs_work");
  });
});
