import type { Dimension, Grade, Severity, Viewport } from "@apatureai/verdict-types";
import { z } from "zod";

/**
 * Zod output schema + json_object validation (TRD §6.4, #31). DashScope can't do
 * strict `json_schema` for the VL models (research note 2026-06-18), so v1 uses
 * `response_format: json_object` with the schema described in-prompt (the request
 * must contain the literal word "JSON", which DashScope validates server-side) and
 * a Zod post-parse validator so the delivery layer NEVER parses prose. Self-host
 * uses vLLM guided decoding (#76). `json_object` guarantees valid JSON, not valid
 * fields; the drop-and-count gate (#32) is the load-bearing field check.
 */
const DIMENSIONS = [
  "visual_hierarchy",
  "spacing",
  "typography",
  "color_contrast",
  "consistency",
  "responsiveness",
  "accessibility",
  "brand",
] as const satisfies readonly Dimension[];

const SEVERITIES = ["nit", "minor", "major", "blocker"] as const satisfies readonly Severity[];
const VIEWPORTS = ["mobile", "tablet", "desktop"] as const satisfies readonly Viewport[];
const GRADES = ["ship", "ship_with_nits", "needs_work", "blocked"] as const satisfies readonly Grade[];

export const FindingSchema = z.object({
  dimension: z.enum(DIMENSIONS),
  severity: z.enum(SEVERITIES),
  confidence: z.number(),
  route: z.string(),
  viewport: z.enum(VIEWPORTS),
  elementRef: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  suggestion: z.string().nullable(),
  introducedByThisPr: z.boolean(),
});

export const CritiqueOutputSchema = z.object({
  grade: z.enum(GRADES),
  overall: z.string(),
  findings: z.array(FindingSchema),
  notReviewed: z.array(z.string()).default([]),
});

export type CritiqueOutput = z.infer<typeof CritiqueOutputSchema>;
export type ModelFinding = z.infer<typeof FindingSchema>;

export type ParseResult =
  | { ok: true; value: CritiqueOutput }
  | { ok: false; error: string };

/** Parse + Zod-validate the model's JSON output. Delivery never sees prose. */
export function parseCritiqueOutput(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const result = CritiqueOutputSchema.safeParse(raw);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

/**
 * JSON Schema for self-host vLLM **guided decoding** (#76, xgrammar/outlines).
 * Mirrors `CritiqueOutputSchema` so a single guided-decoding call yields output
 * that already passes the Zod validator (the drop-and-count gate #32 still runs).
 * `additionalProperties:false` + `required` make the grammar strict.
 */
export function critiqueJsonSchema(): Record<string, unknown> {
  const finding = {
    type: "object",
    additionalProperties: false,
    required: [
      "dimension",
      "severity",
      "confidence",
      "route",
      "viewport",
      "elementRef",
      "title",
      "description",
      "suggestion",
      "introducedByThisPr",
    ],
    properties: {
      dimension: { type: "string", enum: [...DIMENSIONS] },
      severity: { type: "string", enum: [...SEVERITIES] },
      confidence: { type: "number" },
      route: { type: "string" },
      viewport: { type: "string", enum: [...VIEWPORTS] },
      elementRef: { type: ["string", "null"] },
      title: { type: "string" },
      description: { type: "string" },
      suggestion: { type: ["string", "null"] },
      introducedByThisPr: { type: "boolean" },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["grade", "overall", "findings", "notReviewed"],
    properties: {
      grade: { type: "string", enum: [...GRADES] },
      overall: { type: "string" },
      findings: { type: "array", items: finding },
      notReviewed: { type: "array", items: { type: "string" } },
    },
  };
}

/**
 * The in-prompt schema description for the DashScope `json_object` path. Contains
 * the literal word "JSON" (required) and the exact field contract.
 */
export function schemaInstruction(): string {
  return [
    "Respond with ONLY a single JSON object — no prose, no markdown fences.",
    "The JSON must match this schema:",
    "{",
    '  "grade": "ship" | "ship_with_nits" | "needs_work" | "blocked",',
    '  "overall": string,',
    '  "findings": Array<{',
    `    "dimension": ${DIMENSIONS.map((d) => `"${d}"`).join(" | ")},`,
    `    "severity": ${SEVERITIES.map((s) => `"${s}"`).join(" | ")},`,
    '    "confidence": number (0..1),',
    '    "route": string (must be a captured route),',
    `    "viewport": ${VIEWPORTS.map((v) => `"${v}"`).join(" | ")},`,
    '    "elementRef": string | null (a selector from the provided geometry),',
    '    "title": string (a concise summary, <= ~80 chars),',
    '    "description": string (the grounded explanation of what is wrong),',
    '    "suggestion": string | null,',
    '    "introducedByThisPr": boolean',
    "  }>,",
    '  "notReviewed": string[]',
    "}",
  ].join("\n");
}
