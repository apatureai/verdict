import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contractPairs, CONTRACT_VECTORS, renderCalibrationContract } from "../src/index.js";

const GOLDEN = fileURLToPath(new URL("../fixtures/calibration-contract.golden.json", import.meta.url));

describe("cross-repo calibration contract (sigil#2)", () => {
  it("the committed contract matches this package's math exactly", () => {
    // Regenerate with: pnpm --filter @apatureai/verdict-eval gen:calibration-contract
    expect(renderCalibrationContract()).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("the generator is deterministic and hits every 10-bin edge", () => {
    for (const spec of CONTRACT_VECTORS) {
      const a = contractPairs(spec);
      const b = contractPairs(spec);
      expect(a).toEqual(b);
    }
    // The quantized generator produces exact bin-boundary confidences, the
    // FP-sensitive inputs where a binning-convention drift shows up first.
    const all = CONTRACT_VECTORS.flatMap((s) => contractPairs(s)).map((p) => p.confidence);
    for (const edge of [0.1, 0.3, 0.7, 1]) {
      expect(all).toContain(edge);
    }
  });
});
