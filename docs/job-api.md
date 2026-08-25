Part of [verdict](../README.md). Moved from the README on 2026-08-24; anchors preserved.

### The async job API

The long-running service is a different shape from the CLI. Consumers do not call a blocking
function: they `POST /jobs` with an HMAC signature, an idempotency key and a depth, then poll
`GET /jobs/:id`. `DELETE /jobs/:id` marks the job `cancelling` immediately and cooperatively tears
down the in-flight work. Jobs live in Postgres (`pg_notify` wakeups,
`SELECT ... FOR UPDATE SKIP LOCKED` claims) and results live in object storage. Every result carries
an `x-schema-version` header and a `{engineVersion, model, promptVersion, captureVersion}` stamp.

Every result also states, in the payload, **whether anything judged the page and what it judged**. A
wire result always carries a `grade`, and a result with no surviving findings grades `ship`, so an
empty capture and a genuinely clean page are otherwise identical documents. `provenance` answers the
first half (`model_backed`, `source`, `engine`, `model`, `detail`); `coverage` answers the second
(`routesRequested`, `routesReviewed`, `viewportsRequested`, `viewportsReviewed`), populated from what
the pipeline actually did rather than from what it was configured to do. An empty `routesReviewed` is
this engine saying its own grade describes nothing, and the server refuses to publish a result
carrying neither stamp. Both fields are additive and optional on schema v1, so an older consumer
still parses a result that has them, and a consumer that reads a missing `coverage` must read it as
"not stated", never as "everything was reviewed".

Two more fields keep the raw document honest for somebody reading it directly rather than through a
consumer that knows to check `coverage` first. `gradeUnavailableReason` is the grade's retraction: it
means the `grade` beside it is the value a review with no findings defaults to, not a verdict about
the page. The `grade` field itself is unchanged, because it is a required closed enum in the
cross-repo contract and a consumer's parser blocks publication on anything else, so the retraction
travels beside it rather than inside it. `ungroundedNarrative` holds the model's own prose in the two
states where that prose is not a description of the page: every finding it was written about was
deleted by the grounding gate, or nothing was reviewed at all. In both cases `overall` states what
actually happened, and the model's paragraph is preserved rather than deleted, because what the model
claimed is worth reading. It just must not be mistaken for a conclusion.

Those two fields fire on the same two runs, and for a while only one of them knew it.
`gradeUnavailableReason` was emitted from `coverage` alone, so it caught the run that judged no route
(`nothing_reviewed`) and missed the run that judged a route and then deleted everything it found
there. On that second run coverage is full and truthful, `findings` is empty because deletion emptied
it, and `grade` floors to `ship`. The prose said so and the verdict field said the opposite. It now
carries `nothing_survived_validation`, decided from how many findings ENTERED validation rather than
from how many came out, so a page nobody found anything wrong with keeps the `ship` it earned and a
run where one of three findings survived keeps the verdict those survivors support. A consumer that
reads `grade` must check this field, exactly as a consumer that reads `confidence` must check
`calibration`, and must treat a value it does not recognize the same way: the enum is open to new
reasons and every reason means the same thing about the grade.

The measured half of a review travels with the result too, in `measurements`. The engine computes
text contrast against WCAG AA, horizontal overflow and touch-target sizes from the captured DOM with
no model involved, hands those sentences to the judge as facts it is told to trust, and prints them
in the terminal report. Until now that was where they stopped: nothing on the wire carried one, so a
consumer holding a result could not see a single measurement the engine had taken. `measurements` is
`{ checksRun, violations }`, where each violation names its kind, route, element, the viewports it
was measured at, the engine's sentence verbatim, `blockEligible`, and `severity`. `checksRun` is what
makes an empty `violations` mean anything: empty `checksRun` is "nothing was measured", and a
non-empty one with no violations is the positive statement "these checks ran and found nothing". The
field being ABSENT means this producer does not report measurements, and never means the page is
clean.

`severity` is the engine's BAND: an ordinal, higher is worse, and nothing else. It exists because a
consumer comparing a pull request against its base commit holds sentences, not numbers, and a
sentence cannot tell a violation that got worse from one that was merely re-measured. Take an element
from `2.91:1` to `1.02:1` and the words barely move; the band moves from 2 to 3. The bands are coarse
on purpose, so that ordinary re-measurement noise cannot move one.

