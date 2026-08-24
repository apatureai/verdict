# @engine/critique

The critique pipeline of [verdict](https://github.com/apatureai/verdict): the
`critique()` entry point, the grounding / hallucination gate that deletes every
finding the model cannot point at a captured element, and an OpenAI-compatible
streaming model client.

```ts
import { critique, hallucinationGate, ENGINE_VERSION } from "@engine/critique";
```

The critique half needs a model you supply (any OpenAI-compatible endpoint that
accepts images); there is no default vendor. See the
[repository README](https://github.com/apatureai/verdict#readme) for wiring, the
grounding contract, and the bring-your-own-model instructions.

> Status: 0.1.x, API may still move. Requires Node >= 24. Depends on
> [`@engine/capture`](https://www.npmjs.com/package/@engine/capture) and
> [`@engine/types`](https://www.npmjs.com/package/@engine/types).
