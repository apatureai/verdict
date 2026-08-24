import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  detectComponentLibraries,
  extractBrandBlock,
  parseTokensJson,
  type ContextBlockInput,
} from "@apatureai/verdict-context";

/**
 * Assemble the design context a review is grounded against, from files that live
 * in the repository being reviewed:
 *
 *   tokens.json        → the design tokens the critique is judged against (#63)
 *   .designreview.yml  → the brand block; its presence enables the brand
 *                        dimension in the rubric, and its absence suppresses it
 *   package.json       → detected component libraries → rubric addenda (#60)
 *
 * Every file is optional. A missing file degrades the context, never the run:
 * an ungrounded review is a weaker review, not a failed one.
 */

export interface LoadedRepoContext {
  context: ContextBlockInput;
  /** Which of the three inputs were found, for the run banner. */
  sources: { tokens: boolean; brand: boolean; packageJson: boolean };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function loadRepoContext(directory: string, routes: string[]): Promise<LoadedRepoContext> {
  const [tokensRaw, designReviewRaw, packageRaw] = await Promise.all([
    readOptional(join(directory, "tokens.json")),
    readOptional(join(directory, ".designreview.yml")),
    readOptional(join(directory, "package.json")),
  ]);

  let tokens = {};
  if (tokensRaw !== null) {
    try {
      tokens = parseTokensJson(JSON.parse(tokensRaw));
    } catch {
      tokens = {};
    }
  }

  const brand = designReviewRaw !== null ? extractBrandBlock(designReviewRaw) : null;

  let componentLibraries: ReturnType<typeof detectComponentLibraries> = [];
  if (packageRaw !== null) {
    try {
      componentLibraries = detectComponentLibraries(JSON.parse(packageRaw));
    } catch {
      componentLibraries = [];
    }
  }

  return {
    context: { tokens, brand, componentLibraries, uiDnaVersion: null, routes },
    sources: {
      tokens: tokensRaw !== null && Object.keys(tokens).length > 0,
      brand: brand !== null,
      packageJson: packageRaw !== null,
    },
  };
}
