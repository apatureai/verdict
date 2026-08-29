import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  boxDownscale,
  decodePng,
  encodePng,
  fitPngToBudget,
  rescalePoint,
  type DecodedPng,
} from "../src/index.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Local CRC32 so the test can hand-craft a PNG with arbitrary scanline filters,
// exercising the decoder's unfilter paths without committing a binary fixture.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}
/** Build an 8-bit RGB PNG from pre-filtered scanlines (each: [filterByte, ...rowBytes]). */
function buildRgbPng(width: number, height: number, filteredRows: number[][]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const idat = deflateSync(Buffer.from(filteredRows.flat()));
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** A synthetic gradient raster, deterministic and non-uniform so downscale is meaningful. */
function gradient(width: number, height: number, channels: 3 | 4): DecodedPng {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * channels;
      data[base] = (x * 255) / Math.max(1, width - 1);
      data[base + 1] = (y * 255) / Math.max(1, height - 1);
      data[base + 2] = (x + y) % 256;
      if (channels === 4) data[base + 3] = 255;
    }
  }
  return { width, height, channels, data };
}

describe("PNG resample (G5)", () => {
  it("round-trips encode → decode losslessly (RGB and RGBA)", () => {
    for (const channels of [3, 4] as const) {
      const src = gradient(37, 21, channels);
      const decoded = decodePng(encodePng(src));
      expect(decoded.width).toBe(37);
      expect(decoded.height).toBe(21);
      expect(decoded.channels).toBe(channels);
      expect(Buffer.from(decoded.data).equals(Buffer.from(src.data))).toBe(true);
    }
  });

  it("reconstructs every scanline filter type (None/Sub/Up/Average/Paeth)", () => {
    // A 2x2 RGB image whose true pixels are known; each row is filtered with a
    // different filter type so decode must invert all of them.
    // Target raster (row-major RGB):
    //   (10,20,30)(40,50,60)
    //   (70,80,90)(100,110,120)
    // Row 0 filter Sub(1): first pixel raw, second = delta from left.
    // Row 1 filter Up(2): each byte = delta from the pixel directly above.
    const row0 = [1, 10, 20, 30, 40 - 10, 50 - 20, 60 - 30];
    const row1 = [2, 70 - 10, 80 - 20, 90 - 30, 100 - 40, 110 - 50, 120 - 60];
    const png = buildRgbPng(2, 2, [row0, row1]);
    const d = decodePng(png);
    expect(Array.from(d.data)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);

    // Average(3) and Paeth(4) on a fresh image, one row each.
    // True pixels: (8,8,8)(16,16,16) then (24,24,24)(40,40,40).
    // Row 0 None(0). Row 1 Average(3): raw = value - floor((left+up)/2).
    const r0 = [0, 8, 8, 8, 16, 16, 16];
    const avg = (left: number, up: number): number => Math.floor((left + up) / 2);
    const r1avg = [
      3,
      24 - avg(0, 8), 24 - avg(0, 8), 24 - avg(0, 8),
      40 - avg(24, 16), 40 - avg(24, 16), 40 - avg(24, 16),
    ];
    const dAvg = decodePng(buildRgbPng(2, 2, [r0, r1avg]));
    expect(Array.from(dAvg.data)).toEqual([8, 8, 8, 16, 16, 16, 24, 24, 24, 40, 40, 40]);

    // Paeth(4): predictor of (left, up, up-left). With up-left 0 and left 0 on the
    // first pixel, paeth(0,up,0) = up, so raw = value - up.
    const r1paeth = [
      4,
      24 - 8, 24 - 8, 24 - 8, // first pixel: paeth(0,8,0)=8
      40 - 16, 40 - 16, 40 - 16, // second pixel: paeth(24,16,8) — see note below
    ];
    // Second pixel paeth(a=24, b=16, c=8): p=32; |32-24|=8, |32-16|=16, |32-8|=24 -> a=24.
    r1paeth[4] = 40 - 24;
    r1paeth[5] = 40 - 24;
    r1paeth[6] = 40 - 24;
    const dP = decodePng(buildRgbPng(2, 2, [r0, r1paeth]));
    expect(Array.from(dP.data)).toEqual([8, 8, 8, 16, 16, 16, 24, 24, 24, 40, 40, 40]);
  });

  it("box-downscales by area-average (2x2 block → its mean)", () => {
    // 2x2 grayscale-ish RGB where the four pixels average to a known value.
    const src: DecodedPng = {
      width: 2,
      height: 2,
      channels: 3,
      data: new Uint8Array([0, 0, 0, 100, 100, 100, 200, 200, 200, 40, 40, 40]),
    };
    const out = boxDownscale(src, 1, 1);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    // mean of {0,100,200,40} = 85.
    expect(Array.from(out.data)).toEqual([85, 85, 85]);
  });

  it("never upscales: a below-budget, already patch-aligned image is returned untouched (1:1)", () => {
    // 64x32 is under the budget AND both dims are multiples of the 32px patch
    // alignment, so the fitted dims equal the source and no re-encode happens.
    const png = encodePng(gradient(64, 32, 3));
    const fitted = fitPngToBudget(png, 1024 * 1024);
    expect(fitted.resampled).toBe(false);
    expect(fitted.png).toBe(png); // same bytes, no re-encode
    expect(fitted.dims.ratioX).toBe(1);
    expect(fitted.dims.ratioY).toBe(1);
  });

  it("fits an over-budget image UNDER the pixel budget and reports the rescale ratio", () => {
    const png = encodePng(gradient(400, 300, 3)); // 120,000px
    const budget = 40 * 40 * 25; // 40,000px budget
    const fitted = fitPngToBudget(png, budget);
    expect(fitted.resampled).toBe(true);
    const sent = decodePng(fitted.png);
    expect(sent.width * sent.height).toBeLessThanOrEqual(budget);
    // The ratio maps sent-space coordinates back to captured space.
    expect(fitted.dims.ratioX).toBeCloseTo(400 / sent.width, 5);
    expect(fitted.dims.ratioY).toBeCloseTo(300 / sent.height, 5);
  });

  it("rescalePoint maps a model coordinate in SENT space back to full captured resolution", () => {
    const png = encodePng(gradient(1000, 800, 3));
    const fitted = fitPngToBudget(png, 200 * 160); // shrink hard
    const sent = decodePng(fitted.png);
    // A point at the far corner of the SENT image maps back near the captured corner.
    const captured = rescalePoint({ x: sent.width, y: sent.height }, fitted.dims);
    expect(captured.x).toBeCloseTo(1000, 5);
    expect(captured.y).toBeCloseTo(800, 5);
  });
});
