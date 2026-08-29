import { deflateSync, inflateSync } from "node:zlib";
import { fitToPixelBudget, type ScaledDimensions } from "./downscale.js";

/**
 * Dependency-free PNG resampling — the "worker seam" `downscale.ts` refers to
 * (TRD §4.2/§9/§16), implemented for real (W1-05 / G5) so the shipped path stops
 * uploading a full-size PNG on every call.
 *
 * Before this, `fitToPixelBudget`/`fitForDepth` were dead geometry: the CLI and the
 * local server base64-encoded the captured PNG at full resolution for BOTH the deep
 * pass AND the triage pass, so a triage call that emits ~42 output tokens still paid
 * ~4,115 image tokens for a 3.2-megapixel tile. This module decodes the captured
 * PNG, box-downscales it to the per-call pixel budget, and re-encodes it, so the
 * bytes on the wire honour the budget — and the exact captured/sent ratio is
 * returned so any coordinate the model reports in sent space maps back 1:1
 * (`rescalePoint`).
 *
 * It uses only Node's built-in `zlib` — no image library, no native addon. Scope is
 * exactly what Chromium/Playwright emits: 8-bit, non-interlaced, colour type 2
 * (RGB) or 6 (RGBA), one or many IDAT chunks, all five scanline filters. Anything
 * else throws loudly rather than silently mangling pixels.
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** A decoded, unfiltered raster: packed 8-bit samples, `channels` per pixel, row-major. */
export interface DecodedPng {
  width: number;
  height: number;
  /** 3 = RGB (colour type 2), 4 = RGBA (colour type 6). */
  channels: 3 | 4;
  /** `width * height * channels` bytes, row-major, no filter bytes. */
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a Chromium-class PNG (8-bit, non-interlaced, colour type 2/6) to a raw raster. */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG (bad signature)");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 4;
  let sawIhdr = false;
  const idatParts: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new Error(`truncated PNG chunk ${type}`);
    const data = buf.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8)`);
      if (interlace !== 0) throw new Error("unsupported interlaced PNG");
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`unsupported PNG colour type ${colorType} (only 2/6)`);
      sawIhdr = true;
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4; // skip CRC
  }

  if (!sawIhdr) throw new Error("PNG missing IHDR");
  if (idatParts.length === 0) throw new Error("PNG missing IDAT");

  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error("PNG IDAT shorter than IHDR implies");

  const out = new Uint8Array(stride * height);
  let prevRow: Uint8Array | null = null;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const rowStart = y * (stride + 1) + 1;
    const row = out.subarray(y * stride, y * stride + stride);
    for (let i = 0; i < stride; i++) {
      const rawByte = raw[rowStart + i] as number;
      const a = i >= channels ? (row[i - channels] as number) : 0; // left
      const b = prevRow ? (prevRow[i] as number) : 0; // up
      const c = prevRow && i >= channels ? (prevRow[i - channels] as number) : 0; // up-left
      let value: number;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      row[i] = value & 0xff;
    }
    prevRow = row;
  }

  return { width, height, channels, data: out };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Encode a raw raster back to a PNG (8-bit, colour type 2/6, filter 0, single IDAT). */
export function encodePng(img: DecodedPng): Buffer {
  const { width, height, channels, data } = img;
  const colorType = channels === 4 ? 6 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const stride = width * channels;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.subarray(y * stride, y * stride + stride)).copy(filtered, y * (stride + 1) + 1);
  }
  const idat = deflateSync(filtered);

  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

/**
 * Area-average (box) downscale of a raw raster to `targetWidth × targetHeight`.
 * Never upscales (the caller passes budget-fitted dims that only ever shrink). Each
 * destination pixel averages the source pixels its box covers, per channel, so text
 * and edges degrade gracefully rather than aliasing as nearest-neighbour would.
 */
export function boxDownscale(img: DecodedPng, targetWidth: number, targetHeight: number): DecodedPng {
  const { width: sw, height: sh, channels, data } = img;
  if (targetWidth >= sw && targetHeight >= sh) return img;
  const tw = Math.max(1, Math.min(targetWidth, sw));
  const th = Math.max(1, Math.min(targetHeight, sh));
  const out = new Uint8Array(tw * th * channels);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor((ty * sh) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * sh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor((tx * sw) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * sw) / tw));
      const dstBase = (ty * tw + tx) * channels;
      for (let ch = 0; ch < channels; ch++) {
        let sum = 0;
        let count = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let rowBase = (sy * sw + sx0) * channels + ch;
          for (let sx = sx0; sx < sx1; sx++) {
            sum += data[rowBase] as number;
            rowBase += channels;
            count++;
          }
        }
        out[dstBase + ch] = Math.round(sum / count) & 0xff;
      }
    }
  }
  return { width: tw, height: th, channels, data: out };
}

/** A PNG fitted to a pixel budget, plus the captured/sent ratio for coordinate rescale. */
export interface FittedPng {
  /** The PNG bytes to upload — downscaled when the source exceeded the budget, else the input. */
  png: Buffer;
  /** Sent dimensions and the captured/sent ratio (`rescalePoint`/`rescaleRect` inputs). */
  dims: ScaledDimensions;
  /** Whether the image was actually resampled (source exceeded the budget). */
  resampled: boolean;
}

/**
 * Fit a captured PNG to `maxPixels`: decode, compute the budget-fitted dimensions
 * (`fitToPixelBudget`), box-downscale + re-encode when the source is over budget,
 * and return the bytes plus the captured/sent ratio. Within budget, the input bytes
 * are returned unchanged with a 1:1 ratio, so the fast path costs one decode of the
 * header region only conceptually — here it decodes to learn the true dimensions,
 * which is cheap relative to a model call and keeps the budget assertion exact.
 */
export function fitPngToBudget(buf: Buffer, maxPixels: number): FittedPng {
  const decoded = decodePng(buf);
  const dims = fitToPixelBudget(decoded.width, decoded.height, maxPixels);
  if (dims.width >= decoded.width && dims.height >= decoded.height) {
    return { png: buf, dims, resampled: false };
  }
  const scaled = boxDownscale(decoded, dims.width, dims.height);
  return { png: encodePng(scaled), dims, resampled: true };
}