They are coarse in both directions, and the second one is worth saying out loud: a band is a range,
so a change WITHIN one is invisible here. `3.00:1` down to `1.51:1` is band 2 at both ends, and so is
23px down to 10px. A consumer comparing bands sees nothing, which is the price of a signal that does
not fire on a re-render.

The landmarks are the engine's, and they are not arbitrary. Contrast bands against the WCAG lines:
at or above `3.0:1` is 1, which is the AA bar for large text and the lowest ratio any level-AA
criterion accepts; at or above `1.5:1` is 2; below that is 3, where the glyphs and their backdrop
are close enough in luminance that the text is discovered rather than read. A pointer target bands
on its smallest dimension: at least 24px is 1, which is SC 2.5.8 (AA) where 44px is SC 2.5.5 (AAA);
at least 10px is 2; under that is 3, which is not a control a finger can be aimed at. An overflow
bands on how much of the VIEWPORT the excess spills, because 40px off a 390px phone and 40px off a
1440px desktop are not the same event: up to a tenth is 1, up to a half is 2, more is 3.

A band is comparable only WITHIN a kind, and only as an order. It is not a magnitude and it is not
`findings[].severity`, which is a model's judgment on a closed enum that feeds the grade; this one is
arithmetic the check did on its own number and it feeds nothing. Never sum one, average one, scale
one, or compare a contrast band against a touch-target band. A group of measurements, which is one
row across several viewports, carries its WORST member's band: a row is fixed once, and a row
reporting the mildest of its viewports would hide a real worsening at one width. That is the opposite
rule to `blockEligible`, which takes the most cautious member, and the two ask different questions:
"how bad does this get" against "may this fail a build".

The field is optional and ABSENT means unknown, the same rule `blockEligible` follows for the same
reason. A capture fleet older than the field sends nothing, a check that cannot compute a band emits
nothing, and a group no member of which carried one keeps the field absent rather than gaining a
floor. Zero is a band; absent is not a band, and a consumer must never read one as the other or an
unknown would end up gating a merge.

`blockEligible` is the engine's claim that a measurement is precise enough for a consumer to gate a
merge on. It is the second of three answers a check can give, and the first one matters more.

A check DECLINES when the number is not computable from what was captured, and then no measurement
is emitted at all. Contrast over a photograph or a `backdrop-filter` is declined, because a flattened
background *colour* cannot see either one and white text on a dusk sky over a white page flattens to
`1.00:1`, which is not an imprecise number but a false one. The exception is a `background-image`
that states its own colours: a `linear-gradient(#1b3a6b, #eaf2ff)` is resolved to one backdrop per
stop and measured against the worst of them, and it is declined again the moment a stop is a colour
this engine does not parse, a second image is painted over it, or a filter is in the way. An element
whose computed
`overflow-x` is `auto`, `scroll` or `overlay` is declined, and so is one inside an ancestor that
scrolls: a `<pre>` with a scrollbar and a wide row inside a `.table-wrap` have content wider than
their box on purpose and forever, and `overflow` is the one kind that overrules a triage pass. A
clipped element is declined too when the clip is a deliberate truncation, which is `text-overflow`
set to something other than `clip` on content that cannot wrap: the card title cut at 220px with an
ellipsis sitting at the cut was cut on purpose, and the reader can see that it was. A
pointer target is measured only on a touch viewport, and only after the exceptions the criterion
itself carries: a link inside a sentence (Inline), and an undersized control with a clear 24px circle
around it (Spacing). Citing a success criterion while ignoring its exceptions is citing it
incorrectly.

A check REPORTS with `blockEligible: false` when the measurement is true but something the capture
could not evaluate leaves room to explain it away, which is mostly deploy skew: a capture fleet that
predates a field sends nothing, and unknown never means "no". A clip whose intent cannot be
established is reported and not gated, and the sentence says which shape it was: an ellipsis on
wrapping content, where whether a truncation mark is painted at all depends on what falls on the
overflowing line; a 1x1px box, which is the visually-hidden idiom for screen-reader-only text and
not a box anything is rendered in; and a capture too old to report `text-overflow`, where reading
that silence as the initial value `clip` would make every truncated card title a merge blocker.

