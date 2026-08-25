Part of [verdict](../README.md). Moved from the README on 2026-08-24; anchors preserved.

### Using it as a library

```ts
import { createBrowserCapture, factsForRoute } from "@apatureai/verdict-capture";
import { launchChromiumCaptureBrowser } from "@apatureai/verdict-capture/playwright";
import { resolveModelRuntime } from "@apatureai/verdict-critique";
import { runReview } from "@apatureai/verdict-review";

const browser = await launchChromiumCaptureBrowser();
const capture = createBrowserCapture({ browser, sink: myObjectStore, keyPrefix: "captures" });
const model = resolveModelRuntime(process.env);   // mock unless MODEL_API_KEY is set
console.log(model.description);                    // say which client is live, always

const result = await runReview(
  { url, depth: "deep", context, captureContext, routes, wireOptions },
  { captureInSandbox: capture, modelFactory: model.factory },
);
```

`sink` is anything with `put(key, bytes)`; `InMemoryObjectStore` and `S3ObjectStore` from
`@apatureai/verdict-storage` both satisfy it.

Three packages — `@apatureai/verdict-types`, `@apatureai/verdict-capture` and `@apatureai/verdict-critique` — are prepared for npm
publication (public `publishConfig`, a `files`/`exports`/`prepublishOnly` build, and a
[`release.yml`](../.github/workflows/release.yml) that publishes on a version tag with provenance). They
are **not published yet**: the maintainer must add an `NPM_TOKEN` secret and confirm the `@apatureai`
scope first, so today the import path is still vendoring the tree and adding
`"@apatureai/verdict-capture": "workspace:*"` to the package that imports it. The snippet above also uses
`@apatureai/verdict-review` and `@apatureai/verdict-storage`, which remain `"private": true`. For a runnable, no-key taste
of the published surface without vendoring the whole tree, see
[`examples/measure-contrast.mjs`](../examples/). See [Status and roadmap](roadmap.md) for the
rest of the public-surface decision.
