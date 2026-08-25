import type { Dimension, Severity, Viewport } from "@apatureai/verdict-types";
import { CritiqueOutputSchema, FindingSchema, type CritiqueOutput, type ModelFinding } from "./schema.js";

/**
 * Salvage a critique from a deep pass whose structured coercion failed (#29/#31).
 *
 * The two-step deep pass produces a real, cited critique in step 1 (Thinking) and
 * then coerces it to the schema in step 2. When step 2 fails Zod, the pass used
 * to contribute NOTHING — in the field this discarded twelve correct, correctly
 * cited findings because a blind, image-less coercion returned `{}`. The engine
 * had the answer and threw it away.
 *
 * Salvage recovers findings directly from step 1's own output rather than
 * discarding them. Step 1 routinely emits partial JSON — `title`, `description`
 * and `element_ref` per finding — but not the full schema, because it was asked
 * to critique, not to fill a contract. So salvage:
 *   - INJECTS the fields the caller already knows (`route`, and `viewport` from
 *     the captured images) rather than trusting a blind pass to reproduce them,
 *   - keeps the model's real grounding (`element_ref`, title, description),
 *   - infers `dimension`/`severity` from the finding text with a conservative
 *     default, and
 *   - stamps a conservative, HONEST `confidence` — a recovered finding must never
 *     masquerade as a high-confidence structured one.
 *
 * The result is validated against the same `CritiqueOutputSchema` the normal path
 * uses, so a salvaged output is byte-for-byte a valid `CritiqueOutput`; the
 * caller marks it with a provenance flag so the recovery is never silent.
 */

/** Conservative confidence stamped on a recovered finding (never fabricated high). */
export const SALVAGE_CONFIDENCE = 0.5;

const DIMENSIONS: readonly Dimension[] = [
  "visual_hierarchy",
  "spacing",
  "typography",
  "color_contrast",
  "consistency",
  "responsiveness",
  "accessibility",
  "brand",
];
const SEVERITIES: readonly Severity[] = ["nit", "minor", "major", "blocker"];
const VIEWPORTS: readonly Viewport[] = ["mobile", "tablet", "desktop"];

export interface SalvageContext {
  /** The route being reviewed; injected onto every recovered finding. */
  route: string;
  /** Viewports actually captured for this route; the injected viewport comes from here. */
  viewports: Viewport[];
}

export interface SalvageResult {
  output: CritiqueOutput;
  /** How many findings were recovered (0 ⇒ nothing salvageable). */
  count: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Extract every parseable JSON value embedded in a model's text output: the whole
 * string if it is JSON, plus each top-level balanced `{...}` / `[...]` block found
 * inside prose or markdown fences. String contents are respected so a brace inside
 * a quoted description does not break the scan.
 */
export function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  const push = (raw: string): void => {
    try {
      values.push(JSON.parse(raw));
    } catch {
      /* not JSON; skip */
    }
  };

  const trimmed = text.trim();
  if (trimmed.length > 0) push(trimmed);

  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          push(text.slice(i, j + 1));
          i = j; // resume after this block
          break;
        }
      }
    }
  }
  return values;
}

/**
 * Every finding-shaped record reachable from the parsed JSON values, deduped by
 * content. The same finding is reachable more than once — `extractJsonValues`
 * yields the whole object AND the inner `findings` array as separate balanced
 * blocks — so identical records are collapsed to avoid publishing each twice.
 */
function collectRawFindings(values: unknown[]): Record<string, unknown>[] {
  const raw: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown): void => {
    const record = asRecord(candidate);
    if (!record) return;
    const key = JSON.stringify(record);
    if (seen.has(key)) return;
    seen.add(key);
    raw.push(record);
  };
  for (const value of values) {
    const record = asRecord(value);
    if (record && Array.isArray(record.findings)) record.findings.forEach(add);
    else if (Array.isArray(value)) value.forEach(add);
  }
  return raw;
}

