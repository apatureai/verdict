import type { Finding, Viewport } from "@apatureai/verdict-types";

/**
 * Post-parse validation gate + hallucination metric (TRD §6.4, #32), the core
 * anti-hallucination mechanism and the thing the README's "deletes every finding
 * it cannot point at" claim rests on. `json_object` (#31) guarantees valid JSON,
 * not valid fields, so after parse we decide, per finding, whether the model can
 * actually point at what it claims.
 *
 * A finding points at a place — a `(route, viewport)` shot — and, optionally, at
 * an element within it (`elementRef`). The gate validates BOTH halves against
 * what was captured:
 *
 *   1. Clamp confidence into [0,1] (non-finite -> 0).
 *   2. DROP (and count as a hallucination) any finding whose `(route, viewport)`
 *      pair is not a captured shot. Validating the PAIR — not `route` and
 *      `viewport` independently — is load-bearing twice over: it is the check that
 *      closes the "finding claims a viewport the run never captured" hole (a
 *      finding claiming `desktop` on a mobile-only run cited a shot that does not
 *      exist), and it is what makes a surviving finding's annotated screenshot
 *      resolvable — every kept finding names a real `(route, viewport)` the
 *      capture produced an image for, so `screenshotIdForCapture` can never return
 *      null for one. A model-backed finding with `screenshotId: null` is therefore
 *      impossible by construction, not by a later assertion.
 *   3. DROP (and count) any finding whose non-null `elementRef` is not a key in
 *      the DOM geometry map (#18). When no geometry is supplied, this check is
 *      skipped (the element half is simply not verifiable on that path).
 *
 * The `elementRef: null` decision (#32 follow-up, W1-03). A null `elementRef` is
 * an honest "I see a problem here but cannot tie it to one element". Earlier it
 * fell through both element checks and joined the graded findings as if it were
 * fully grounded, which REWARDED vagueness: a null-ref finding graded `blocker`
 * outranked a specific finding that cited a real selector the geometry map merely
 * did not happen to carry. That is the opposite of what the gate is for.
 *
 * So null-ref findings are neither silently kept nor rejected. They are routed to
 * a separate `ungrounded` bucket (chosen over hard rejection because it preserves
 * honest reporting: a real-but-unlocatable issue is still worth showing). The
 * bucket is EXCLUDED from the grade, RANKED after every element-grounded finding,
 * and DISCLOSED in the narrative. A null-ref finding still had to clear check (2),
 * so it points at a real shot and carries a screenshot; it just does not drive the
 * verdict. It is NOT counted in `hallucinationDrops` — it was not a hallucination,
 * only an ungroundable observation.
 *
 * The drop count feeds eval and the gated SLO (#72) / Grafana (#9). Repair/re-ask
 * is deferred.
 */

/** A `(route, viewport)` shot the capture actually produced — the only place a finding may claim. */
export interface CapturedShot {
  route: string;
  viewport: Viewport;
}

export interface HallucinationGateInput {
  /**
   * The `(route, viewport)` shots that were actually captured (#62 diff->route +
   * capture). A finding whose pair is not in this set is dropped and counted.
   */
  capturedShots: Iterable<CapturedShot>;
  /** Valid `elementRef` selectors from the geometry map (#18). When omitted, elementRef is not checked. */
  geometrySelectors?: Iterable<string>;
}

