# Contributing

Contributions are welcome. Small ones especially: a typo, a dead link, a failing case you can
reproduce. The [roadmap in README.md](README.md#status-and-roadmap) is the list of gaps most worth
picking up, each written so you can tell what you would be signing up for before you start.

If you are planning something larger (a new package, a changed wire contract, a new capture stage),
open an issue first so we can agree on the shape. That is a conversation, not a gate.

## Setting up

**Toolchain.** Node 24 (`.node-version`; `engines` pins `>=24`) and pnpm 9.15.0 (declared in
`packageManager`, so `corepack enable` gets you the right one). Add a stable Rust toolchain and
[uv](https://docs.astral.sh/uv/) only if you touch `rust/` or `python/`.

`node demo.mjs` does the install, the build and the browser download in one go and finishes with a
real review, which is the fastest way to confirm your machine is set up before you change anything.
The individual commands:

```sh
corepack enable
pnpm install --frozen-lockfile

pnpm lint       # eslint; --max-warnings=0, so warnings fail
pnpm typecheck  # tsc -b across the project references
pnpm build      # tsc -b, emits dist/
pnpm test       # tsc -b && vitest run
```

One test file at a time:

```sh
npx vitest run packages/capture/test/browser-capture.test.ts
```

The CLI needs a Chromium binary as well:

```sh
pnpm browser:install   # playwright-core install chromium, ~275 MB downloaded
pnpm review            # captures the bundled demo site, writes out/
```

Rust, in `rust/capture-dedup`: perceptual near-duplicate detection, std-only with no dependencies.

```sh
cargo test   --manifest-path rust/capture-dedup/Cargo.toml
cargo clippy --manifest-path rust/capture-dedup/Cargo.toml --all-targets -- -D warnings
cargo fmt    --manifest-path rust/capture-dedup/Cargo.toml --check
```

Python: `python/eval` and `python/preference-dataset` are two independent uv projects, and neither is
part of the pnpm workspace.

```sh
cd python/eval            # then repeat for python/preference-dataset
uv venv
uv pip install -e '.[dev]'
uv run pytest
```

Last full run on 2026-08-09, macOS 15.6, Node 24.14.0, pnpm 9.15.0: lint clean, typecheck clean, 739
vitest tests across 112 files passing in 48s to 70s, 20 Rust tests passing, clippy and `cargo fmt --check`
clean, 26 + 53 pytest tests passing, and `pnpm review` producing 3 findings with 2 gate drops. The
`container` job in `.github/workflows/ci.yml` needs a live Postgres service; the image itself builds
locally with `docker build`.

## Conventions that will trip you up

- **TypeScript project references.** `packages/*` are `@apatureai/verdict-*` workspace packages wired together
  with `tsc -b` project references. A new cross-package dependency needs three things: the
  `dependencies` entry (`"@apatureai/verdict-foo": "workspace:*"`), the `references` entry in the importing
  package's `tsconfig.json`, and the alias already handled generically by `vitest.config.ts`. If
  `tsc -b` complains about a missing reference, that is why.
- **ESM with explicit extensions.** The workspace is `"type": "module"`. Relative imports inside a
  package must carry the `.js` extension even though the source is `.ts`, because
  `packages/runtime/test/runtime.test.ts` loads the emitted `dist/` graph under native Node ESM
  resolution. That is also why `pnpm test` runs `tsc -b` first.
- **Tests run against sources.** `vitest.config.ts` aliases every package to its `src/index.ts`, so
  most tests need no build step. The runtime test above is the exception.
- **Injected seams, not module mocks.** Every live I/O has a port: the capture worker is driven
  through the `CaptureBrowser` interface, the model adapter through a client factory, the orchestrator
  through injected dependencies. Add a seam rather than reaching for a module mock.
- **The wire contract has a golden fixture.** `packages/types` owns the consumer contract; changing
  its shape means changing the golden fixture, and that is a deliberate speed bump.
- **A run no model saw never prints a grade.** `packages/cli/src/report.ts` is keyed on
  `ReportModelKind`, and under the canned or mock client it prints `grade n/a`, labels the replayed
  critique as fixture text, and gives the numbered list to the measured facts instead. A reader who
  sees a grade must be able to conclude a model produced it. The `quickstart` job in
  `.github/workflows/ci.yml` fails the build if a canned run prints one.
- **The README image is generated, never drawn.** `docs/report.png` is typeset from `docs/report.txt`,
  which is captured stdout. If you change what the CLI prints, regenerate both and update the
  README's console blocks in the same pull request:

  ```sh
  { echo '$ node packages/cli/dist/main.js'; node packages/cli/dist/main.js; } > docs/report.txt
  node scripts/render-report-image.mjs docs/report.txt docs/report.png
  ```
- **No em dashes in prose,** and no AI attribution in commits or documentation.

## The one rule that is absolute

**No test may call a live model, sandbox, browser, GPU, or network.** Every live I/O in this codebase
sits behind an injected seam: the capture worker is tested against a fake page, the model adapter
against a fake `fetch`, the orchestrator against stubs. That is what keeps the suite deterministic
and CI-runnable in about a minute. A change that reaches the network from a test is broken by
construction, whatever else it does.

The real browser is exercised outside the test suite, by the `quickstart` job in
`.github/workflows/ci.yml`, which runs `pnpm review` against headless Chromium, asserts the artifacts
the README promises, and runs `scripts/ci/extractor-smoke.mjs`, which drives the in-page DOM extractor
against real pages and checks that the deterministic contrast facts a real Chromium yields are the
true ones. Add a case there when you touch `DOM_EXTRACT_EXPRESSION`: a fake page cannot tell you what
`getComputedStyle` actually returns.

The `demo` job in the same workflow runs `node demo.mjs` from a bare checkout, with no pnpm action
and no cache, because the claim that command makes is that nothing has to be installed first. Its
pure helpers are unit-tested in `packages/cli/test/demo-script.test.ts`, but the command as a whole
is proven only by that job, so change either one with the other in mind.

## What makes a good pull request

- One concern per pull request. A refactor bundled with a behaviour change is hard to review and
  harder to revert.
- A test that fails before your change and passes after. For a bug fix, write that test first.
- `pnpm lint && pnpm typecheck && pnpm test` green locally before you push. CI runs the same
  commands plus the quickstart, release-gate, python, rust and container jobs.
- Documentation that stays true. If a change closes a roadmap item in `README.md`, move it out of the
  roadmap in the same pull request. If it adds a limitation, say so; understated capability is fine,
  overstated capability is not.
- Commit messages in the imperative mood, explaining why rather than restating the diff.

Especially wanted right now: the roadmap items in `README.md`, real-world reports from running the
CLI against sites that are not the demo (the DOM extractor meets a lot of CSS in the wild), and
anything that makes the first five minutes with this repository shorter.

## How review works

Pull requests are read and answered. Expect a first response within about a week; expect questions
about the boundaries rather than about style, since lint owns style. Changes to the wire contract,
the capture lifecycle ordering, and the grounding gate get the most scrutiny, because everything else
depends on them being right.

If a pull request goes quiet, a nudge on the thread is welcome and not an imposition.

## Getting oriented

`README.md` is the documentation: what the engine is, how a review flows, the `packages/*` map, the
configuration table, how review quality is measured, and the status and roadmap table. Read
`packages/review/src/orchestrator.ts` next; it is the only place the pipeline stages are sequenced,
so it is the fastest map of the whole system.

Before you point any of this at real infrastructure, read `SECURITY.md`.
