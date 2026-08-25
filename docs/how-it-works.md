Part of [verdict](../README.md). Moved from the README on 2026-08-24; anchors preserved.

### The release gate

Model and prompt promotion is gated on a quality bar, and the gate is a CLI over a JSON artifact:

```console
$ node packages/eval/dist/release-gate-cli.js packages/eval/fixtures/release/regressed.blocked.json
{
  "schemaVersion": "1",
  "promote": false,
  "mode": "advisory",
  ...
}
BLOCKED:
  - quality: blocker recall 0.620 < 0.85
```

Exit 0 means promotable, 1 means blocked with reasons, 2 means a malformed artifact. CI runs it in
both directions on every commit: a passing candidate must promote, a deliberately regressed one must
be blocked.

## How it works

```
repo design context ──┐
                      ├─► capture ──► triage ──(confirmed unchanged)──► "no design changes"
preview URL ──────────┘      │
                             └──(suspect routes)──► deep grounded pass
                                                          │
                                                          ▼
                                                   validation tail:
                                                   drop-and-count gate
                                                 → calibration transform
                                                 → instability ceiling + post-filter
                                                 → blocking threshold
                                                 → grade reconciliation
                                                 → version stamp
                                                          │
                                                          ▼
                                                    wire projection
```

`runReview` in `packages/review/src/orchestrator.ts` is the only place these stages are sequenced.
Every live I/O (capture, the model client factory, the embedder) is injected, which is why the whole
pipeline runs deterministically in tests against fakes.

**Grounding means two specific things.** First, the critique is judged against the repo's own design
system: `@apatureai/verdict-context` extracts design tokens (a `tokens.json`, CSS custom properties, or a
resolved Tailwind v3/v4 config), detects component libraries, maps a diff to affected routes, and
serializes all of it into one context block whose bytes are stable, so prefix caching on the model
endpoint actually hits. Second, every finding must carry a physical address: the `route` it was found
on and an `elementRef` present in the DOM geometry map captured alongside the screenshot.

**Triage before depth.** A cheap first pass short-circuits routes *confirmed* unchanged against a
baseline. A perceptual-hash match alone is not enough (pHash is blind to small localized changes), so
it must be confirmed by an SSIM/pixel-diff tile score. A pHash match without that confirmation fails
open to a full review.

### How review quality is measured

Promotion is gated on a frozen, content-addressed capture set and a human-labeled golden set
(150 PRs, multiple senior raters; consensus truth is a finding at least two raters independently
reported). Findings match on `dimension + route + elementRef`, so a finding counts only if it names
the same issue on the same element a human did. Every metric is a named function in
`packages/eval/src/metrics.ts`, so the score is deterministic given the same inputs. There is no
hidden judge model in the scorer.

| Bar | Threshold | Why |
| --- | --- | --- |
| Canary recall | >= 0.99 | Programmatically injected defects are unambiguous. |
| Blocker recall | >= 0.85 | The headline safety metric; a missed blocker is the worst outcome. |
| Nit precision | >= 0.75 | Low nit precision trains authors to ignore the bot. |
| Quadratic-weighted kappa | >= 0.60 | Substantial agreement with human graders on ship/block. |
| Injection resistance | = 1.0 | Screenshots are attacker-controlled; one success is a security failure. |

These are the literal `DEFAULT_QUALITY_BARS` in `packages/eval/src/quality-gate.ts`. **No results
table is published here, because no candidate has been promoted yet.** Producing the first one is a
roadmap item.

## Repository map

What each package owns. This is ownership, not proof that each one sits on a live path; the
[status table](roadmap.md) says which are wired.

| Package | What it owns |
| --- | --- |
| `packages/types` | The `critique()` / `captureInSandbox()` interfaces, `Finding` / `Critique`, and the consumer wire contract + golden fixture. |
| `packages/capture` | The capture worker: browser port, deterministic lifecycle, DOM extraction, geometry map, contrast/overflow/touch-target checks, downscale + coordinate rescale, tiling, stability gate, change detection, egress policy, font and clock policy. |
| `packages/critique` | Model adapter (streaming OpenAI-compatible, mock, canned replay), triage + deep passes, the system prompt and rubric, Zod output schema, hallucination gate, confidence ceiling, post-filter, grade reconciliation, version stamp, wire projection. |
| `packages/context` | Design-token extraction (tokens.json / CSS vars / Tailwind v3+v4), brand block, component-library detection, diff-to-route mapping, the byte-stable context block, UI-DNA retrieval. |
| `packages/review` | `runReview`, the end-to-end orchestrator, plus the job-processor adapter. |
| `packages/cli` | The `judgment-engine` CLI, the bundled demo site and the canned script. |
| `packages/eval` | Quality harness: canaries, golden-set tooling, calibration report/map/threshold artifacts, precision/recall and agreement metrics, regression and quality gates, model/prompt registry, SLOs, shadow promotion. |
| `packages/feedback` | Explicit / implicit / in-loop-recheck feedback, rater-permission weighting, per-repo memory digest, PII scan + training consent, preference-dataset export, GDPR erasure. |
| `packages/evidence` | Signed `DerivedEvidenceBundleV1` production (RFC 8785 canonicalization, injected Ed25519 signer port, request binding, trust decisions). |
| `packages/api` | The async job API (`POST` / `GET` / `DELETE /jobs`), HMAC verification, idempotency-digest conflict handling, depth-to-model routing. |
| `packages/jobs` | Postgres job store (`pg_notify` dispatch, idempotency, `SKIP LOCKED` claim), cancellation coordinator, priority. |
| `packages/db` | Deterministic up/down migration runner and `migrate` CLI (Postgres, or PGlite for tests). |
| `packages/redis` | Global model-endpoint token bucket, per-tenant quota, fairness gate, no-eviction guard. |
| `packages/storage` | `ObjectStore` interface, in-memory / S3 / dual-write adapters, object-key scheme, signed URLs, retention sweep. |
| `packages/secrets` | KMS key provider, per-repo data-key envelope, secret store, log and trace redaction. |
| `packages/observability` | OpenTelemetry span taxonomy, trace-context propagation through the job payload, SLO metrics. |
| `packages/runtime` | Production composition: Node HTTP adapter, config validation, real model/capture/genome adapters, Postgres `LISTEN` worker, health checks, drain and shutdown. |

| Elsewhere | |
| --- | --- |
| `demo.mjs` | The one-command entry point: prerequisite check, install, build, browser, then a real review of the bundled demo site. Plain dependency-free JavaScript, because it has to run before anything is installed. |
| `rust/capture-dedup` | dHash / DCT pHash / Hamming, SSIM and anti-aliasing-aware pixel diff. Integer math where it matters, with a golden vector file mirrored byte for byte by a TypeScript test so both languages agree. `#![forbid(unsafe_code)]`, no RNG, no I/O. |
| `python/eval` | Offline batch grader: recorded judge outputs + human-labeled golden set to scorecard. Pure, no GPU, no network. |
| `python/preference-dataset` | Turns exported revealed-preference verdicts into KTO/SFT JSONL plus a dataset card. |
| `contracts/`, `observability/` | Cross-repo JSON contract, Grafana dashboard and alert rules. |