Two more shapes are reported and never gated, and in both the sentence says so in its first word. A
ratio measured against the worst stop of a gradient is exact arithmetic about the ELEMENT and not
yet about the glyphs: the engine knows what the box paints and not where inside it the text landed,
so the worst stop may be off to one side of the line measured against it. And a pointer target
between the two criteria, at least 24x24 and under 44x44 on a touch viewport, clears the level AA
line the criterion actually states and misses the AAA one that exists because a 32px control is
mis-tapped on a phone: `advisory: touch target 32x32px meets the 24x24px minimum in WCAG 2.2 SC
2.5.8 Target Size (Minimum), level AA, and is below the 44x44px minimum in WCAG 2.2 SC 2.5.5 Target
Size (Enhanced), level AAA`. A repository that has committed to AAA asks for it, and then the same
target is measured as a failure of the criterion it chose and gates like one. A target the Spacing
exception already excused is not re-reported one tier down; that would take the exception back
through a side door.

What the engine will stand behind is the rest: an escape from every scroller, a clip that cut
content with no affordance to show for it, a ratio over a backdrop confirmed flat, an undersized
target on a touch viewport with no exception left to apply.
The emitted sentence names the criterion it applied, at the level it applied, so `20x20px is below
the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA` can be checked against the
spec. The engine owns precision; a consumer owns policy.

`measurements` never enters the grade. No measurement is converted into a finding, given a severity
or given a confidence, and `gradeFromFindings` and `reconcileGrade` are untouched by any of this: the
grade is still a pure function of the surviving model findings. The one field the measured half
touches is `gradeUnavailableReason`, and it withholds a grade rather than computing one.

That is the third retraction, `measured_facts_unjudged`, and unlike the other two it is a statement
about the JUDGE rather than about the pipeline. It fires when a run reviewed a route, the engine
measured at least one violation on a route it reviewed, and the model returned **zero** findings with
**zero** entering validation. A judge that is handed measured facts about a page it is looking at and
says nothing at all has not reviewed that page. One finding anywhere on the page, surviving or
deleted, suppresses it entirely: the rule is "did the judge speak", not "did the judge cover what was
measured", because a competent model that correctly declines to flag an intentional design choice on
a measured element has earned its grade. The predicate deliberately does not read `blockEligible`,
because the claim is "nothing judged this" rather than "your page is defective", and that claim stays
true whether or not the measured overflow turns out to be a deliberate scroll container. Nothing can
switch it off: no engine flag, no repository configuration. A key that could silence the one signal
an injected page cannot reach would itself be a second injection channel.

That extends to routes the engine drops before it ever captures them. `routes.max_per_pr` is a
per-PR cost ceiling and it stays one, but the routes over the limit are reported rather than
discarded: `routesRequested` is the configured list, not the capped one, and each dropped route gets
its own `notReviewed` line naming the setting and the limit, as
`route /legal (over the routes.max_per_pr limit of 5)`. Eight configured routes under the default cap
of five used to produce a review of five that read like a review of everything.

The request has additive fields of its own, for the two things the service cannot work out by
itself. It holds no checkout of your repository, so `componentLibraries` carries the library ids the
caller detected there (`shadcn/ui`, `radix`, `mui`, `chakra`, `mantine`) and this engine appends its
own rubric addendum for each, which is what the CLI does after reading your `package.json`. Ids
only: the rubric text is the engine's, so nothing a caller sends is written into the prompt
verbatim, and an id the engine has no addendum for is dropped rather than rejected. And
`config.verifyStability` asks for the repeat-capture determinism check on this review, the
per-request form of the CLI's `--verify-stability`; it reaches the capture fleet as
`context.verifyStability` and comes back as `pageHealth.stability`. Every one of these is optional
in both directions. An older caller omits them and is reviewed exactly as it was yesterday, and an
unknown additive field is ignored rather than refused, which is what lets a newer caller talk to an
older engine.

Idempotency is exact: `INSERT ... ON CONFLICT DO NOTHING` is the linearization point, and an existing
job is returned only when its persisted request digest matches. A reused key with a different request
is a non-enumerating `409` that does not leak the existing job id.

`packages/runtime/src/api-main.ts` is the deployable composition root (API plus one worker);
`worker-main.ts` is worker-only. Production startup has no mock fallback: it exits before listening
unless the full configuration is present. `GET /livez` reports process liveness; `GET /readyz`
reports database, capture fleet and worker capacity separately. Migrations run via `packages/db`'s
`migrate` CLI. The image builds with `docker build -t judgment-engine .`, and
`scripts/ci/container-smoke.sh` is the smoke test CI runs against it (it needs a reachable Postgres).
