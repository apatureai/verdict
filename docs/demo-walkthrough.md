Part of [verdict](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Quickstart

`node demo.mjs` does every step in this section for you and ends at step 2's output. Read on if you
want the parts: your own site instead of the demo one, a model configured, or the run taken apart.

### 1. Install

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm browser:install
```

`pnpm build` is not optional: the CLI runs from `dist/`. `pnpm browser:install` downloads the
Chromium build playwright-core drives, launches it once and prints the version it got. It fetches
Chromium, the headless shell and ffmpeg, roughly 275 MB downloaded and 565 MB on disk on macOS
arm64. It is safe to re-run:

```console
$ pnpm browser:install
Chromium was already installed — 151.0.7922.34 launches (playwright-core 1.62.1)
  cached in /Users/you/Library/Caches/ms-playwright
```

### 2. Run it, with no model configured

No endpoint yet? One command runs the whole pipeline against a bundled demo site, so you can see the
shape of the thing before you spend a token:

```sh
pnpm review
```

```console
$ pnpm review

judgment-engine — reviewing http://127.0.0.1:56441 (bundled demo site)
  CANNED replay client — authored responses, not a live model (packages/cli/fixtures/canned-critique.json)
  launching Chromium…
  capturing 2 route(s) × 3 viewport(s)…
  running triage + deep pass…

Target
  url         http://127.0.0.1:56441  (bundled demo site)
  routes      /, /pricing
  viewports   mobile, tablet, desktop
  model       CANNED replay client — authored responses, not a live model (packages/cli/fixtures/canned-critique.json)
  capture     chromium-playwright@1

Capture
  6 screenshot(s) written to out/screenshots
  66 DOM element(s) recorded in the geometry map
  page health: clean

Measured facts  (computed from the captured DOM, no model involved)
  13 measurement(s) (contrast 6, overflow 3, touch_target 4) over 5 distinct element(s)

   1. [contrast] / #hero-subtitle (mobile, tablet, desktop)
      text contrast 3.23:1 is below WCAG AA 4.5:1
   2. [overflow] / #promo-code (mobile, tablet, desktop)
      content width 345px exceeds container 140px and is clipped (overflow-x: hidden, text-overflow: clip, white-space: nowrap); not gated because the element is animated, so the content may scroll into view on its own and the affordance is the motion rather than anything in its computed style
   3. [touch_target] / #icon-close (mobile, tablet)
      touch target 20x20px is below the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA
   4. [contrast] /pricing #pricing-fineprint (mobile, tablet, desktop)
      text contrast 2.61:1 is below WCAG AA 4.5:1
   5. [touch_target] /pricing #plan-scale-cta (mobile, tablet)
      advisory: touch target 30x30px meets the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size
      (Minimum), level AA, and is below the 44x44px minimum in WCAG 2.2 SC 2.5.5 Target Size
      (Enhanced), level AAA
  every measurement: out/deterministic-facts.txt

Design-system grounding
  none (no_genome_file)
  [verdict] no design-system rule grounded this review (no_genome_file): no UI-DNA snapshot was found at packages/cli/fixtures/demo-site/ui-dna.json. No approved design-system rule was retrieved for any route. The critique was still grounded on what this repository does state about its design (9 design token(s), a brand block, 2 detected component librar(ies)) and on the measured facts, so it is a weaker review, not an empty one.

Grounding gate
  5 replayed finding(s) parsed, 2 dropped for citing a route or element that was never captured

Review
  grade       n/a (canned client, no model saw this page)
  findings    n/a (no model ran; see the measured facts above)
  confidence  n/a (no model ran)
  blocking    advisory only

  FIXTURE TEXT: replayed from the canned client, not a judgment about this page.
  It was authored before this page was captured; it survived the grounding gate
  only because this page happens to contain the elements it names.

    - [major/accessibility] Dismiss control is a 20x20 touch target
      / mobile → #icon-close
    - [major/accessibility] Scale plan action is a 30x30 arrow glyph
      /pricing mobile → #plan-scale-cta
    - [minor/visual_hierarchy] Headline and primary action carry similar weight
      / desktop → #hero-title

Wrote
  out/review.json
  out/system-prompt.txt
  out/geometry.json
  out/deterministic-facts.txt
  note: review.json carries the fixture's own grade field. It is not a grade for this page.
        its provenance block says the same in band: model_backed is false.

Done in 8.0s.
```

**Success looks like this:** **13 measurements** over 5 distinct elements, **2 dropped** by the
grounding gate, six real PNGs under `out/screenshots/`, and **no grade**. Open
`out/screenshots/index/desktop.png`, which is a photograph of the page those measurements came from.

The missing grade is the point. This run replays a fixture, so there is nothing for a grade to mean,
and the report says so instead of printing the fixture's own `grade` field as if a model had chosen
it. Configure a live endpoint (step 3) and the same run prints `grade`, a finding count and the
numbered findings a model actually produced.

`out/` is gitignored and disposable: each run overwrites the last, and `rm -rf out` is the whole
cleanup. Pass `--out <dir>` to keep two runs side by side.

### 3. Add a model, and the critique half turns on

**Out of the box the critique is a canned fixture, not a model.** With no endpoint configured, the
capture, the deterministic facts, the grounding gate and everything downstream are real, but the
findings themselves are replayed from `packages/cli/fixtures/canned-critique.json`. That fixture was
authored against the bundled demo site; it does not look at your screenshots. The report knows this
and refuses to print a grade under the canned or mock client, because a grade nothing looked at is
worse than no grade at all. Configure a real endpoint before you judge the tool's judgment.

Any OpenAI-compatible chat-completions endpoint that accepts images works: DashScope
compatible-mode, a self-hosted vLLM or SGLang server, or anything else that speaks the same wire
format. The base URL is never guessed; if `MODEL_API_KEY` is set without `MODEL_BASE_URL` the run
stops and tells you so.

```sh
export MODEL_BASE_URL=https://your-openai-compatible-endpoint/v1
export MODEL_API_KEY=<your-key>
# Name the models that endpoint actually serves. These default to the built-in
# Qwen ids, which exist on DashScope and on nothing else, so a run against
# OpenAI, Ollama or a self-hosted vLLM needs them set.
export TRIAGE_MODEL=<a cheap vision model>
export DEEP_MODEL=<your best vision model>
node packages/cli/dist/main.js --model live --routes / --viewports desktop
```

Both passes may name the same model. Triage is a cheap look that decides whether the deep pass is
worth running, so a smaller model there costs less and changes nothing about the review it
produces.

The banner states which client is live before a single page is captured:

```console
  model       LIVE model client — streaming against https://your-openai-compatible-endpoint/v1. Calls are billed to the owner of MODEL_API_KEY.
```

Screenshots are inlined as `data:` URIs, so your endpoint needs no access to your machine. One route
at one viewport is one triage call plus two deep-pass calls carrying roughly 220 KB of image data.
Cost depends entirely on your endpoint's pricing; this repository has no default vendor and no
default model beyond the `TRIAGE_MODEL` / `DEEP_MODEL` ids you can override.

Model selection is explicit: `--model auto | mock | canned | live`. `mock` is a deterministic empty
critique with no network call, useful for exercising the pipeline's shape in your own tests. Only
`live` means a model saw the page, and only `live` prints a grade.

### 4. Read the numbers

- **6 screenshots.** Two routes by three viewports at device scale factor 2, clock pinned, animations
  frozen, so a repeat run produces the same bytes. Prove it:

  ```console
  $ pnpm review -- --verify-stability
    page health: clean
    stability: verified — 6/6 page(s) byte-identical on a repeat capture
  ```

  It re-screenshots each already-prepared page rather than re-running the whole lifecycle, so it is
  cheap (7.6s to 8.0s on the demo site). If any page differs the line says `FAILED` and `page health`
  reports the capture as unstable.
- **13 measurements.** Measured, not asserted, and the reason an offline run is worth anything at
  all. The report prints one line per distinct defect with the viewports it was measured at, which
  is why 13 measurements read as 5 entries: the same contrast ratio at mobile, tablet and desktop is
  one thing to fix. The dismiss control appears at two viewports rather than three because a
  target-size criterion is about a finger, and the desktop capture is driven with a mouse. Every
  measurement, one per line, is in `out/deterministic-facts.txt`:

  ```
  [contrast] / mobile #hero-subtitle: text contrast 3.23:1 is below WCAG AA 4.5:1
  [overflow] / mobile #promo-code: content width 345px exceeds container 140px (horizontal overflow)
  [touch_target] / mobile #icon-close: touch target 20x20px is below the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA
  ```

  A clean page writes a line too, rather than an empty file:

  ```
  0 issues found (contrast, overflow and touch-target checks ran and measured no violation)
  ```

  An empty file was correct and unreadable: indistinguishable from a run where
  the checks never happened, in the one artifact that is true with no model
  involved.

  The demo site carries those three defects on purpose.
- **2 dropped.** The canned script contains five findings. Two cite things the capture never
  produced: `#pricing-table`, absent from the geometry map, and route `/checkout`, never captured.
  The gate deletes both and counts the drops. That is the trust mechanism running for real against a
  real geometry map.
- **The three replayed lines that survived.** They are printed under a `FIXTURE TEXT:` label, without
  numbering, because they are authored text from
  `packages/cli/fixtures/canned-critique.json` and not a judgment about anything. They survive only
  because the demo page happens to contain the elements the fixture names; against your own site
  they would almost certainly all be dropped. `out/review.json` still carries the fixture's `grade`
  and `findings` fields, since it is the engine's wire result verbatim, and the report's last line
  says so.
- **Confidence n/a.** Offline there is no model confidence to report at all. On a live run the line
  reads `withheld (missing_calibration_report)` until a promoted calibration report is bound, and the
  result stays advisory. Deliberate; see [Why it is interesting](design-notes.md#why-it-is-interesting).
- **`out/system-prompt.txt`** is the rubric that was actually sent: eight scored dimensions, the
  grounding rules, and the instruction-hierarchy defense. The demo repo ships a `.designreview.yml`
  brand block and a `package.json` with Radix, so the brand dimension is scored and the
  component-library addenda appear, both derived from the repository rather than hardcoded.

### Reviewing your own site, offline

Point it at anything you can reach and give it the directory holding that project's design system:

```sh
node packages/cli/dist/main.js \
  --url http://127.0.0.1:3000 \
  --routes /,/pricing \
  --context-dir ./my-app \
  --out ./out
```

`--context-dir` is read for `tokens.json` (W3C or Style Dictionary shape), `.designreview.yml` (the
`brand:` block) and `package.json` (component-library detection). All three are optional; each one
missing makes the review less grounded, not broken.

Without a live endpoint this run prints no grade and no findings, because every canned finding cites
an element your page does not have and the gate drops all of them. Against a two-element page of my
own, with no `MODEL_API_KEY` set:

```console
Measured facts  (computed from the captured DOM, no model involved)
  2 measurement(s) (contrast 1, touch_target 1) over 2 distinct element(s)

   1. [contrast] / #note (mobile)
      text contrast 2.52:1 is below WCAG AA 4.5:1
   2. [touch_target] / #close (mobile)
      touch target 20x20px is below the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA

Grounding gate
  3 replayed finding(s) parsed, 3 dropped for citing a route or element that was never captured

Review
  grade       n/a (canned client, no model saw this page)
  findings    n/a (no model ran; see the measured facts above)
  confidence  n/a (no model ran)
  blocking    advisory only

  The canned client produced no critique text. Nothing above judged this page;
  the measured facts are this run's only real output.
```

Those two measurements are genuinely about your page, and so are the screenshots,
`out/deterministic-facts.txt`, `out/geometry.json`, and `out/system-prompt.txt` built from your
`--context-dir`. Nothing else in that run is. For an actual critique, configure a model.
