import { buildGenomeIndex, cosineSimilarity, retrieveGenomeRules } from "@apatureai/verdict-context";
import { describe, expect, it } from "vitest";
import {
  lexicalEmbedder,
  lexicalTokens,
  lexicalVector,
  LEXICAL_EMBEDDER_DIMENSIONS,
} from "../src/index.js";

/**
 * The embedder a local run has, tested for what it actually promises: it is
 * deterministic, it ranks by word overlap, and it is honest about the case where
 * it cannot rank at all. The last one matters most, because the retrieval query
 * the orchestrator builds is the route path alone and most rules share no word
 * with it.
 */
describe("lexicalEmbedder", () => {
  it("is deterministic and fixed-width, so two runs are comparable", async () => {
    const [a] = await lexicalEmbedder(["pricing card radius"]);
    const [b] = await lexicalEmbedder(["pricing card radius"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(LEXICAL_EMBEDDER_DIMENSIONS);
  });

  it("embeds a batch in one call, one vector per input, in order", async () => {
    const vectors = await lexicalEmbedder(["alpha", "beta", "gamma"]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(lexicalVector("alpha"));
    expect(vectors[2]).toEqual(lexicalVector("gamma"));
  });

  it("drops single characters, so a route of / carries no signal", () => {
    expect(lexicalTokens("/pricing/plans")).toEqual(["pricing", "plans"]);
    expect(lexicalTokens("/")).toEqual([]);
    expect(lexicalVector("/").every((value) => value === 0)).toBe(true);
  });

  it("ranks by word overlap, not by meaning", () => {
    const query = lexicalVector("/checkout");
    const overlapping = lexicalVector(JSON.stringify({ kind: "checkout", value: { gap: 8 } }));
    const unrelated = lexicalVector(JSON.stringify({ kind: "typography", value: { leading: 1.4 } }));
    expect(cosineSimilarity(query, overlapping)).toBeGreaterThan(cosineSimilarity(query, unrelated));

    // And the limit, stated: a synonym is not a match here. A pinned semantic
    // embedder would score these two together; this one scores them apart.
    const synonym = lexicalVector(JSON.stringify({ kind: "cart", value: { gap: 8 } }));
    expect(cosineSimilarity(query, synonym)).toBe(0);
  });

  it("degrades to a stable rule-id order when nothing overlaps, rather than to nothing", async () => {
    // The documented degenerate case: every cosine is 0, so `retrieveGenomeRules`
    // breaks the flat tie deterministically by id. Rules still reach the prompt,
    // and the same rules reach it every time; what is lost is the ranking.
    const rules = [
      { id: "c.rule", text: JSON.stringify({ kind: "color", value: {} }) },
      { id: "a.rule", text: JSON.stringify({ kind: "radius", value: {} }) },
      { id: "b.rule", text: JSON.stringify({ kind: "spacing", value: {} }) },
    ];
    const index = await buildGenomeIndex("ui-dna@1", rules, lexicalEmbedder);
    const [query] = await lexicalEmbedder(["/pricing"]);
    const retrieved = retrieveGenomeRules(index, query as number[], { topK: 2 });

    expect(retrieved.map((r) => r.rule.id)).toEqual(["a.rule", "b.rule"]);
    expect(retrieved.every((r) => r.score === 0)).toBe(true);
  });

  it("cannot change the outcome for a genome no larger than the top-k", async () => {
    const rules = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, text: `rule ${i}` }));
    const index = await buildGenomeIndex("ui-dna@1", rules, lexicalEmbedder);
    const [query] = await lexicalEmbedder(["/anything"]);
    expect(retrieveGenomeRules(index, query as number[], { topK: 6 })).toHaveLength(4);
  });
});
