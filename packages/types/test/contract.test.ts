import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasDisplayableConfidence,
  loadGoldenResult,
  loadPreCalibrationResult,
  nothingReviewed,
  SCHEMA_VERSION,
} from "../src/index.js";
import type { EngineReviewResult } from "../src/index.js";

describe("wire contract (cross-repo anchor with Gate)", () => {
  const golden: EngineReviewResult = loadGoldenResult();

  it("the engine wire result IS Gate's GateReviewResult shape", () => {
    expect(["ship", "ship_with_nits", "needs_work", "blocked"]).toContain(golden.grade);
    expect(Array.isArray(golden.findings)).toBe(true);
    expect(Array.isArray(golden.notReviewed)).toBe(true);
    expect(Array.isArray(golden.artifacts.annotatedScreenshots)).toBe(true);
    expect(typeof golden.screenshotRetentionSeconds).toBe("number");
  });

  it("carries the engine-owned result-level confidence: the min over finding confidences (#150)", () => {
    expect(hasDisplayableConfidence(golden)).toBe(true);
    expect(golden.calibration?.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(golden.blockingEnabled).toBe(true);
    expect(typeof golden.confidence).toBe("number");
    const least = Math.min(...golden.findings.map((f) => f.confidence ?? 1));
    expect(golden.confidence).toBe(least);
  });

  it("keeps historical numeric confidence parseable but explicitly unavailable (#160)", () => {
    const historical = loadPreCalibrationResult();
    expect(typeof historical.confidence).toBe("number");
    expect(historical.findings.every((finding) => typeof finding.confidence === "number")).toBe(true);
    expect(historical.calibration).toBeUndefined();
    expect(hasDisplayableConfidence(historical)).toBe(false);
  });

  it("rejects malformed provenance and partially calibrated results (#160)", () => {
    expect(hasDisplayableConfidence({
      ...golden,
      calibration: { ...golden.calibration!, reportHash: "sha256:not-a-digest" },
    })).toBe(false);
    expect(hasDisplayableConfidence({
      ...golden,
      findings: golden.findings.map((finding, index) =>
        index === 0 ? { ...finding, confidence: undefined } : finding),
    })).toBe(false);
  });

  it("guards every WireFinding field name + type (so the wire type can't drift from the fixture)", () => {
    const f = golden.findings[0];
    if (!f) throw new Error("golden fixture must carry at least one finding to anchor the contract");
    // A rename/removal/type-change in WireFinding (wire.ts) or the fixture breaks this.
    expect(typeof f.id).toBe("string");
    expect(["nit", "minor", "major", "blocker"]).toContain(f.severity);
    expect(typeof f.title).toBe("string");
    expect(typeof f.description).toBe("string");
    expect(typeof f.route).toBe("string");
    expect(["mobile", "tablet", "desktop"]).toContain(f.viewport);
    expect(f.element === null || typeof f.element === "string").toBe(true);
    expect(f.screenshotId === null || typeof f.screenshotId === "string").toBe(true);
    expect(f.suggestion === null || typeof f.suggestion === "string").toBe(true);
    // Engine-produced confidence (#150): additive on schema v1, always emitted.
    expect(typeof f.confidence).toBe("number");
    expect(f.confidence).toBeGreaterThanOrEqual(0);
    expect(f.confidence).toBeLessThanOrEqual(1);
    // Rubric dimension (#159): the closed eight-value enum, additive on schema v1.
    expect([
      "visual_hierarchy", "spacing", "color_contrast", "typography",
      "consistency", "responsiveness", "accessibility", "brand",
    ]).toContain(f.dimension);
    // No extra/renamed keys vs the WireFinding contract.
    expect(Object.keys(f).sort()).toEqual(
      ["confidence", "description", "dimension", "element", "id", "route", "screenshotId", "severity", "suggestion", "title", "viewport"],
    );
    // annotatedScreenshots entries keep their {findingId, url} shape.
    const a = golden.artifacts.annotatedScreenshots[0];
    if (a) expect(Object.keys(a).sort()).toEqual(["findingId", "url"]);
  });

  it("#165: is the cross-repo PARTIAL-coverage anchor (skipped route + skipped viewport, real findings)", () => {
    const coverage = golden.coverage;
    if (!coverage) throw new Error("the golden fixture must state coverage");
    expect(coverage.routesRequested).toEqual(["/pricing", "/checkout"]);
    expect(coverage.routesReviewed).toEqual(["/pricing"]);
    expect(coverage.viewportsRequested).toEqual(["mobile", "tablet", "desktop"]);
    expect(coverage.viewportsReviewed).toEqual(["mobile", "desktop"]);
    // Reviewed is a subset of requested: no producer may report reviewing
    // something nobody asked for.
    for (const route of coverage.routesReviewed) expect(coverage.routesRequested).toContain(route);
    for (const vp of coverage.viewportsReviewed) expect(coverage.viewportsRequested).toContain(vp);
    // Partial, but NOT empty: something was reviewed, so the grade is a verdict.
    expect(nothingReviewed(coverage)).toBe(false);
    // ...and every skipped item is named in prose too, so a consumer reading only
    // `notReviewed` still sees it.
    expect(golden.notReviewed.some((line) => line.includes("/checkout"))).toBe(true);
    expect(golden.notReviewed.some((line) => line.includes("tablet"))).toBe(true);
  });

  it("#165: reads an EMPTY reviewed-route set as 'nothing was reviewed', whatever the grade says", () => {
    // The exact state the field exists for: a `ship` grade with zero findings,
    // byte-identical to a clean page apart from this one field.
    expect(
      nothingReviewed({
        routesRequested: ["/pricing"],
        routesReviewed: [],
        viewportsRequested: ["mobile"],
        viewportsReviewed: [],
      }),
    ).toBe(true);
  });

  it("carries the version stamp (engine/model/prompt/capture/ui-dna)", () => {
    const m = golden.metadata;
    expect(typeof m.engineVersion).toBe("string");
    expect(typeof m.model).toBe("string");
    expect(typeof m.promptVersion).toBe("string");
    expect(typeof m.captureVersion).toBe("string");
    expect(typeof m.rubricVersion).toBe("string");
    expect(m.uiDnaVersion === null || typeof m.uiDnaVersion === "string").toBe(true);
  });

  it("is engine-neutral (no Claude/Anthropic hard-coding) and schema v1", () => {
    expect(SCHEMA_VERSION).toBe("1");
    const s = JSON.stringify(golden).toLowerCase();
    expect(s).not.toContain("claude");
    expect(s).not.toContain("anthropic");
  });
});

/**
 * W1-03 grounding invariant. A published finding is a claim about a `(route,
 * viewport)` shot; coverage is the run's own statement of which routes and
 * viewports it reviewed. The two must never contradict each other — a finding
 * claiming a viewport coverage says was not reviewed (the mobile-only run that
 * still emitted "desktop" findings) is exactly the hole the grounding gate now
 * closes. This pins the invariant across EVERY JSON fixture in the repo that
 * carries both findings and coverage, so no fixture — golden, example, or one
 * added later — can encode a finding outside its own coverage.
 */
describe("W1-03: every finding sits inside its result's own coverage", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

  const jsonFilesUnder = (dir: string): string[] => {
    const out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...jsonFilesUnder(full));
      else if (entry.endsWith(".json")) out.push(full);
    }
    return out;
  };

  type CoveredResult = {
    findings: Array<{ route?: unknown; viewport?: unknown }>;
    coverage: { routesReviewed: string[]; viewportsReviewed: string[] };
  };

  const hasCoverageAndFindings = (value: unknown): value is CoveredResult => {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    const coverage = v.coverage as Record<string, unknown> | undefined;
    return (
      Array.isArray(v.findings) &&
      typeof coverage === "object" &&
      coverage !== null &&
      Array.isArray(coverage.routesReviewed) &&
      Array.isArray(coverage.viewportsReviewed)
    );
  };

  const fixtures = jsonFilesUnder(join(repoRoot, "packages"))
    .flatMap((path) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return [];
      }
      return hasCoverageAndFindings(parsed) ? [{ path, result: parsed }] : [];
    });

  it("finds at least one wire-result fixture carrying coverage (so the invariant is actually exercised)", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures.map((f) => [f.path.slice(repoRoot.length + 1), f.result] as const))(
    "%s: ∀f  f.route ∈ routesReviewed ∧ f.viewport ∈ viewportsReviewed",
    (_name, result) => {
      const routes = new Set(result.coverage.routesReviewed);
      const viewports = new Set(result.coverage.viewportsReviewed);
      for (const finding of result.findings) {
        expect(routes.has(finding.route as string)).toBe(true);
        expect(viewports.has(finding.viewport as string)).toBe(true);
      }
    },
  );
});
