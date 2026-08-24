import type { ReviewInput } from "@apatureai/verdict-review";
import type { Capture, EngineReviewResult, Finding } from "@apatureai/verdict-types";

/**
 * The evidence half of a published review: the shot a finding points at, and a
 * URL a reader can open.
 *
 * `WireProjectionOptions` names both seams and says who fills them: "the
 * screenshot-id and artifact-URL resolution are injected (the worker binds them
 * to the captured-image set + the object-store signed-URL base); absent => no
 * annotated screenshot for that finding". The local pipeline binds both. This
 * composition, the worker that sentence is about, bound neither, so
 * `toReviewInput` handed the projection a bare
 * `wireOptions: { screenshotRetentionSeconds: 0 }` and every finding it
 * published carried `screenshotId: null` with an empty
 * `artifacts.annotatedScreenshots`, whatever the capture fleet had rendered.
 * Gate renders its evidence links from exactly those two fields, so a production
 * review arrived with nothing a reader could open.
 *
 * Both are bound here, and they are bound at different moments on purpose:
 *
 *   - The screenshot ID is the durable object key, resolved the instant the
 *     capture comes back, by the same (route, viewport) lookup `runLocalReview`
 *     uses. It is what the result stores.
 *   - The URL is minted at PUBLICATION, from the object store's signed-URL
 *     base. It cannot be bound as `artifactUrlFor` because that seam is
 *     synchronous and `ObjectStore.signedGetUrl` is not, and it should not be
 *     minted earlier even if it could: a URL signed before the deep pass would
 *     have spent most of its TTL waiting for a review that is allowed to take
 *     twelve minutes. So the projection carries the object key and publication
 *     replaces it with a URL.
 *
 * The one thing this assumes is that a capture's `objectKey` names an object in
 * the engine's own bucket. That assumption is not new and is not this module's:
 * `createOpenAIAdapters` already signs exactly these keys against exactly this
 * store to show the images to the model. If it were wrong, no review would ever
 * have reached a model at all.
 *
 * A signed URL in a published result is a deliberate, bounded exception to
 * `ObjectStore`'s "signed URLs are never persisted" rule, which exists so a
 * leaked durable record cannot be replayed into long-lived access. The result
 * document is itself tenant-scoped and served only over the HMAC-verified job
 * API, and the exception is bounded by the TTL: after it elapses the link is
 * dead and only the object key remains. That is the trade a reader is making,
 * so it is stated rather than left to be discovered.
 */

/**
 * Resolve a finding's annotated screenshot: the capture of the same route at
 * the same viewport, or null when the capture never produced one.
 *
 * Identical in rule and in order to `runLocalReview`'s binding, so the two
 * surfaces cannot disagree about which shot a finding points at. Null is a real
 * answer: a finding on a viewport the capture never produced has no shot to
 * point at, and inventing a neighbouring one would be evidence for a different
 * picture than the one the finding describes.
 */
export function screenshotIdForCapture(capture: Capture): (finding: Finding) => string | null {
  return (finding) =>
    capture.images.find(
      (image) => image.route === finding.route && image.viewport === finding.viewport,
    )?.objectKey ?? null;
}

/**
 * Bind the evidence seam onto the input the orchestrator is about to run.
 *
 * Mutates, for the same reason `applyMeasuredRoutes` does: `createReviewProcessor`
 * hands `runReview` the same `ReviewInput` object it handed this composition,
 * and the capture that answers the question does not exist when `toReviewInput`
 * builds the input.
 */
export function applyCaptureEvidence(input: ReviewInput, capture: Capture): void {
  input.wireOptions.screenshotIdFor = screenshotIdForCapture(capture);
}

/** Mints a signed, openable URL for a durable object key. */
export type EvidenceUrlSigner = (objectKey: string) => Promise<string>;

/**
 * Replace every artifact reference in a published result with a URL a reader
 * can open, resolved from the finding's own screenshot ID.
 *
 * Each distinct key is signed once, so a result whose findings share a shot
 * costs one signature rather than one per finding. A signer that throws is not
 * caught: the object store is the same dependency that has to accept the result
 * document moments later, so a failure here is a publication failure, and the
 * attempt failing (and being retried) is a better answer than a published
 * `url` that is not a URL.
 */
export async function signEvidenceUrls(
  result: EngineReviewResult,
  sign: EvidenceUrlSigner,
): Promise<EngineReviewResult> {
  const entries = result.artifacts.annotatedScreenshots;
  if (entries.length === 0) return result;

  const keyByFinding = new Map(result.findings.map((finding) => [finding.id, finding.screenshotId]));
  const signed = new Map<string, string>();
  const annotatedScreenshots: Array<{ findingId: string; url: string }> = [];
  for (const entry of entries) {
    const key = keyByFinding.get(entry.findingId) ?? null;
    if (key === null) {
      annotatedScreenshots.push(entry);
      continue;
    }
    let url = signed.get(key);
    if (url === undefined) {
      url = await sign(key);
      signed.set(key, url);
    }
    annotatedScreenshots.push({ findingId: entry.findingId, url });
  }
  return { ...result, artifacts: { ...result.artifacts, annotatedScreenshots } };
}

/** Refused publication: a finding cites evidence a reader could not open. */
export class UnresolvedEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvedEvidenceError";
  }
}

/**
 * Publication guard. A finding that names a screenshot must arrive with an
 * artifact entry, and that entry must be a URL rather than the object key it was
 * projected from.
 *
 * This is the fail-closed backstop for the two-step binding above: the
 * projection writes the durable key into `url`, and if the publication step that
 * is supposed to replace it is ever removed or short-circuited, the result would
 * publish `"url": "jobs/<id>/screenshots/home.png"`, which reads as evidence and
 * resolves to nothing. A finding whose `screenshotId` is null is untouched: no
 * shot exists, the result says so, and that is honest.
 */
export function assertEvidenceResolvable(result: EngineReviewResult): EngineReviewResult {
  const urlByFinding = new Map(
    result.artifacts.annotatedScreenshots.map((entry) => [entry.findingId, entry.url]),
  );
  for (const finding of result.findings) {
    if (finding.screenshotId === null) continue;
    const url = urlByFinding.get(finding.id);
    if (url === undefined) {
      throw new UnresolvedEvidenceError(
        `finding ${finding.id} cites a captured screenshot but the result carries no artifact reference for it`,
      );
    }
    if (!URL.canParse(url)) {
      throw new UnresolvedEvidenceError(
        `finding ${finding.id} carries an unresolvable artifact reference; a reader cannot open an object key`,
      );
    }
  }
  return result;
}
