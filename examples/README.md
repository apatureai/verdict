# Examples

Runnable examples for the two ways to use verdict.

## `node demo.mjs` (repository root) — the CLI, end to end

The single most complete runnable example lives at the repository root:

```sh
node demo.mjs
```

It serves a bundled demo site, captures it with a real headless Chromium at
three viewports, runs the full pipeline, and writes real screenshots and a
review under `out/`. No API key, no account, nothing to configure — the critique
half replays a canned script and the report says so in place of a grade. It runs
in CI on every push, so it does not drift. See the [Quickstart](../README.md#quickstart).

## `examples/measure-contrast.mjs` — the library, no key

The deterministic measurement functions are pure and need no browser, no model,
and no API key. This example calls them directly on hand-written inputs so you
can see the shape of a measured finding:

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/measure-contrast.mjs
```

Expected output: one WCAG contrast ratio, then a single grounded `contrast`
finding for the low-contrast node (the compliant node produces none).

The example imports from the built workspace output
(`../packages/capture/dist/index.js`). The `@apatureai/verdict-*` packages are not yet on
npm — see [the release workflow](../.github/workflows/release.yml) and the
CHANGELOG for the publishing plan. Once they are published, the import becomes
`import { contrastRatio, contrastViolations } from "@apatureai/verdict-capture";` with
nothing else changed.
