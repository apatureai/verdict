import type { Embedder } from "@apatureai/verdict-context";

/**
 * The embedder a local run actually has.
 *
 * Genome retrieval (`buildGenomeIndex` + `retrieveGenomeRules`) needs vectors
 * for the genome's rules and for each route's query. The deployed composition
 * gets them from a pinned embedding model over an OpenAI-compatible
 * `/embeddings` endpoint (`EMBEDDING_MODEL` + `MODEL_BASE_URL` + a key). A local
 * run has none of that: `pnpm review` is meant to work with no credentials, no
 * external service and no network access, and that property is the reason the
 * CLI exists in the form it does.
 *
 * So this is what is REACHABLE here, and it is deliberately named for what it
 * is. It is a bag-of-words hashing embedder: lowercase, split on non-alphanumeric
 * characters, hash each token into a fixed 256-dimension vector, and weight by
 * term frequency. Cosine similarity over these vectors ranks by VOCABULARY
 * OVERLAP. It is not a semantic embedding and it does not know that "cta" and
 * "button" are related, which a pinned embedding model does.
 *
 * The three consequences, stated rather than discovered:
 *
 *   1. A local run and a deployed run can retrieve DIFFERENT top-k rules for the
 *      same route and the same genome. Both are grounded; they are not ranked by
 *      the same function, and neither one is the other's fixture.
 *   2. The orchestrator's retrieval query is the route path alone. When that path
 *      shares no token with any rule (the common case: "/pricing" against a rule
 *      about spacing scales), every cosine is 0, the ranking is a flat tie, and
 *      `retrieveGenomeRules` breaks the tie deterministically by rule id. The
 *      top-k is then a stable arbitrary slice of the genome rather than a
 *      relevance ranking. It is still grounding, and it is still deterministic,
 *      and it is not selection.
 *   3. When the genome holds no more rules than the retrieval top-k (6 by
 *      default), ranking cannot change the outcome: every rule reaches the
 *      prompt whatever the vectors say. Small genomes therefore lose nothing at
 *      all to this embedder.
 *
 * Deterministic and pure: the same text always yields the same vector, in this
 * process and in any other, which is what lets a local review be re-run and
 * compared byte for byte.
 */

/** Vector width. Fixed, because the id below pins the whole function. */
export const LEXICAL_EMBEDDER_DIMENSIONS = 256;

/**
 * Identifier of this exact embedding function, reported next to a grounded
 * review so nobody reads a locally-retrieved rule set as a semantically-ranked
 * one. Bump the suffix if the tokenizer, the hash or the width ever changes:
 * vectors from two different versions are not comparable.
 */
export const LEXICAL_EMBEDDER_ID = "lexical-hash-256@1";

/** One line naming this embedder, for a banner or a report. */
export const LEXICAL_EMBEDDER_DESCRIPTION =
  `offline lexical embedder (${LEXICAL_EMBEDDER_ID}): ranks rules by word overlap, not by meaning`;

/**
 * Split text into comparison tokens. Single characters are dropped: they carry
 * no discriminating signal and would let a stray separator dominate a short
 * query. A route of "/" therefore tokenizes to nothing, which is the flat-tie
 * case described above.
 */
export function lexicalTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/** FNV-1a, folded into the vector width. Stable across processes and platforms. */
function bucketFor(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % LEXICAL_EMBEDDER_DIMENSIONS;
}

/**
 * Term-frequency vector over the hashed vocabulary. Raw counts, because
 * `cosineSimilarity` normalizes: a long rule and a short one are compared by
 * direction, not by length.
 */
export function lexicalVector(text: string): number[] {
  const vector = new Array<number>(LEXICAL_EMBEDDER_DIMENSIONS).fill(0);
  for (const token of lexicalTokens(text)) {
    const bucket = bucketFor(token);
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  return vector;
}

/**
 * The `Embedder` the local pipeline injects. Async to satisfy the seam; it
 * performs no I/O, so it cannot fail, cannot hang and cannot cost anything.
 */
export const lexicalEmbedder: Embedder = async (texts) => texts.map((text) => lexicalVector(text));
