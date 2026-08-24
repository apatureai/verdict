import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { ScreenshotSink } from "@apatureai/verdict-capture";

/**
 * `ScreenshotSink` that writes PNGs to a directory, so a local run produces
 * files someone can actually open. The production path writes the identical
 * bytes to object storage through `@apatureai/verdict-storage`; the object KEY is the same
 * string in both cases, which is what keeps the review result portable.
 */
export class FileScreenshotSink implements ScreenshotSink {
  /** Keys written, in order. */
  readonly keys: string[] = [];

  constructor(private readonly root: string) {}

  /** Absolute path a key maps to. Throws if the key escapes the root. */
  pathFor(key: string): string {
    const target = resolve(this.root, normalize(key).replace(/^([/\\])+/, ""));
    const rootResolved = resolve(this.root);
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      throw new Error(`object key escapes the output directory: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    this.keys.push(key);
  }

  /** `file://` URL for a key: what the wire result's artifact URLs point at locally. */
  urlFor(key: string): string {
    return `file://${this.pathFor(key)}`;
  }

  /**
   * `data:` URI for a key. A live model fetches image URLs itself, and it cannot
   * reach a path on this machine, so a local run inlines the bytes. Production
   * uses a short-TTL signed object-store URL instead (`ObjectStore.signedGetUrl`).
   */
  async dataUriFor(key: string): Promise<string> {
    const bytes = await readFile(this.pathFor(key));
    return `data:image/png;base64,${bytes.toString("base64")}`;
  }

  /** Path of the directory this sink writes into. */
  get directory(): string {
    return resolve(this.root);
  }
}

/** Join a key onto a directory for display purposes. */
export function displayPath(root: string, key: string): string {
  return join(root, key);
}
