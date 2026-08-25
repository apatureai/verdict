import type { GeometryRect, StyleDigest } from "@apatureai/verdict-types";
import { describe, expect, it } from "vitest";
import {
  citableSelectors,
  renderGeometry,
  MAX_GEOMETRY_CHARS_PER_VIEWPORT,
} from "../src/index.js";

/**
 * C3 regression: the prompt's citable set must never be SILENTLY narrower than the
 * gate's accept set. In the field the per-viewport char budget admitted only 33 of
 * 59 elements, and 19 of those slots went to invoice `td/tr` rows sharing two
 * style digests — evicting `body > footer > a` (the one finding the judge got
 * right) and the SF Mono element, which the model then refused to report because it
 * "wasn't in the block", while the gate still accepted those evicted selectors.
 *
 * The fix dedups repeated style signatures into a compact `also cite` list and
 * admits full lines by significance, and exposes the citable set (`citableSelectors`)
 * as the single source of truth the gate's accept set is derived from.
 */

const baseStyle = (over: Partial<StyleDigest> = {}): StyleDigest => ({
  fontFamily: "Inter",
  fontSizePx: 14,
  fontWeight: 400,
  lineHeightPx: 20,
  color: "#111111",
  backgroundColor: "transparent",
  paddingPx: [8, 8, 8, 8],
  marginPx: [0, 0, 0, 0],
  gapPx: null,
  borderRadiusPx: 0,
  display: null,
  ...over,
});

const el = (
  selector: string,
  role: string | null,
  style: StyleDigest,
  over: Partial<GeometryRect> = {},
): GeometryRect => ({
  route: "/",
  viewport: "desktop",
  selector,
  role,
  rect: { x: 0, y: 0, width: 200, height: 24 },
  style,
  ...over,
});

/** Parse every selector the rendered block leaves citable: full lines AND `also cite` lists. */
function citableInBlock(block: string): Set<string> {
  const out = new Set<string>();
  for (const line of block.split("\n")) {
    const full = /^- (.+?) box /.exec(line);
    if (full?.[1]) {
      out.add(full[1]);
      continue;
    }
    const also = /^\s*also cite(?: \(same S\d+\))?:\s*(.+)$/.exec(line);
    if (also?.[1]) for (const s of also[1].split(", ")) out.add(s.trim());
  }
  return out;
}

describe("C3 — citableSelectors is the single source of truth for the block", () => {
  it("citableSelectors equals exactly what renderGeometry renders as citable", () => {
    // A padding tuple wide enough that each invoice row is a long full line.
    const rowStyle = baseStyle({ fontFamily: "Georgia", paddingPx: [12, 16, 12, 16] });
    const rows: GeometryRect[] = Array.from({ length: 40 }, (_, i) =>
      el(`body > table > tbody > tr:nth-child(${i + 1}) > td.amount`, "generic", rowStyle, {
        label: `line item ${i} description text that is fairly long`,
      }),
    );
    const geometry: GeometryRect[] = [
      el("body > header > nav", "navigation", baseStyle({ fontFamily: "Inter", fontWeight: 600 })),
      ...rows,
      el("body > footer > a", "link", baseStyle({ fontFamily: "Inter", color: "#3366cc" })),
      el("code.sha", "generic", baseStyle({ fontFamily: "SF Mono", fontSizePx: 12 })),
    ];

    const rendered = citableInBlock(renderGeometry(geometry));
    const declared = citableSelectors(geometry);
    expect(rendered).toEqual(declared);
  });

  it("keeps the significant distinct elements citable while collapsing the duplicate rows", () => {
    const rowStyle = baseStyle({ fontFamily: "Georgia", paddingPx: [12, 16, 12, 16] });
    const rows: GeometryRect[] = Array.from({ length: 40 }, (_, i) =>
      el(`body > table > tbody > tr:nth-child(${i + 1}) > td.amount`, "generic", rowStyle, {
        label: `line item ${i} description text that is fairly long indeed here`,
      }),
    );
    const geometry: GeometryRect[] = [
      el("body > header > nav", "navigation", baseStyle({ fontWeight: 600 })),
      ...rows,
      el("body > footer > a", "link", baseStyle({ color: "#3366cc" })),
      el("code.sha", "generic", baseStyle({ fontFamily: "SF Mono", fontSizePx: 12 })),
    ];

    const block = renderGeometry(geometry);
    const citable = citableSelectors(geometry);

    // The subject of the RIGHT finding and the rare-font element are citable —
    // never evicted by a wall of near-identical rows.
    expect(citable.has("body > footer > a")).toBe(true);
    expect(citable.has("code.sha")).toBe(true);
    expect(citable.has("body > header > nav")).toBe(true);
    // Every invoice row stays citable too (collapsed, not dropped).
    for (let i = 1; i <= 40; i++) expect(citable.has(`body > table > tbody > tr:nth-child(${i}) > td.amount`)).toBe(true);
    // The collapse actually happened: an `also cite` list carries the duplicate rows.
    expect(block).toContain("also cite");
    // The rare-font element got a real full line (it is the representative of its signature).
    expect(block).toContain("- code.sha box ");
    expect(block).toContain("- body > footer > a box ");
  });

  it("INVARIANT: the gate accept set (derived from citableSelectors) is never broader than the block", () => {
    // Whatever the budget does, the gate's accept set is citableSelectors(...),
    // so it can never accept a citation the prompt did not show.
    const rowStyle = baseStyle({ fontFamily: "Georgia" });
    const geometry: GeometryRect[] = Array.from({ length: 300 }, (_, i) =>
      el(`body > section > div.card-${i} > p.body-copy-${i}`, "generic", rowStyle, {
        label: `card ${i} body copy that is quite long to stress the char budget hard`,
      }),
    );
    const rendered = citableInBlock(renderGeometry(geometry));
    const gateAccepts = citableSelectors(geometry);
    // Equal, by construction (single plan) — never gate ⊋ prompt.
    expect(gateAccepts).toEqual(rendered);
  });

  it("discloses when the budget genuinely omits selectors (not silently)", () => {
    // 300 DISTINCT long selectors, each a unique signature: too many to all fit,
    // even collapsed. The overflow must be disclosed, and the omitted selectors
    // must NOT be citable (so the gate, fed from citableSelectors, rejects them).
    const geometry: GeometryRect[] = Array.from({ length: 300 }, (_, i) =>
      el(`body > main > section:nth-of-type(${i}) > article.card > div.inner > p.copy-${i}`, "generic", baseStyle({ fontSizePx: 10 + (i % 20) })),
    );
    const block = renderGeometry(geometry);
    const citable = citableSelectors(geometry);
    expect(block).toContain("further element(s) omitted");
    expect(citable.size).toBeLessThan(geometry.length);
    // Nothing citable was omitted; nothing omitted was citable.
    const rendered = citableInBlock(block);
    expect(rendered).toEqual(citable);
    // The per-viewport block respected the char budget (± the disclosure/legend slack).
    const desktopBlock = block.split("[desktop]")[1] ?? "";
    expect(desktopBlock.length).toBeLessThan(MAX_GEOMETRY_CHARS_PER_VIEWPORT + 600);
  });
});
