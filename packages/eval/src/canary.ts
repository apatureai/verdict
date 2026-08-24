import type { Dimension, Severity } from "@apatureai/verdict-types";

/**
 * Synthetic-canary generator (TRD §10, #44). A programmatic defect injector that
 * mutates a baseline UI in known ways (mutate a design token, break a
 * breakpoint, swap a font) so the ground truth (which finding a correct reviewer
 * MUST produce) is known by construction. Cheap to generate in the hundreds; the
 * regression gate (#47) asserts recall against these. The actual rendering of a
 * mutated canary is the capture worker's job (#11); this is the pure spec +
 * ground-truth generation, fully testable without a browser.
 */
export type CanaryDefect = "mutated_token" | "broken_breakpoint" | "swapped_font";

export const CANARY_DEFECTS: CanaryDefect[] = ["mutated_token", "broken_breakpoint", "swapped_font"];

/** The finding a correct reviewer must produce for a canary (ground truth). */
export interface CanaryGroundTruth {
  dimension: Dimension;
  route: string;
  /** The finding must be at least this severe to count as caught. */
  minSeverity: Severity;
}

export interface CanarySpec {
  id: string;
  defect: CanaryDefect;
  route: string;
  /** The concrete mutation applied (what to change when rendering the canary). */
  mutation: Record<string, string>;
  groundTruth: CanaryGroundTruth;
}

export interface CanaryBaseline {
  routes: string[];
  /** Design-token names available to mutate (#56-#59), e.g. "color.primary". */
  tokenNames: string[];
  /** Responsive breakpoint names, e.g. "sm", "md". */
  breakpoints: string[];
  /** Font-family token names, e.g. "fontFamily.sans". */
  fontNames: string[];
}

/** Each defect maps to the rubric dimension a correct reviewer should flag. */
const DEFECT_DIMENSION: Record<CanaryDefect, Dimension> = {
  mutated_token: "color_contrast",
  broken_breakpoint: "responsiveness",
  swapped_font: "typography",
};

const DEFECT_MIN_SEVERITY: Record<CanaryDefect, Severity> = {
  mutated_token: "minor",
  broken_breakpoint: "major",
  swapped_font: "minor",
};

function mutationFor(defect: CanaryDefect, baseline: CanaryBaseline, variant: number): Record<string, string> {
  switch (defect) {
    case "mutated_token": {
      const token = baseline.tokenNames[variant % Math.max(1, baseline.tokenNames.length)] ?? "color.primary";
      return { kind: "token", target: token, value: "#777777" }; // off-spec, low-contrast value
    }
    case "broken_breakpoint": {
      const bp = baseline.breakpoints[variant % Math.max(1, baseline.breakpoints.length)] ?? "md";
      return { kind: "breakpoint", target: bp, value: "disabled" };
    }
    case "swapped_font": {
      const font = baseline.fontNames[variant % Math.max(1, baseline.fontNames.length)] ?? "fontFamily.sans";
      return { kind: "font", target: font, value: "Comic Sans MS" };
    }
  }
}

export interface GenerateCanariesOptions {
  /** Defect types to inject (default: all). */
  defects?: CanaryDefect[];
  /** Variants per (route, defect) to scale into the hundreds (default 1). */
  variantsPerCombo?: number;
}

/**
 * Generate canary specs across routes × defects × variants. Deterministic: the
 * same baseline + options always yields the same specs (stable ids), so the
 * frozen eval set is reproducible.
 */
export function generateCanaries(
  baseline: CanaryBaseline,
  options: GenerateCanariesOptions = {},
): CanarySpec[] {
  const defects = options.defects ?? CANARY_DEFECTS;
  const variants = Math.max(1, options.variantsPerCombo ?? 1);
  const specs: CanarySpec[] = [];

  for (const route of baseline.routes) {
    for (const defect of defects) {
      for (let v = 0; v < variants; v++) {
        const slug = route.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root";
        specs.push({
          id: `canary_${defect}_${slug}_${v}`,
          defect,
          route,
          mutation: mutationFor(defect, baseline, v),
          groundTruth: {
            dimension: DEFECT_DIMENSION[defect],
            route,
            minSeverity: DEFECT_MIN_SEVERITY[defect],
          },
        });
      }
    }
  }
  return specs;
}
