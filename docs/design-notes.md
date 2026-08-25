Part of [verdict](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Who this is for

- **People building VLM-as-judge systems.** The grounding gate, the schema-constrained output, the
  instruction-hierarchy defense and the calibration binding are all here as working code you can read
  in an afternoon and lift into your own judge.
- **People who want automated design review in CI.** Point the CLI at a preview deploy, get findings
  scoped to your own tokens and brand rules rather than generic "improve the hierarchy" advice.
- **People who need reproducible screenshots.** The capture lifecycle (pinned clock, frozen
  animations, font readiness, lazy-load scroll, no `networkidle`) is independently useful, and
  `--verify-stability` proves byte-identical repeat captures.
- **People doing perceptual image diffing.** `rust/capture-dedup` is a dependency-free crate: dHash,
  DCT pHash, Hamming distance, SSIM and an anti-aliasing-aware pixel diff, with golden vectors a
  TypeScript test mirrors byte for byte.

### The split, precisely

| | What it needs | What you get |
| --- | --- | --- |
| **Capture and measure** | Node 24 and a Chromium download (`pnpm browser:install`). No key, no account. | Deterministic screenshots at three viewports, a DOM geometry map, and measured contrast / overflow / touch-target facts about the page you pointed it at. |
| **Critique** | Any OpenAI-compatible chat endpoint that accepts images, self-hosted or not. | Model findings, each pinned to a route and element the capture actually produced, plus a grade. |

`node demo.mjs` leaves the workspace built, so measuring a page you did not write is one more line:

```sh
node packages/cli/dist/main.js --url https://example.com --routes / --viewports mobile --model mock
```

```console
Measured facts  (computed from the captured DOM, no model involved)
  none: no contrast, overflow or touch-target violation was measured
```

That is a real run against a real page, and it is a measurement rather than a shrug: three checks
ran over the captured DOM and each one came back clean. `example.com` is two paragraphs of dark text
on white, and its one link sits inside a sentence, where both WCAG target-size criteria exempt it.
`out/screenshots/index/mobile.png` is the photograph those checks were run against. `--model mock`
states the absence of a model rather than hiding it: no network call, no critique, no grade. Swap in
a live endpoint ([step 3](demo-walkthrough.md#3-add-a-model-and-the-critique-half-turns-on)) and the same run adds the
critique.

Around that call the repository also ships the parts that usually get skipped: calibration (so
numeric confidence is earned rather than verbalized by the model), agreement metrics against human
raters, a release gate CLI, and a Rust crate for perceptual near-duplicate detection.

## Why it is interesting

**1. Structured output guarantees valid JSON. It does not guarantee true JSON.**
So every finding must carry a route and an `elementRef`, and both are checked against the geometry
map captured alongside the screenshot. If the model invents `#pricing-table`, or reviews a
`/checkout` route that was never captured, the finding is deleted and the drop is counted
(`packages/critique/src/hallucination-gate.ts`):

```ts
for (const finding of findings) {
  if (!routes.has(finding.route)) {                 // route was never captured
    hallucinationDrops++;
    continue;
  }
  if (selectors && finding.elementRef !== null && !selectors.has(finding.elementRef)) {
    hallucinationDrops++;                            // element isn't in the geometry map
    continue;
  }
  kept.push({ ...finding, confidence: clampConfidence(finding.confidence) });
}
```

For that check to be fair, the map has to contain everything the engine itself can point at. It holds
the landmark elements (`h1`-`h6`, `nav`, `a`, `button`, `input`, `select`, `textarea`) **and** every
element a deterministic check measured. The second half is not decoration: the contrast and overflow
checks run over text nodes, so `p`, `li` and `span` get measured but are not landmarks. With a
landmark-only map the engine could measure an overflow on a `<p>`, hand the model that measurement as
a fact it is told to trust, force a deep review because of it, and then delete the model's finding
about it as "citing a route or element that was never captured". That sentence was false: the
element had been captured *and* measured. An element the engine measured is groundable by
construction. Nothing else was added, so a genuinely uncaptured element is still deleted.

The gate is a small function, and that is the point. It is cheap because everything upstream is
arranged so that "can you point at it" has a real answer. `hallucinationDrops` is not discarded: it
is an SLO input surfaced through the `onCritique` observer, and it is a field on the wire result, so
a consumer can tell "the page is clean" apart from "three findings entered and none of them could be
grounded". Zero is emitted too, because zero is an answer to the same question.

**2. The model does not get to assert its own confidence.**
Verbalized confidence never crosses the wire. A numeric confidence is displayable only when an exact,
hash-matched promoted `CalibrationReportV1` is bound at runtime; that report owns the calibration
transform, the instability ceiling, the post-filter threshold and the blocking threshold. With no
matching report, confidence is withheld and the result is advisory, never blocking. The grade is then
reconciled downward from the findings that actually survived the gate, so the model cannot say
"blocked" while every blocking finding was dropped.

**3. A half-loaded page is a false-finding factory.**
Capture is a fixed lifecycle, not a `sleep`:

```
emulateMedia(reduce) -> freeze-inject -> clock.install(epoch - 60s)      [pre-navigation]
-> goto(domcontentloaded, 30s) -> ready_selector? -> fonts.ready -> layout-stable
-> clock.pauseAt(epoch)
-> autoScroll for lazy-load (bounded, infinite-scroll guard)
-> recheckFonts -> freeze-re-inject -> freezeAnimations() -> clock.pauseAt(epoch)
=> ready to screenshot
```

Readiness never uses `networkidle`: an analytics beacon keeps the network busy forever and a tracking
pixel fires too early, and both produce a screenshot of a page no user ever saw. Time is pinned to a
fixed epoch so countdowns and relative timestamps cannot churn. Animations are stopped twice, with a
CSS kill sheet (cheap, beatable by a higher-specificity `!important` rule) and the engine-level
animation timeline pause (specificity-proof). One fresh browser context per (route, viewport),
because the clock pin is per-context.

**4. Some facts should never be left to a model.**
WCAG contrast ratios, horizontal overflow and touch-target sizes are computed from the captured DOM
and handed to the model as facts it is told to trust over its own pixels. Each check reports nothing
it cannot measure exactly. Text whose backdrop never resolves to an opaque, parseable colour produces
no fact rather than a guessed one, and neither does text over a photograph, where a flattened colour
would report white-on-a-photo as 1.00:1. A gradient is not a photograph: where its stops are plain
colours the backdrop is known at every point of the element, and the text is measured against the
worst of them, because a ratio that fails anywhere on the element fails somewhere on the element.
An element that scrolls on purpose is not overflow, and neither is a line the author cut on purpose
and marked with an ellipsis. A pointer-target criterion is measured where a finger is the pointer,
at the level the emitted sentence names.

**5. It judges, it never edits.**
There is no write path to any repository anywhere in this codebase, and no code that drives the UI.
It produces findings; acting on them is somebody else's job.
