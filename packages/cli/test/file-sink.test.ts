import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PIXEL_BUDGETS, decodePng, encodePng, type DecodedPng } from "@apatureai/verdict-capture";
import { FileScreenshotSink } from "../src/index.js";

/** A synthetic over-budget RGB PNG (2400x1600 = 3,840,000px, over deep and triage). */
function bigPng(): Buffer {
  const width = 2400;
  const height = 1600;
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 251;
  const img: DecodedPng = { width, height, channels: 3, data };
  return encodePng(img);
}

/** Decode the base64 payload of a `data:image/png;base64,...` URI to pixel count. */
function pixelsInDataUri(uri: string): number {
  const b64 = uri.replace(/^data:image\/png;base64,/, "");
  const d = decodePng(Buffer.from(b64, "base64"));
  return d.width * d.height;
}

describe("FileScreenshotSink", () => {
  it("writes an object key to the matching path and records it", async () => {
    const root = await mkdtemp(join(tmpdir(), "je-sink-"));
    const sink = new FileScreenshotSink(root);
    await sink.put("screenshots/index/mobile.png", new Uint8Array([1, 2, 3]));

    expect(sink.keys).toEqual(["screenshots/index/mobile.png"]);
    const written = await readFile(join(root, "screenshots/index/mobile.png"));
    expect([...written]).toEqual([1, 2, 3]);
    expect(sink.urlFor("screenshots/index/mobile.png")).toBe(
      `file://${join(root, "screenshots/index/mobile.png")}`,
    );
  });

  it("inlines the bytes as a data URI for a live model that must fetch them", async () => {
    const root = await mkdtemp(join(tmpdir(), "je-sink-"));
    const sink = new FileScreenshotSink(root);
    await sink.put("screenshots/index/mobile.png", new Uint8Array([137, 80, 78, 71]));
    expect(await sink.dataUriFor("screenshots/index/mobile.png")).toBe("data:image/png;base64,iVBORw==");
  });

  it("downscales the inlined tile UNDER the per-call pixel budget on every shipped path (G5)", async () => {
    const root = await mkdtemp(join(tmpdir(), "je-sink-"));
    const sink = new FileScreenshotSink(root);
    const key = "screenshots/index/mobile.png";
    const original = bigPng();
    await sink.put(key, original);

    // Every shipped budget the resolver is called with must yield a tile at or under it.
    for (const budget of [PIXEL_BUDGETS.triage, PIXEL_BUDGETS.deep]) {
      const uri = await sink.dataUriFor(key, budget);
      expect(pixelsInDataUri(uri)).toBeLessThanOrEqual(budget);
    }
    // Triage's tile is strictly smaller than deep's — the two tiers actually differ.
    const triagePx = pixelsInDataUri(await sink.dataUriFor(key, PIXEL_BUDGETS.triage));
    const deepPx = pixelsInDataUri(await sink.dataUriFor(key, PIXEL_BUDGETS.deep));
    expect(triagePx).toBeLessThan(deepPx);

    // The captured file on disk is untouched (full resolution) so the annotated
    // screenshot still renders at capture resolution; only the sent bytes shrink.
    const onDisk = decodePng(await readFile(join(root, key)));
    expect(onDisk.width * onDisk.height).toBe(2400 * 1600);

    // Without a budget the resolver inlines the full-resolution PNG (the pre-fix
    // behaviour), which is over budget — this is what the wiring stops sending.
    const unbudgeted = await sink.dataUriFor(key);
    expect(pixelsInDataUri(unbudgeted)).toBeGreaterThan(PIXEL_BUDGETS.deep);
  });

  it("refuses a key that escapes the output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "je-sink-"));
    const sink = new FileScreenshotSink(root);
    await expect(sink.put("../escape.png", new Uint8Array([0]))).rejects.toThrow(/escapes the output directory/);
  });
});
