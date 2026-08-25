import { describe, expect, it } from "vitest";
import type { GeometryRect } from "@apatureai/verdict-types";
import { MAX_GEOMETRY_ENTRIES_PER_VIEWPORT, renderGeometry } from "../src/index.js";

/**
 * Judge-unlock §2.4: an over-budget map is NEVER silently truncated. When a
 * viewport exceeds its entry budget, the renderer keeps the head, drops the tail,
 * and emits an explicit truncation line — because a silent truncation is how the
 * model learns the false belief that the map is a complete description of the page.
 */

const geom = (i: number): GeometryRect => ({
  route: "/",
  viewport: "mobile",
  selector: `#e${i}`,
  role: "generic",
  rect: { x: 0, y: 0, width: 100, height: 20 },
});

function selectorsIn(block: string): Set<string> {
  const out = new Set<string>();
  for (const line of block.split("\n")) {
    const m = /^- (#e\d+) box /.exec(line);
    if (m) out.add(m[1] as string);
  }
  return out;
}

describe("renderGeometry budget (judge-unlock §2.4)", () => {
  it("keeps entries up to the per-viewport budget and emits an explicit truncation line", () => {
    const over = MAX_GEOMETRY_ENTRIES_PER_VIEWPORT + 40;
    const block = renderGeometry(Array.from({ length: over }, (_, i) => geom(i)));
    const rendered = selectorsIn(block);
    expect(rendered.size).toBe(MAX_GEOMETRY_ENTRIES_PER_VIEWPORT);
    // The head is kept, in input order; the tail is dropped.
    expect(rendered.has("#e0")).toBe(true);
    expect(rendered.has(`#e${MAX_GEOMETRY_ENTRIES_PER_VIEWPORT - 1}`)).toBe(true);
    expect(rendered.has(`#e${MAX_GEOMETRY_ENTRIES_PER_VIEWPORT}`)).toBe(false);
    // The omission is disclosed, never silent.
    expect(block).toMatch(/further element\(s\) omitted \(prompt budget\)/);
  });

  it("does not emit a truncation line when the map fits", () => {
    const block = renderGeometry(Array.from({ length: 10 }, (_, i) => geom(i)));
    expect(block).not.toMatch(/omitted \(prompt budget\)/);
    expect(selectorsIn(block).size).toBe(10);
  });
});
