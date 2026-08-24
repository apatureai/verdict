import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/dvc-export.js";
import {
  buildContract,
  contractArtifactPath,
  contractToJson,
} from "../scripts/preference-contract.ts";

/**
 * Guards the TS side of the TS<->Python schema contract (#123). If the committed
 * artifact drifts from what the generator derives from the current TS source
 * (a renamed field, a new/removed enum member, a changed nested shape), the
 * regen check below fails loudly. It is the same artifact the Python pytest asserts
 * against, so a drift is caught on both sides at once.
 */
describe("preference-example contract artifact", () => {
  it("is up to date with the TS source of truth (regen check)", () => {
    const committed = readFileSync(contractArtifactPath(), "utf8");
    // `pnpm --filter @apatureai/verdict-feedback contract:gen` regenerates this file.
    expect(contractToJson()).toBe(committed);
  });

  it("pins canonical-JSON samples produced by the real dvc-export serializer", () => {
    // The Python `canonical_json` byte-matches these exact strings; they must be
    // exactly what `canonicalJson` (dvc-export.ts) emits, not a hand-written copy.
    for (const sample of buildContract().canonicalSamples) {
      expect(sample.canonicalJson).toBe(canonicalJson(sample.example));
    }
  });

  it("mirrors the live enum spaces (findings.ts + preference-export.ts)", () => {
    const { enums } = buildContract();
    // Spot-anchor the enums a training set depends on so intent is legible here,
    // not only implied by the generated file.
    expect(enums.Dimension).toEqual([
      "visual_hierarchy",
      "spacing",
      "color_contrast",
      "typography",
      "consistency",
      "responsiveness",
      "accessibility",
      "brand",
    ]);
    expect(enums.Severity).toEqual(["nit", "minor", "major", "blocker"]);
    expect(enums.Viewport).toEqual(["mobile", "tablet", "desktop"]);
    expect(enums.Verdict).toEqual(["endorsed", "dismissed"]);
    expect(enums.Label).toEqual(["desirable", "undesirable"]);
    expect(enums.KtoSource).toEqual(["thumbs", "ignore", "implicit"]);
  });
});
