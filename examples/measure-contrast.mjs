// Library example: the no-key, deterministic half of verdict.
//
// verdict's measurement functions are pure: they take captured computed styles
// and geometry and return WCAG facts with no browser, no model, and no API key.
// This is the same code that produces the "Measured facts" section of a review,
// exercised here on hand-written inputs so you can see the shape of the output.
//
// Run it from a fresh clone:
//
//     pnpm install --frozen-lockfile
//     pnpm build
//     node examples/measure-contrast.mjs
//
// The import below reaches into the built workspace output. Once the @apatureai/verdict-*
// packages are published to npm (see the release workflow), the same import
// becomes `import { ... } from "@apatureai/verdict-capture";` with nothing else changed.
import {
  contrastRatio,
  contrastViolations,
} from "../packages/capture/dist/index.js";

// 1. The primitive: a WCAG contrast ratio between two opaque colors (1..21).
const heroText = { r: 0x8a, g: 0x8a, b: 0x8a }; // #8a8a8a grey label
const heroBackground = { r: 0xff, g: 0xff, b: 0xff }; // on white
const ratio = contrastRatio(heroText, heroBackground);
console.log(`contrastRatio(#8a8a8a on #ffffff) = ${ratio.toFixed(2)}:1`);
console.log(`  WCAG AA body text needs 4.5:1 -> ${ratio >= 4.5 ? "passes" : "FAILS"}\n`);

// 2. The check the engine actually grounds a finding on. Feed it the computed
//    style + geometry of a text node (what the Chromium capture reports per
//    element) and it returns a measured finding, or nothing when the contrast
//    is fine. Nothing here is a guess: the ratio is computed from the colors.
const nodes = [
  {
    route: "/",
    viewport: "desktop",
    selector: "#hero-subtitle",
    fontSizePx: 14,
    fontWeight: 400,
    color: "rgb(138, 138, 138)",
    backgroundColor: "rgb(255, 255, 255)",
    rect: { x: 0, y: 120, width: 480, height: 20 },
    contentWidthPx: 480,
  },
  {
    route: "/",
    viewport: "desktop",
    selector: "#hero-title",
    fontSizePx: 32,
    fontWeight: 700,
    color: "rgb(17, 17, 17)",
    backgroundColor: "rgb(255, 255, 255)",
    rect: { x: 0, y: 80, width: 480, height: 40 },
    contentWidthPx: 480,
  },
];

const findings = contrastViolations(nodes);
console.log(`contrastViolations over ${nodes.length} nodes -> ${findings.length} finding(s):`);
for (const f of findings) {
  console.log(`  [${f.kind}] ${f.route} ${f.selector} (${f.viewport})`);
  console.log(`    ${f.detail}`);
}
if (findings.length === 0) {
  console.log("  (none — every node cleared its WCAG threshold)");
}
console.log(
  "\nThe dark bold title cleared its threshold and produced no finding; only the" +
    "\nlow-contrast subtitle did. That is a measured fact about the page, not a" +
    "\nmodel's opinion — which is exactly what verdict lets a critique cite.",
);
