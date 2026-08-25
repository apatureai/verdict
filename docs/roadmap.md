Part of [verdict](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Status and roadmap

### Working today

| Component | Notes |
| --- | --- |
| One-command first run | `node demo.mjs` installs, builds, gets a browser and reviews the bundled site from a clean clone. Run on every commit by the CI `demo` job. |
| Capture (Chromium) | `pnpm review` captures real pages. Covered by fake-browser unit tests plus the CI quickstart job. |
| Grounding + drop-and-count gate | Exercised end to end by the quickstart. |
| Deterministic checks | Contrast, overflow, touch target, computed from the captured DOM. The contrast check reports nothing it cannot measure exactly: text whose backdrop never resolves to an opaque, parseable color (a wide-gamut `oklch()` panel, the dark UA canvas) produces no fact rather than a guessed one. |
| Model client | Streaming OpenAI-compatible over `fetch`, verified against a local fake endpoint. |
| Eval / calibration / release gate | Pure, deterministic, well covered. |
| `rust/capture-dedup` | Cross-language golden vectors. |
| Async job API, job store, migrations | Implemented and tested against Postgres/PGlite. |

### Known limitations

The roadmap below is work that is absent. These are limits in the work that is present. Each one
behaves the way it was designed to behave, each one has already surprised somebody, and none of them
is closed by a patch to this repository alone. They are written down here so that nobody has to
rediscover them from a result that did not say what they expected.

- **A green tick can still sit over a measured violation.** The grade is a pure function of the
  surviving model findings, deliberately, and a measurement never votes. So a judge that returns one
  unrelated nit while saying nothing about a measured 3.23:1 contrast failure grades
  `ship_with_nits`, and a consumer maps that to a passing check with the violation printed
  underneath it. The `measured_facts_unjudged` retraction cannot catch that run, because the judge
  did speak. This is a chosen trade, not an oversight: closing it means asserting a severity for
  "3.23:1" that no threshold in WCAG supplies, and a floored grade is byte-indistinguishable from a
  review that found two real minor problems, which would destroy the exact contradiction that
  exposed the gap. It is counted instead, and a materially non-zero rate over real repositories is
  the evidence that flooring was the right call after all.
- **The retraction can only speak when something was measured.** On a page with no contrast,
  overflow or touch-target violation, a judge that returns nothing produces a clean-looking `ship`
  with nothing in the payload to contradict it. The measured channel is structurally incapable of
  covering that case, and nothing else in this repository covers it either.
- **The measured checks are unaudited on real repositories.** The corpora with known ground truth
  are a fixture site built to contain planted defects and the pages in
  `packages/capture/fixtures/pages`, each built around one shape a check has to get right (a
  scrollable `<pre>`, a small desktop control, white text on a photograph, a line clipped with no
  affordance beside one truncated with an ellipsis) with a genuine violation of the same kind beside
  it as a control. Those are real pages rendered in the real browser at two viewports each, and
  there are still only a handful of them. What remains unmeasured on a large legacy codebase is the
  *rate*.
- **The target-size check evaluates two of the criterion's exceptions, not all of them.** WCAG 2.2
  SC 2.5.8 also exempts a target with an equivalent full-size control elsewhere on the page, one
  whose presentation is user-agent controlled, and one whose size is essential. None of those is
  visible in a computed style or a rect, so none is evaluated, and an undersized target that meets
  one of them is reported as a failure. The Inline and Spacing exceptions are applied because they
  are computable, and a capture that did not report the inline flag is reported without being
  gateable rather than assumed.
- **Contrast declines more than it must.** Any `background-image` in the stack silences the check,
  including a `linear-gradient` whose endpoints a smarter implementation could sample, and including
  an image that is entirely behind an opaque layer. Sampling the rendered pixels under the glyphs
  would measure all of these; nothing here does that yet. Declining is the conservative direction:
  the failure mode is a violation nobody hears about rather than a number that is wrong.
- **A clip is read from `text-overflow` alone, which is the intent it can prove and not all of the
  intent there is.** `overflow-x: hidden` with content wider than the box is content loss when the
  cut carries no affordance, and a deliberate truncation when `text-overflow` paints a mark on
  content that cannot wrap. The first now gates; the second is silent. What sits between them is
  reported and not gated, and the sentence names which shape it was: an ellipsis on wrapping
  content, a 1x1px visually-hidden box, or a capture too old to report `text-overflow` at all. What
  the gate can still misread is an affordance that lives outside computed style: a clipped element
  whose excess is animated through the box, or reachable by a control beside it, or expanded by a
  "read more" toggle, is content loss as far as `text-overflow` is concerned and would gate. The
  fixture pages contain none of those, so this is a reasoned expectation and not a measured rate.
  The gate also reads only the element's OWN `overflow-x`: a clip an ancestor applies is a different
  measurement and is not decided here. Note also that `overflow` is the only member of
  `BREAKAGE_KINDS`, so what forces a deep model look stays deliberately wider than what may gate a
  merge, and a deliberate truncation no longer forces either: forcing a deep look is free, but on a
  fact the engine has decided is not a defect there is nothing to look at.
- **There is no baseline store, so nothing here is scoped to what a PR introduced.** Every
  measurement is of the page as it is now, not of what this change did to it. A repository that
  turns measurements into a merge blocker gets its pre-existing debt on the first run.
- **A deep prompt is only as grounded as the caller's request.** Two of the things a hosted review
  used to be missing are now fields on the job contract, and both are optional, so what you get
  depends on what the caller sends. `componentLibraries` is a list of ids the caller detected in the
  repository it is reviewing (`shadcn/ui`, `radix`, `mui`, `chakra`, `mantine`), which this engine
  turns into its own rubric addenda, the same ones the CLI appends after reading your
  `package.json`. A caller that sends none gets a review grounded on tokens and brand, exactly as
  before, and nothing in the result distinguishes "you use no component library" from "the caller
  did not look". The ids are a closed vocabulary (`COMPONENT_LIBRARY_IDS` in `packages/context`);
  an id this engine has no addendum for is dropped rather than rejected, so a newer caller cannot
  break an older engine. The rubric text is never accepted over the wire, only chosen by it.
- **The determinism check is opt-in, and a silent capture is not a verified one.**
  `verify_stability` on the job's config captures each page twice and compares the PNG bytes, and it
  reaches a capture fleet as `verifyStability` on the capture context. It is off unless something
  asks. So on a run that did not ask, `pageHealth.unstable` is `false` because nothing contradicted
  the capture, not because anything was compared, and the confidence ceiling for unstable captures
  cannot fire on a comparison that never happened. Read the counts, not the flag: a run that
  verified reports `pageHealth.stability` (`pagesCompared`, `unstablePages`) and says so in the
  page-health footnote; a run that did not omits the field entirely. The engine and the capture
  fleet also deploy separately, so a fleet that predates the field will ignore the ask and answer
  without counts. That is not reported as a passing check: the service logs that the review asked
  and nothing was verified, and the result claims nothing.
- **Nothing on any path has a baseline to compare this capture against.** `baselinePhash` and
  `tileScores` describe this capture against a previous one, and no composition here records a
  previous one, so both stay empty on the CLI, on the local HTTP server and on the deployed service.
  The consequence shows up in your results rather than in a log: the triage short-circuit that would
  skip the model call entirely for a confirmed-unchanged route is unreachable, and when the triage
  model answers that no deep review is needed, the run has nothing it declined against, so those
  routes come back marked not reviewed with a line saying the run carried no baseline for the route.
  That line is this limitation, not a fault in your page and not a failed review, and it will appear
  on every real triage decline until a baseline store exists. The store is a roadmap item below.
- **The publication guard on the HTTP server is a backstop, not the decision.** `assertAttested`
  refuses to serve a result that asserts a grade nothing earned, and one of its checks is a run
  whose findings were all deleted: an empty findings list beside a positive `hallucinationDrops`
  means findings existed and none of them are here. That check reaches only as far as a published
  payload can prove. When the confidence floor and the trust budget did the deleting instead, the
  run reports zero grounding drops, and the wire does not carry how many findings entered
  validation, so at that layer it is indistinguishable from a genuinely clean page. The case is not
  unhandled: it is decided one stage earlier, in the wire projection, from
  `validation.modelFindingsSeen`, which sees both. What that means for a reader is that
  `gradeUnavailableReason` on the result is the field to trust, and the server guard is the
  fail-closed net beneath it. If you build another front end on `packages/critique`, put the
  decision in the projection rather than in your own publisher, or you will inherit the narrower
  half.
- **A prompt change invalidates promoted calibration reports until they are re-derived.**
  `SYSTEM_PROMPT_VERSION` is bumped on any wording change to the system prompt, and the runtime
  binds a calibration report only when its identity matches, prompt version included. A report
  derived under `system-prompt@v3` is rejected against a `v4` engine as
  `mismatched_calibration_report`, confidence is withheld, and the result stays advisory rather than
  blocking. That is the version stamp working, and it means promoting a calibration report is not a
  one-time deployment step: every prompt edit, including the ones already shipped in this
  repository, needs an eval pass and a re-promotion before a numeric confidence is displayable again
  and before a blocking gate can block. Plan for that when you plan a prompt change. The alternative
  the check exists to prevent is a confidence number derived from a prompt nobody is running any
  more.

### Roadmap

Each of these is a real gap, stated so you know exactly what you are picking up. Contributions
welcome on any of them.

- **A recorded live-model fixture.** The shipped critique fixture
  (`packages/cli/fixtures/canned-critique.json`) is authored by hand, not recorded from a model. A
  captured real transcript, replayable offline, would make the default run representative instead of
  illustrative. Start at `packages/critique/src/model-runtime.ts`.
- **Published `@apatureai/verdict-*` packages.** The public surface is prepared but not yet published:
  `@apatureai/verdict-types`, `@apatureai/verdict-capture` and `@apatureai/verdict-critique` (the dependency closure of the two
  obvious first packages) carry publish config, a `prepublishOnly` build, and a
  [`release.yml`](../.github/workflows/release.yml) that publishes them on a version tag with
  provenance. Remaining maintainer work: add the `NPM_TOKEN` secret, confirm ownership of the
  `@apatureai` npm scope (the org's public scope), and decide whether to widen the surface past
  those three.
- **Enforce the egress policy at the network layer.** `packages/capture/src/egress.ts` holds the
  egress/SSRF rules, including cloud-metadata blocking, as pure functions. Nothing calls them on the
  live capture path, and capture runs Chromium in your own process. Wiring the policy into
  `captureWithBrowser` via a Playwright route interceptor is the tractable first step; container or
  microVM isolation is the larger one. Read [SECURITY.md](../SECURITY.md) first.
- **A capture service behind `CAPTURE_ENDPOINT`.** `HttpCaptureClient` in
  `packages/runtime/src/adapters.ts` is a complete client for a fleet that does not exist in this
  tree. The local path uses `createBrowserCapture` instead. Implementing the server side against that
  client's contract is a well-specified project. Note what that contract now includes: alongside the
  images, the geometry map and the page health, a capture service reports what it MEASURED
  (`deterministicFindings`) and the page's own visible text (`pageText`). Both are optional on the
  wire, and a service that omits the measurements produces reviews with no measured facts in the deep
  prompt and no measured breakage able to overrule a triage pass that declined to look; the service
  logs that gap per job rather than letting the absence read as a clean page. The request half has
  one addition too: `context.verifyStability` asks the fleet to capture each page twice and compare
  the bytes, and a fleet that implements it answers with `pageHealth.stability`
  (`pagesCompared`, `unstablePages`). Both halves are optional in both directions, so a fleet that
  ignores the ask still serves reviews; it just cannot claim the check passed, and the engine says
  so per job.
- **Wire rate limiting and fairness.** `packages/redis` implements the global token bucket, per-tenant
  quota, fairness gate and no-eviction guard, and is unit-tested, but no package imports it and
  `packages/runtime` never reads `REDIS_URL`. The service currently runs unthrottled. This is
  composition work in `packages/runtime`.
- **Wire the perceptual stability gate to live capture.** `--verify-stability` compares repeat PNG
  bytes, which is stricter than the designed pHash + tile-diff gate. The pHash path exists in
  `rust/capture-dedup` and `packages/capture/src/stability.ts` and is not connected to the live
  capture path.
- **A baseline store, so a review can compare against a previous run.** The triage pass can skip a
  deep review when a route's perceptual hash matches a recorded baseline and a tile-wise sensitive
  diff confirms the match. Both inputs, `baselinePhash` and `tileScores` on `ReviewRoute`, describe
  this capture against a previous one, and no shipped surface has a previous one: nothing in the CLI,
  the local HTTP server or the deployed service records a per-`(repo, route, viewport)` hash or tile
  score anywhere it can read back. Nothing invents one, so the consequences are exact rather than
  hidden, and they are the ones stated under [Known limitations](#known-limitations): the
  short-circuit is unreachable, and a triage decline has no baseline behind it. Closing this needs a
  store with a retention and invalidation policy, keyed by repo and
  route, plus the plumbing to populate the two fields from it. The measured-breakage half of triage
  needs no baseline and is wired: an overflow measured on this capture forces a deep review of that
  route whatever the triage model answered.
- **UI-DNA grounding (`GENOME_ENDPOINT`).** The retrieval client and the publication-authority
  recheck exist in `packages/context`; the peer embedding service is not in this repository. Without
  it, reviews run against tokens and brand only.
- **Run the self-hosted serving path against a GPU.** The single-call guided-decoding backend
  (`MODEL_BACKEND=self-host`) is code-complete behind the adapter and unit-tested, and has never been
  run against a real vLLM or SGLang server. A report of what breaks is a genuinely useful
  contribution.
- **Publish the first eval results.** The harness, bars and golden-set tooling are all here and no
  candidate has been promoted, so there is no scorecard to show. Running a model through
  `python/eval` and publishing the numbers would make the quality claims checkable.
- **Train the fine-tuned judge.** Preference-dataset export, consent/PII gating and shadow-promotion
  logic exist. There is no checkpoint.
- **Callers for `packages/evidence` and `packages/feedback`.** Both are implemented and unit-tested
  with no caller in this tree.
- **Deployment.** `Dockerfile` and `fly.toml` are real and the image is smoke-tested in CI. They are
  a starting point, not a hardened production configuration; review them before deploying.
- **Windows support.** Untested. CI covers Linux, development happens on macOS.

### Notes on provenance

Source files cite `TRD §…` and `#nnn` issue numbers from planning documents that are not part of
this repository, so those references will not resolve. The code they annotate does.

Parts of this codebase were built by an autonomous agent loop, which is why the source is unusually
heavy on doc comments explaining why a thing is the way it is. That is the loop's record, and it is
accurate.
