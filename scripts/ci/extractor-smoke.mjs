#!/usr/bin/env node
/**
 * The DOM extractor against a REAL Chromium.
 *
 * `packages/capture/test/*` drives a fake browser, which is the right default,
 * because no test may launch a browser. But that leaves one seam untested: what Chromium
 * actually returns from `getComputedStyle`, and therefore whether the
 * deterministic contrast fact published for a page is true. A page that never
 * declares a background reports `rgba(0, 0, 0, 0)` for every ancestor, and
 * reading that as opaque black once made black-on-white text measure 1.00:1,
 * a fabricated "measurement" fed straight into the model prompt.
 *
 * So this runs the real extractor expression against real pages and asserts the
 * facts. It needs a Chromium binary (`pnpm browser:install`) and runs in the
 * `quickstart` CI job, next to the other browser-backed check.
 *
 * Usage: node scripts/ci/extractor-smoke.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  DOM_EXTRACT_EXPRESSION,
  deterministicChecks,
  toInteractiveElements,
  toTextNodeStyles,
} from "../../packages/capture/dist/index.js";

const require = createRequire(new URL("../../packages/capture/package.json", import.meta.url));
const { chromium } = require("playwright-core");

/**
 * Each case: a page, and the facts it must (and must not) produce.
 *
 * `expectOverflow` is checked the same way as `expectContrast`, and for the
 * same reason. Whether a clip is a deliberate truncation or lost content is
 * decided from `text-overflow` and `white-space` as CHROMIUM computes them, and
 * a fixture recorded once cannot notice the day that serialization changes.
 * Absent means the page must produce no overflow fact at all.
 *
 * Its pixel counts are normalized away before comparing, because the width of a
 * line of text in the default UA font is a property of the machine and this has
 * to pass on a developer's laptop and on a CI runner. What is asserted here is
 * the DECISION and the properties it cites; the exact widths are asserted
 * against a recorded capture in `packages/capture/test/real-pages.test.ts`.
 */
