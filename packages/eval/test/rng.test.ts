/**
 * The eval package's seeded PRNG, extracted from the byte-identical copies in
 * calibration.ts and metrics.ts. Pinning the property those callers depend on:
 * a seed always yields the same stream (reproducible eval sampling), and
 * different seeds diverge.
 */
import { describe, expect, it } from "vitest";
import { mulberry32 } from "@apatureai/verdict-eval";

describe("mulberry32", () => {
  it("is deterministic: the same seed yields the same stream", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("returns floats in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("different seeds produce different streams", () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    expect(a).not.toBe(b);
  });
});