function inferDimension(item: Record<string, unknown>, haystack: string): Dimension {
  const explicit = str(item.dimension);
  if (explicit && (DIMENSIONS as string[]).includes(explicit)) return explicit as Dimension;
  const h = haystack.toLowerCase();
  if (/contrast|wcag|color ratio|colour ratio/.test(h)) return "color_contrast";
  if (/overflow|clipp|responsive|breakpoint|off-?screen|horizontal scroll/.test(h)) return "responsiveness";
  if (/touch target|aria|screen reader|focus|keyboard|alt text|accessib/.test(h)) return "accessibility";
  if (/spacing|padding|margin|gap|align|whitespace/.test(h)) return "spacing";
  if (/font|type(face|scale)|line height|letter spacing|typograph/.test(h)) return "typography";
  if (/hierarch|emphasis|prominen|visual weight/.test(h)) return "visual_hierarchy";
  if (/brand|logo|palette token/.test(h)) return "brand";
  return "consistency";
}

function inferSeverity(item: Record<string, unknown>, haystack: string): Severity {
  const explicit = str(item.severity);
  if (explicit && (SEVERITIES as string[]).includes(explicit)) return explicit as Severity;
  const h = haystack.toLowerCase();
  if (/wcag|contrast|fails|broken|unusable|illegible|inaccessible|overflow|clipp/.test(h)) return "major";
  if (/nit|minor|slightly|small/.test(h)) return "nit";
  return "minor";
}

function pickViewport(item: Record<string, unknown>, haystack: string, viewports: Viewport[]): Viewport {
  const available = viewports.length > 0 ? viewports : [...VIEWPORTS];
  const explicit = str(item.viewport);
  if (explicit && (available as string[]).includes(explicit)) return explicit as Viewport;
  const h = haystack.toLowerCase();
  for (const v of available) {
    if (h.includes(v)) return v;
  }
  // Prefer desktop when captured, else the first captured viewport — deterministic.
  return available.includes("desktop") ? "desktop" : (available[0] as Viewport);
}

function gradeFromSeverities(findings: ModelFinding[]): CritiqueOutput["grade"] {
  if (findings.some((f) => f.severity === "blocker")) return "blocked";
  if (findings.some((f) => f.severity === "major" || f.severity === "minor")) return "needs_work";
  if (findings.length > 0) return "ship_with_nits";
  return "ship";
}

/**
 * Recover a valid `CritiqueOutput` from one or more step outputs (step-1 prose /
 * partial JSON first, then any failed coercion text). Returns `null` when nothing
 * finding-shaped can be found, so the caller can still record the route as
 * unreviewed rather than publish an empty salvage.
 */
export function salvageCritique(texts: string[], context: SalvageContext): SalvageResult | null {
  const values = texts.flatMap((t) => (typeof t === "string" ? extractJsonValues(t) : []));
  const raw = collectRawFindings(values);

  const findings: ModelFinding[] = [];
  for (const item of raw) {
    const title = str(item.title);
    const description = str(item.description);
    if (title === null && description === null) continue; // nothing to ground

    const haystack = `${title ?? ""} ${description ?? ""}`;
    const elementRef = str(item.elementRef) ?? str(item.element_ref) ?? null;
    const confidence = typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1
      ? item.confidence
      : SALVAGE_CONFIDENCE;

    const candidate = {
      dimension: inferDimension(item, haystack),
      severity: inferSeverity(item, haystack),
      confidence,
      // Injected, never trusted from the (possibly blind) model text: the caller
      // knows the route, and the viewport comes from the captured images.
      route: context.route,
      viewport: pickViewport(item, haystack, context.viewports),
      elementRef,
      title: title ?? (description as string),
      description: description ?? (title as string),
      suggestion: str(item.suggestion) ?? null,
      introducedByThisPr: typeof item.introducedByThisPr === "boolean" ? item.introducedByThisPr : false,
    };

    const parsed = FindingSchema.safeParse(candidate);
    if (parsed.success) findings.push(parsed.data);
  }

  if (findings.length === 0) return null;

  const output = CritiqueOutputSchema.safeParse({
    grade: gradeFromSeverities(findings),
    overall: `Recovered ${findings.length} finding${findings.length === 1 ? "" : "s"} from the deep pass after structured coercion failed.`,
    findings,
    notReviewed: [],
  });
  if (!output.success) return null;
  return { output: output.data, count: findings.length };
}
