import type { CalibrationRuntimeBinding, Finding } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import { runValidationTail } from "../src/validation-tail.js";
import type { CapturedShot } from "../src/hallucination-gate.js";
import type { CalibrationRuntimeIdentity } from "../src/calibration-binding.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  dimension: "spacing",
  severity: "minor",
  confidence: 0.8,
  route: "/",
  viewport: "desktop",
  // Non-null by default: grounded findings drive the grade. Tests that want the
  // ungrounded (null-elementRef) path set it explicitly.
  elementRef: "#el",
  title: "x",
  description: "x",
  suggestion: null,
  introducedByThisPr: true,
  ...over,
});

const shot = (route: string, viewport: Finding["viewport"] = "desktop"): CapturedShot => ({ route, viewport });

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
      capturedShots: [shot("/")],
      captureUnstable: false,
      identity,
    });
    expect(out.hallucinationDrops).toBe(1); // the /ghost blocker is dropped
    expect(out.findings).toHaveLength(1);
    expect(out.ungroundedFindings).toBe(0);
    expect(out.grade).toBe("needs_work"); // floored: the surviving minor supports needs_work, not blocked
    expect(out.blockingEnabled).toBe(false);
    expect(out.calibration).toBeUndefined();
  });

  it("holds an ungrounded (null-elementRef) blocker out of the grade and ranks it last", () => {
    const out = runValidationTail({
      findings: [
        finding({ severity: "nit", elementRef: "#real" }),
        finding({ severity: "blocker", elementRef: null }),
      ],
      modelGrade: "blocked",
      capturedShots: [shot("/")],
      captureUnstable: false,
      identity,
    });
    // Both are published, but the ungrounded blocker cannot block: grade is floored
    // to the single grounded nit.
    expect(out.findings).toHaveLength(2);
    expect(out.ungroundedFindings).toBe(1);
    expect(out.grade).toBe("ship_with_nits");
    // Ranking: the grounded nit sits ahead of the ungrounded blocker.
    expect(out.findings[0]?.elementRef).toBe("#real");
    expect(out.findings[1]?.elementRef).toBeNull();
    expect(out.findings[1]?.severity).toBe("blocker");
    // An ungrounded observation is not a hallucination.
    expect(out.hallucinationDrops).toBe(0);
  });

  it("grades ship when every surviving finding is ungrounded", () => {
    const out = runValidationTail({
      findings: [finding({ severity: "major", elementRef: null })],
      modelGrade: "needs_work",
      capturedShots: [shot("/")],
      captureUnstable: false,
      identity,
    });
    expect(out.findings).toHaveLength(1);
    expect(out.ungroundedFindings).toBe(1);
    expect(out.grade).toBe("ship");
  });

  it("applies calibration only when the binding matches the runtime identity", () => {
    const matched = runValidationTail({
      findings: [finding()],
      modelGrade: "ship_with_nits",
      capturedShots: [shot("/")],
      captureUnstable: false,
      calibration,
      identity,
    });
    expect(matched.calibration).toBe(calibration);
    expect(matched.blockingEnabled).toBe(true);

    const mismatched = runValidationTail({
      findings: [finding()],
      modelGrade: "ship_with_nits",
      capturedShots: [shot("/")],
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
      capturedShots: [shot("/")],
      captureUnstable: false,
      calibration,
      identity,
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("major"); // blocker downgraded, cannot block
    expect(out.grade).toBe("needs_work");
  });
});
