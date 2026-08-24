# @engine/capture

The capture and measurement layer of [verdict](https://github.com/apatureai/verdict):
deterministic headless-Chromium capture, a DOM geometry map, and the
code-computed WCAG checks (contrast, horizontal overflow, touch-target size)
that a critique is grounded on.

The check functions are pure — no browser, no model, no API key — so they run
identically on captured data and in a unit test.

```ts
import { contrastRatio, contrastViolations } from "@engine/capture";

contrastRatio({ r: 138, g: 138, b: 138 }, { r: 255, g: 255, b: 255 }); // 3.45
```

See the [repository README](https://github.com/apatureai/verdict#readme) for the
full pipeline and a runnable example under
[`examples/`](https://github.com/apatureai/verdict/tree/main/examples).

> Status: 0.1.x, API may still move. Requires Node >= 24. The Playwright entry
> point (`@engine/capture/playwright`) additionally needs `playwright-core`'s
> Chromium; the pure check functions do not.
