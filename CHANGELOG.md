# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once a
1.0 line is cut. Until then the API may still move between 0.1.x releases.

Each entry corresponds to a git tag and a matching GitHub release; the release
pages carry the long-form prose these notes summarize.

## [Unreleased]

Changes on `main` since the v0.1.4 tag, not yet cut as a release. When the next
release is tagged, move these under its version heading and bump `version` in
every `package.json` to match (the `release.yml` workflow refuses to publish a
tag that does not match `package.json`).

### Fixed

- **The post-filter no longer silently deletes distinct ungrounded findings.**
  Every finding with `elementRef: null` in one dimension collided on the dedupe
  key `dimension|`, so two honest, differently-subjected findings collapsed to one
  and the loser was dropped *before* withheld findings were computed — undisclosed.
  Null-ref findings now key on their subject, and the filter reports
  `mergedDuplicates` so any cross-viewport merge is counted, never silent.
- **A mislabelled dimension can no longer destroy a novel finding.** The
  duplicate-of-measurement gate applied a dimension's prior claim class even when
  the finding's text carried no marker for it, so a token-mismatch the model
  mislabelled `color_contrast` was matched against a same-element contrast
  measurement and hard-dropped. The prior now fires only when a lexical marker of
  its class is present; the page-overflow demotion stays dimension-keyed for eval
  parity.
- **Citation grounding resolves an unambiguous suffix and counts every drop.** A
  correct reference like `h1` (map key `body > main > h1`) is now accepted when
  exactly one selector matches; two or more are rejected. A comma-cite's fabricated
  half is counted as a hallucination instead of vanishing while its real half
  publishes, and the trailing-role strip is restricted to a single role token so a
  multi-word parenthetical can no longer smuggle a real element ref past the gate.

### Changed

- **The invariant prompt prefix is now cacheable.** The frozen system prompt, repo
  context, trusted design-system rules, build facts, and repo memory are assembled
  strictly first with no per-call interpolation, so a prefix-caching backend reuses
  the prefill across a run's shots instead of re-running it every call. Per-shot
  geometry and the untrusted page text stay in the user turn.
- **Screenshots are downscaled to the per-call pixel budget before upload.** The
  local path base64-inlined a full-resolution PNG for both passes; a dependency-free
  PNG resampler now fits each tile to its tier (triage ~1.0MP, deep ~3.1MP), and
  triage carries its own budget rather than the deep one. The captured file is
  untouched, so annotations still render at full resolution.

## [0.1.4] — 2026-08-24

**First npm-published release**: `@apatureai/verdict-types`,
`@apatureai/verdict-capture`, and `@apatureai/verdict-critique` are published to
the npm registry (with provenance) from this tag onward; earlier tags existed
only as git tags.

### Added

- **The measured half is now on the wire.** Contrast, overflow, and touch-target
  measurements — computed from the captured DOM with no model involved — used to
  ground the prompt and print in the terminal only. A consumer holding a result
  can now see every measurement the engine took, so "the model saw nothing" and
  "the injection landed" are no longer the same document.
- **Measurements carry a severity band.** Each measured fact now carries an
  ordinal `severity` (coarsened so ordinary re-measurement noise cannot move it),
  so a consumer diffing a PR against its base can tell a regression that got
  worse from one that was merely re-measured.

### Changed

- **Packages renamed to the `@apatureai/*` scope.** Every workspace package moved
  off the internal `@engine/*` scope onto `@apatureai/verdict-<name>` so the tree
  publishes under one org scope: `@engine/types` → `@apatureai/verdict-types`,
  `@engine/capture` → `@apatureai/verdict-capture`, `@engine/critique` →
  `@apatureai/verdict-critique` (the three publishable packages), and the private
  packages the same way. Nothing had been published yet, so no published names
  changed. Consumers vendoring the tree should update their `@engine/*` imports
  and `workspace:*` references to the new names.
- **Each deterministic check now answers three ways, not two:** it *declines*
  and emits nothing when the number is not computable from what was captured,
  *reports* without block-eligibility when the measurement is true but a capture
  gap leaves room to explain it away, and stands behind the rest. This removes a
  class of false advisories (e.g. a `<pre>` with a scrollbar reported as
  overflow).
- **A clip that lost content is distinguished from one the author chose.** The
  extractor now reports `text-overflow` and `white-space`; a real truncation
  affordance emits nothing, a clip with no affordance is reported as content loss
  with the properties the decision was made from.
- **`checksRun` reflects the checks a capture could actually run**, derived from
  the captured viewports (the touch-target check is scoped to touch viewports),
  instead of asserting all three kinds unconditionally. The demo CI job asserts a
  well-formed, non-zero measurement line instead of pinning an exact count.

### Fixed

- **Sub-pixel rounding allowance is pinned.** Chromium rounds `scrollWidth` to an
  integer while the box keeps its fraction; without the ceiling an ordinary flex
  row produced spurious "234px exceeds 234px" blocking findings.
