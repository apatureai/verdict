import type { Finding } from "@apatureai/verdict-types";

/**
 * Post-parse validation gate + hallucination metric (TRD §6.4, #32), the core
 * anti-hallucination mechanism. `json_object` (#31) guarantees valid JSON, not
 * valid fields, so after parse we:
 *   1. clamp confidence into [0,1] (non-finite -> 0),
 *   2. DROP any finding whose `route` was not captured, or whose `elementRef` is
 *      not a key in the DOM geometry map (#18),
 * and count the drops as a model-hallucination metric that feeds eval and the
 * gated SLO (#72) / Grafana (#9). Repair/re-ask is deferred.
 */
export interface HallucinationGateInput {
  /** Routes that were actually captured (#62 diff->route + capture). */
  capturedRoutes: Iterable<string>;
  /** Valid `elementRef` selectors from the geometry map (#18). When omitted, elementRef is not checked. */
  geometrySelectors?: Iterable<string>;
}

export interface HallucinationGateResult {
  findings: Finding[];
  /** Count of findings dropped for an uncaptured route / unknown element_ref. */
  hallucinationDrops: number;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function hallucinationGate(
  findings: Finding[],
  input: HallucinationGateInput,
): HallucinationGateResult {
  const routes = new Set(input.capturedRoutes);
  const selectors = input.geometrySelectors ? new Set(input.geometrySelectors) : null;

  const kept: Finding[] = [];
  let hallucinationDrops = 0;

  for (const finding of findings) {
    if (!routes.has(finding.route)) {
      hallucinationDrops++;
      continue;
    }
    if (selectors && finding.elementRef !== null && !selectors.has(finding.elementRef)) {
      hallucinationDrops++;
      continue;
    }
    kept.push({ ...finding, confidence: clampConfidence(finding.confidence) });
  }

  return { findings: kept, hallucinationDrops };
}
