import type { ReviewDepth } from "@apatureai/verdict-types";
import type { Rect } from "./checks.js";

/**
 * Screenshot pixel-budget fitting + coordinate rescale (TRD §4.2/§9/§16).
 *
 * Tiles are downscaled to the model's `max_pixels` budget BEFORE upload so the
 * server never silently resizes (which would desync element refs). The exact
 * capture/sent ratio is tracked so any coordinate the model returns in sent
 * space is rescaled back to captured space, so element_ref boxes land 1:1.
 *
 * Budgets are per-tier config (triage vs deep), never a hardcoded Claude cap.
 * The actual pixel resampling (sharp) is the worker seam; this module is the
 * pure geometry so it is fully testable without an image library or a browser.
 */

/** Qwen3-VL patch size is 16; dims are rounded to multiples of 2×patch = 32. */
export const PATCH_SIZE = 16;
export const DIMENSION_MULTIPLE = 2 * PATCH_SIZE;

/**
 * Per-tier `max_pixels` budgets (total pixels per sent tile). Tunable config:
 * triage uses the fast model with a smaller budget; deep gets more detail.
 */
export const PIXEL_BUDGETS: Record<ReviewDepth, number> = {
  triage: 1_024 * 1_024,
  deep: 2_048 * 1_536,
};

export interface ScaledDimensions {
  /** Sent (downscaled) dimensions, each a multiple of `DIMENSION_MULTIPLE`. */
  width: number;
  height: number;
  /** captured/sent ratio per axis; multiply model-returned coords by this. */
  ratioX: number;
  ratioY: number;
}

export interface Point {
  x: number;
  y: number;
}

function roundDownToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

/**
 * Fit a captured tile into `maxPixels`, rounding both dimensions down to a
 * multiple of `multiple` (patch alignment). Never upscales. Returns the sent
 * dimensions and the captured/sent ratio for coordinate rescale.
 */
export function fitToPixelBudget(
  capturedWidth: number,
  capturedHeight: number,
  maxPixels: number,
  multiple: number = DIMENSION_MULTIPLE,
): ScaledDimensions {
  if (capturedWidth <= 0 || capturedHeight <= 0) {
    throw new Error("captured dimensions must be positive");
  }

  const area = capturedWidth * capturedHeight;
  // Only shrink: within budget keeps native size (still patch-aligned).
  const scale = area > maxPixels ? Math.sqrt(maxPixels / area) : 1;

  const width = roundDownToMultiple(capturedWidth * scale, multiple);
  const height = roundDownToMultiple(capturedHeight * scale, multiple);

  return {
    width,
    height,
    ratioX: capturedWidth / width,
    ratioY: capturedHeight / height,
  };
}

/** Fit to the per-tier budget for a review depth. */
export function fitForDepth(
  capturedWidth: number,
  capturedHeight: number,
  depth: ReviewDepth,
): ScaledDimensions {
  return fitToPixelBudget(capturedWidth, capturedHeight, PIXEL_BUDGETS[depth]);
}

/** Map a point from sent (model) space back to captured space. */
export function rescalePoint(point: Point, dims: ScaledDimensions): Point {
  return { x: point.x * dims.ratioX, y: point.y * dims.ratioY };
}

/** Map a rect from sent (model) space back to captured space. */
export function rescaleRect(rect: Rect, dims: ScaledDimensions): Rect {
  return {
    x: rect.x * dims.ratioX,
    y: rect.y * dims.ratioY,
    width: rect.width * dims.ratioX,
    height: rect.height * dims.ratioY,
  };
}