const CASES = [
  {
    name: "black text on the browser's default canvas",
    html: `<h1 style="font-size:32px">Northwind</h1>`,
    // 21:1. The regression case: this used to be reported as 1.00:1.
    expectContrast: [],
  },
  {
    name: "grey text on an explicit white background",
    html: `<body style="background:#fff"><p style="color:#999">Faint copy</p></body>`,
    expectContrast: ["text contrast 2.85:1 is below WCAG AA 4.5:1"],
  },
  {
    name: "translucent text composited onto the default canvas",
    html: `<p style="color:rgba(0,0,0,0.45)">Faded copy</p>`,
    // rgba(0,0,0,.45) over white renders as rgb(140,140,140).
    expectContrast: ["text contrast 3.36:1 is below WCAG AA 4.5:1"],
  },
  {
    name: "translucent overlay over the default canvas",
    // A 50%-black panel renders mid-grey; black text on it clears AA at 5.32:1.
    html: `<div style="background:rgba(0,0,0,0.5)"><p style="color:#000">On a panel</p></div>`,
    expectContrast: [],
  },
  {
    name: "page that opted into a dark color-scheme",
    // The dark UA canvas shade is an implementation detail, so the backdrop is
    // unknown and the check must stay silent rather than guess.
    html: `<style>:root{color-scheme:dark}</style><p style="color:#fff">Dark mode copy</p>`,
    expectContrast: [],
  },
  {
    name: "background in a color space the extractor does not parse",
    html: `<div style="background:oklch(0.7 0.1 200)"><p style="color:#8a8a8a">Wide gamut</p></div>`,
    expectContrast: [],
  },
  {
    name: "white text on a gradient with plain color stops",
    // A gradient states its endpoints, so the backdrop IS known: white text is
    // comfortable at the #1b3a6b end and invisible at the #eaf2ff end. Advisory,
    // because the engine knows what the box paints and not where the glyphs sat.
    html: `<div style="background-image:linear-gradient(#1b3a6b,#eaf2ff)"><p style="color:#fff">Booking closes tonight</p></div>`,
    expectContrast: [
      "advisory: text contrast 1.13:1 at the worst stop of the background gradient is below WCAG AA 4.5:1",
    ],
  },
  {
    name: "gradient with a stop the extractor cannot parse",
    // One unreadable stop makes the whole run unknowable: the missing endpoint
    // could be the worst one, so the readable stops are not an answer.
    html: `<div style="background-image:linear-gradient(oklch(0.7 0.1 200),#eaf2ff)"><p style="color:#fff">Wide gamut stop</p></div>`,
    expectContrast: [],
  },
  {
    name: "text over a photograph, gradient or not",
    // A 1x1 PNG stands in for the dusk sky. Nothing a bitmap paints is
    // computable from a flattened colour, and laying a gradient over one does
    // not make it so.
    html:
      `<div style="background-image:linear-gradient(rgba(0,0,0,0.15),rgba(0,0,0,0.55)),` +
      `url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')">` +
      `<p style="color:#fff">Field notes from the ridge</p></div>`,
    expectContrast: [],
  },
  {
    name: "a line the author truncated with an ellipsis",
    // The card title, cut on purpose, with the mark that tells the reader so.
    html:
      `<p style="width:220px;overflow-x:hidden;text-overflow:ellipsis;white-space:nowrap">` +
      `Quarterly revenue recognition policy, revised August 2026</p>`,
    expectOverflow: [],
  },
  {
    name: "a line clipped with no affordance at all",
    // The same clip, and the end of the line is simply gone.
    html:
      `<p style="width:140px;overflow-x:hidden;white-space:nowrap">` +
      `Balance due 1,284,905.42 USD by 2026-09-01</p>`,
    expectOverflow: [
      "content width Npx exceeds container Npx and Npx of it is clipped away with no " +
        "truncation affordance (overflow-x: hidden, text-overflow: clip, white-space: nowrap)",
    ],
  },
  {
    name: "a code block that scrolls on purpose",
    // scrollWidth is wider than the box on every render, forever, and every
    // pixel of it is reachable.
    html:
      `<pre style="width:240px;overflow-x:auto;white-space:pre">` +
      `$ pnpm --filter @apatureai/verdict-capture exec vitest run --reporter verbose</pre>`,
    expectOverflow: [],
  },
];

function fail(message) {
  console.error(`extractor-smoke: ${message}`);
  process.exitCode = 1;
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ colorScheme: "light" });
  for (const testCase of CASES) {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><meta charset="utf-8">${testCase.html}`);
    const extracted = await page.evaluate(DOM_EXTRACT_EXPRESSION);
    await page.close();

    const facts = deterministicChecks({
      textNodes: toTextNodeStyles(extracted, "/", "desktop"),
      interactive: toInteractiveElements(extracted, "/", "desktop"),
    });
    let ok = true;
    for (const [kind, want] of [
      ["contrast", testCase.expectContrast ?? []],
      ["overflow", testCase.expectOverflow ?? []],
    ]) {
      const got = facts
        .filter((fact) => fact.kind === kind)
        .map((fact) => (kind === "overflow" ? fact.detail.replace(/\d+px/g, "Npx") : fact.detail));
      const expected = JSON.stringify(want);
      const actual = JSON.stringify(got);
      if (actual !== expected) {
        ok = false;
        fail(`${testCase.name}\n  expected ${kind} facts ${expected}\n  got                    ${actual}`);
      }
    }
    if (ok) {
      const stated = facts.map((fact) => fact.detail);
      console.log(`ok - ${testCase.name}${stated.length > 0 ? ` (${stated.join("; ")})` : " (silent)"}`);
    }
  }
  await context.close();
} finally {
  await browser.close();
}

if (process.exitCode) {
  console.error(
    `extractor-smoke FAILED, see ${fileURLToPath(new URL("../../packages/capture/src/color.ts", import.meta.url))}`,
  );
} else {
  console.log(`extractor-smoke: ${CASES.length} page(s) checked against a real Chromium`);
}
