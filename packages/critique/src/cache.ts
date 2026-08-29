/**
 * Prefix-cache layout (TRD §6.6/§9, #34). The repo context block (#63) is a
 * stable PREFIX so the model's prefix cache (DashScope context cache implicit/
 * explicit, or vLLM automatic prefix caching on self-host) reuses it across
 * reviews of the same repo state; volatile content (route, tiled images,
 * geometry, feedback digest) follows it. There is no Anthropic-style
 * `cache_control`/TTL knob in this layer; reuse is keyed on the byte-identical
 * prefix. Per the 2026-06-18 research note, DashScope's explicit `cache_control`
 * (10% vs 20% implicit, 1024-tok floor) is a later cost lever; the cacheable
 * unit is this prefix either way.
 */
export function cachePrefix(systemPrompt: string, contextBlock: string): string {
  return `${systemPrompt}\n\nREPO CONTEXT:\n${contextBlock}`;
}

/**
 * Coarse ~4-chars/token estimate of a cacheable prompt PREFIX's size — the input
 * tokens a prefix-cache HIT avoids re-prefilling on each repeated call (G4). It is a
 * MEASUREMENT of the reusable prefill, never a promise of a speedup: the realized
 * saving is whatever the backend echoes back on `ModelUsage.cachedTokens`
 * (`cachedInputTokens`). Same estimator the context-window preflight uses, so the
 * two numbers are comparable.
 */
export function cacheablePrefixTokens(prefix: string): number {
  return Math.ceil(prefix.length / 4);
}

/** Model-reported cached input tokens for a call (#9 telemetry / cache-hit signal). */
export function cachedInputTokens(usage: { cachedTokens: number }): number {
  return usage.cachedTokens;
}

/** Whether a response hit the prefix cache (cached_tokens > 0). */
export function isCacheHit(usage: { cachedTokens: number }): boolean {
  return usage.cachedTokens > 0;
}