- **Paint effects no longer produce false contrast blockers.** `mix-blend-mode`
  and partial opacity are effects a color walk cannot follow, so the contrast
  check now marks the backdrop unresolvable and declines rather than measuring
  against pixels the page never painted.

### Security

- **Grounding messages publish the path inside the repository under review, not
  the absolute path on the machine that ran the review** — the latter could leak
  an account name and directory layout into a pull-request comment on someone
  else's repository.

### Documentation, packaging, and examples (adoption prep)

- README quickstart transcript refreshed to include the `Design-system grounding`
  section (`no_genome_file`) and corrected to the current measurement count and
  test totals; a `CHANGELOG.md` link added.
- `@apatureai/verdict-types`, `@apatureai/verdict-capture`, and `@apatureai/verdict-critique` are prepared for npm
  publication (public `publishConfig` with provenance, `files`/`exports`,
  `repository`, per-package `README`/`LICENSE`, and a `prepublishOnly` build),
  with a [`release.yml`](.github/workflows/release.yml) that publishes them on a
  version tag. The maintainer must add the `NPM_TOKEN` secret and confirm the
  `@apatureai` scope before the first publish.
- Added `examples/measure-contrast.mjs`, a no-key runnable example of the
  deterministic measurement library, with an `examples/README.md`.
- Every `package.json` version aligned to `0.1.3` to match the latest tag.

## [0.1.3] — 2026-08-17

### Fixed

- **Bring-your-own-model requests now name the model to ask for.** Runs against
  OpenAI, Ollama, or a self-hosted vLLM used to fail with a model-not-found
  because the request hard-coded `qwen3-vl-flash` / `qwen3-vl-plus` (which exist
  only on DashScope). `TRIAGE_MODEL` and `DEEP_MODEL` now name the models, on
  the CLI and the local server, matching the deployable runtime.

### Changed

- **A green check can no longer mean nothing was verified.** A run where the
  grounding gate deleted every finding reports `gradeUnavailableReason`, so
  consumers withhold the grade instead of publishing Ship. Triage naming routes
  that match nothing captured no longer counts those routes as reviewed.
  `hallucinationDrops` is on the wire, so "the page is clean" and "three
  findings, none groundable" are distinguishable. The runtime path stamps
  judgment provenance, binds evidence URLs, and publishes a retention its own
  signatures honour.

### Added

- A caller can name the component libraries its repository uses, and request the
  repeat-capture determinism check, over the job API — both were CLI-only.

## [0.1.1] — 2026-08-16

### Added

- **Every result now states what it actually reviewed.** Each result carries a
  `coverage` block naming requested vs. reviewed routes and viewports (by
  identifier, not count), populated by the stage that knows what ran. The server
  refuses to publish a result that does not state coverage, so consumers can
  tell "we looked and it was clean" from "we did not look."
- **Routes dropped by the per-PR cap are now reported.** Each route discarded by
  `routes.max_per_pr` is named along with the setting and limit that dropped it,
  and coverage reports the configured route list as the ask. The serve-side
  projection no longer drops the "not reviewed" reasons.
- **The HTTP job API serves real reviews.** `POST /jobs` with an HMAC-signed
  body, then poll `GET /jobs/:id`; the completed result is a real grounded
  review from a real capture. An unknown id answers 404 instead of 500, and
  metadata reports the real engine version.

## [0.1.0] — 2026-08-10

First tagged release — a version you can pin. Not a 1.0; the API may still move.

### Added

- **Deterministic capture.** Headless Chromium at three viewports, pinned clock,
  frozen animations, font readiness, lazy-load scroll, no `networkidle`.
  `--verify-stability` re-screenshots each page and reports byte identity.
- **The grounding gate.** Every finding must carry a route and an `elementRef`
  that exist in the captured geometry map; findings that fail are deleted and
  the drops are counted and reported, not hidden.
- **Measurements taken from the page, not the model.** Contrast, horizontal
  overflow, and touch-target size computed from the captured DOM.
- **Repository context.** Design tokens, a `.designreview.yml` brand block, and
  detected component libraries become rubric addenda.
- **A streaming OpenAI-compatible model client**, verified against a local fake
  endpoint, with schema-constrained output and an instruction-hierarchy defense.
- **Calibration, agreement metrics, and a release-gate CLI** that promotes or
  blocks a candidate from a JSON artifact; numeric confidence is withheld until
  a promoted calibration report is bound.
- **`rust/capture-dedup`**, a dependency-free Rust crate for perceptual
  near-duplicate detection (dHash, DCT pHash, Hamming distance, SSIM, pixel
  diff) with golden vectors a TypeScript test mirrors byte for byte.
- **CI that checks the claims**: lint, typecheck, the full test suite, the
  README quickstart run for real against a headless Chromium, the release gate
  exercised on passing and regressed candidates, pytest for both Python
  packages, and the Rust crate.

[Unreleased]: https://github.com/apatureai/verdict/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/apatureai/verdict/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/apatureai/verdict/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/apatureai/verdict/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/apatureai/verdict/releases/tag/v0.1.0
