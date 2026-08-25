Part of [verdict](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Development

```sh
pnpm lint       # eslint, --max-warnings=0
pnpm typecheck  # tsc -b across the project references
pnpm build      # tsc -b, emits dist/
pnpm test       # tsc -b && vitest run  ->  1177 passed (132 files), 32s to 70s
```

One test file:

```sh
npx vitest run packages/capture/test/browser-capture.test.ts    # 19 passed
```

The non-TypeScript components:

```sh
cargo test --manifest-path rust/capture-dedup/Cargo.toml     # 20 passed

cd python/eval && uv venv && uv pip install -e '.[dev]' && uv run pytest               # 26 passed
cd python/preference-dataset && uv venv && uv pip install -e '.[dev]' && uv run pytest # 53 passed
```

`vitest.config.ts` aliases every package to its `src/index.ts`, so tests run against sources with no
build step.

**The one rule that matters: no test may call a live model, sandbox, browser, GPU or network.** Every
live I/O sits behind an injected seam; the browser tests drive a fake `CaptureBrowser`, and the model
tests drive a fake `fetch`. The real browser is exercised by the `quickstart` job in
`.github/workflows/ci.yml`, which runs `pnpm review` against a headless Chromium, asserts the
artifacts this README promises, and runs `scripts/ci/extractor-smoke.mjs`, which runs the in-page DOM
extractor against real pages and checks that the contrast facts a real Chromium produces are the true
ones. The `demo` job runs `node demo.mjs` from a bare checkout, with no pnpm action and no cache, so
the one command at the top of this README is verified the way a stranger runs it.

`.github/workflows/ci.yml` is the authoritative list of what is verified on every commit.
[CONTRIBUTING.md](../CONTRIBUTING.md) has the conventions.

## Regenerating the README hero

The README hero (`docs/assets/hero.png`) is a screenshot of the real demo report dropped into the
shared terminal frame — never edited output. To regenerate it after a change to the report format:

```sh
pnpm build
node packages/cli/dist/main.js          # writes out/report.txt (the real run)
cp out/report.txt docs/assets/hero-transcript.txt
```

Then render `docs/assets/terminal-frame.html` with the transcript dropped into its `<pre>`, open it
with the repo's headless Chromium (`pnpm browser:install` provides one) at width 1520, and screenshot
the `.frame` element at deviceScaleFactor 2 to `docs/assets/hero.png`. Commit the transcript beside
the image so the picture stays diffable against a re-run.