export interface HallucinationGateResult {
  /**
   * Element-grounded findings: a captured shot exists AND either the `elementRef`
   * is a known geometry selector or no geometry was supplied to check it against.
   * These drive the grade and rank ahead of everything ungrounded.
   */
  findings: Finding[];
  /**
   * Findings kept but NOT tied to a specific element (`elementRef === null`) on a
   * captured shot. Honest but ungrounded: excluded from the grade, ranked after
   * every grounded finding, and disclosed in the narrative. They still point at a
   * real `(route, viewport)` shot, so they always resolve a screenshot.
   */
  ungrounded: Finding[];
  /** Count of findings dropped for an uncaptured `(route, viewport)` shot or an unknown `element_ref`. */
  hallucinationDrops: number;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalise a model-emitted `element_ref` into the citable selector(s) it means,
 * defending against two KNOWN rendering/compliance artefacts (F1) WITHOUT ever
 * loosening the gate into fuzzy matching — each candidate is still matched EXACTLY
 * against the geometry map:
 *
 *   1. A trailing parenthesised ROLE. The geometry block used to render
 *      `- #upgrade (button) box …` and instruct "cite element_ref EXACTLY as
 *      written", so the model cited `#upgrade (button)`. A trailing ` (role)` — a
 *      parenthesised group preceded by WHITESPACE — is stripped. The whitespace is
 *      load-bearing: it distinguishes the role suffix ` (link)` from a structural
 *      pseudo-class like `:nth-of-type(1)`, whose paren is NOT preceded by a space
 *      and is part of the selector. The parenthesised text must ALSO be a plausible
 *      ROLE TOKEN — a single word (`button`, `link`, `navigation`), not a phrase
 *      (G3b). An UNCONDITIONAL strip of any space-preceded trailing parenthesis let
 *      `#upgrade (which is really the nav bar)` normalise to `#upgrade` and be
 *      admitted as if the model had cited the real element; a role is never a
 *      multi-word phrase, so restricting the strip to a single `[A-Za-z][\w-]*`
 *      token keeps the real-artefact repair while refusing the smuggle.
 *   2. A COMMA-JOINED multi-selector citation. The model emitted
 *      `a:nth-of-type(1) (link), a:nth-of-type(2) (link)` for one finding. CSS
 *      selectors in the geometry map are single-element paths and never contain a
 *      comma, so a comma is always the model joining two refs; the citation is
 *      SPLIT into its parts, and the caller reports each part as its own finding
 *      (or drops the parts that do not resolve — each unresolved part counting as a
 *      hallucination, G3a). Splitting rather than rejecting preserves an honest,
 *      correctly-grounded finding.
 */
export function normalizeCitation(ref: string): string[] {
  const parts = ref.includes(",") ? ref.split(",") : [ref];
  return parts
    .map((p) => p.trim().replace(/\s+\([A-Za-z][\w-]*\)\s*$/, "").trim())
    .filter((p) => p.length > 0);
}

/**
 * Collision-free key for a `(route, viewport)` pair. JSON-encoding both halves
 * means no separator char can ever be confused for data: two distinct pairs
 * cannot produce the same string regardless of what a route contains.
 */
function shotKey(route: string, viewport: Viewport): string {
  return JSON.stringify([route, viewport]);
}

/** The outcome of resolving one normalised citation part against the geometry map. */
type SelectorResolution =
  | { ok: true; selector: string }
  | { ok: false; reason: "no_match" | "ambiguous_suffix" };

/**
 * Resolve one normalised citation part to a citable selector, matched EXACTLY or by
 * an UNAMBIGUOUS suffix (G3), never by fuzzy similarity:
 *
 *   1. an exact map key wins outright;
 *   2. otherwise, a UNIQUE key ending in `> <part>` (the selector combinator the
 *      geometry map renders) is accepted — the model wrote `h1` where the map key
 *      is `body > main > h1`, a correct, unambiguous reference the old exact-only
 *      match deleted;
 *   3. if TWO OR MORE keys share that suffix (`a` when both `nav > a` and
 *      `footer > a` exist), the reference is genuinely ambiguous and is REJECTED
 *      with `ambiguous_suffix` — the gate is not loosened, an ambiguous or
 *      fabricated ref still dies.
 *
 * Ambiguity for a POSITIONLESS part is counted across positional variants. The map
 * keys siblings by position, so `nav > a:nth-of-type(1)`, `nav > a:nth-of-type(2)`
 * and `footer > a` are three elements of the same kind; a bare `a` names the kind,
 * not one of them. Matching it on the literal string `> a` would find only the one
 * sibling that happens to be written without a position and silently bind a
 * nav-link claim to the footer link — a real element, so nothing fabricated
 * publishes, but the wrong one. Rejecting is the only honest answer.
 *
 * A fabricated ref that matches nothing exactly and has no suffix match returns
 * `no_match`, exactly as before.
 */
function resolveSelector(part: string, selectors: Set<string>): SelectorResolution {
  if (selectors.has(part)) return { ok: true, selector: part };
  // A part naming its position (`a:nth-of-type(1)`) is matched literally; a
  // positionless one is matched against each key's final segment with its own
  // position stripped, so siblings collide and the citation is rejected.
  const positionless = !part.includes(":");
  const suffix = ` > ${part}`;
  let match: string | null = null;
  let count = 0;
  for (const key of selectors) {
    const hit = positionless ? segmentKind(lastSegment(key)) === part : key.endsWith(suffix);
    if (hit) {
      match = key;
      count += 1;
      if (count > 1) break;
    }
  }
  if (count === 1 && match !== null) return { ok: true, selector: match };
  return { ok: false, reason: count > 1 ? "ambiguous_suffix" : "no_match" };
}

/** The final compound segment of a rendered path: `body > main > h1` → `h1`. */
function lastSegment(selector: string): string {
  const at = selector.lastIndexOf(" > ");
  return at === -1 ? selector : selector.slice(at + 3);
}

/** A segment without its positional pseudo-class: `a:nth-of-type(2)` → `a`. */
function segmentKind(segment: string): string {
  const at = segment.indexOf(":");
  return at === -1 ? segment : segment.slice(0, at);
}

export function hallucinationGate(
  findings: Finding[],
  input: HallucinationGateInput,
): HallucinationGateResult {
  const shots = new Set<string>();
  for (const shot of input.capturedShots) shots.add(shotKey(shot.route, shot.viewport));
  const selectors = input.geometrySelectors ? new Set(input.geometrySelectors) : null;

  const kept: Finding[] = [];
  const ungrounded: Finding[] = [];
  let hallucinationDrops = 0;

  for (const finding of findings) {
    // (2) the place half: the finding must point at a shot the capture produced.
    if (!shots.has(shotKey(finding.route, finding.viewport))) {
      hallucinationDrops++;
      continue;
    }
    const clamped = { ...finding, confidence: clampConfidence(finding.confidence) };
    // A null elementRef points at the shot but at no element: honest, ungrounded,
    // and kept out of the grade. Not a hallucination, so not counted.
    if (finding.elementRef === null) {
      ungrounded.push(clamped);
      continue;
    }
    // No geometry supplied ⇒ the element half is not verifiable on this path; the
    // finding is kept with its ref untouched (byte-identical to before).
    if (!selectors) {
      kept.push(clamped);
      continue;
    }
    // (3) the element half: the cited selector(s) must exist in the geometry map.
    // A known-artefact citation (trailing role, or a comma-joined pair) is
    // normalised to the selector(s) it means and each is resolved EXACTLY or by an
    // UNAMBIGUOUS suffix. A multi-selector citation SPLITS into one finding per
    // resolved selector, each pinned to its normalised selector so downstream
    // (duplicate-fact gate, wire) sees a real selector, never `#upgrade (button)`.
    //
    // EVERY normalised part that does NOT resolve is counted as a hallucination
    // drop (G3a): the historic filter published a comma pair's real half while its
    // fabricated half (`#upgrade, #ghost`) vanished WITHOUT incrementing the
    // counter, under-reporting the very number the product's credibility rests on.
    // A single-ref finding that fails still counts exactly once, unchanged.
    const parts = normalizeCitation(finding.elementRef);
    const resolved = new Set<string>();
    for (const part of parts) {
      const r = resolveSelector(part, selectors);
      if (r.ok) resolved.add(r.selector);
      else hallucinationDrops++;
    }
    if (resolved.size === 0) continue;
    for (const selector of resolved) kept.push({ ...clamped, elementRef: selector });
  }

  return { findings: kept, ungrounded, hallucinationDrops };
}
