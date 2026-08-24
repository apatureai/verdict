import type { ContextBlockInput, GenomeRule } from "@apatureai/verdict-context";

/**
 * Whether the repository's own design system reached the model, written into the
 * review itself.
 *
 * verdict's headline claim is that it critiques a rendered UI against the
 * repository's own design system. The part of that claim the deep prompt states
 * out loud is the "Design-system rules (UI-DNA; trusted)" block, filled by
 * retrieving the resolved genome's rules per route. A run with no genome emits
 * that block empty, and the prompt is then byte-identical to a run that never
 * had a design system at all. Nothing in the result said which of the two had
 * happened, so a review that was graded against the built-in rubric alone was
 * indistinguishable from one graded against an approved genome.
 *
 * That is the same class of problem `JudgmentProvenance` solves for "did
 * anything judge this page", and it is answered the same way: the fact travels
 * in the payload, as a `notReviewed` line with a stable greppable prefix, because
 * `review.json` and the body of `GET /jobs/:id` outlive the terminal that
 * printed a banner.
 *
 * The rule every producer here follows, the same one `provenance.ts` states: say
 * what this run actually knows and never more. In particular an ungrounded run
 * says the genome block was empty; it does NOT say the review was ungrounded
 * altogether, because the context block (design tokens, brand, component
 * libraries) and the measured deterministic facts are separate grounding that a
 * local run usually does have. Overstating the loss would be the same failure as
 * overstating the grounding.
 */

/** Why no design-system rule reached the prompt. */
export type UngroundedReason =
  /** The caller resolved no genome and said nothing about why. */
  | "no_genome_resolved"
  /** The caller looked for a genome snapshot and there was none. */
  | "no_genome_file"
  /** A snapshot was there and could not be trusted, so it was not used. */
  | "genome_unreadable"
  /** A snapshot resolved and carried no rules, so there was nothing to retrieve. */
  | "genome_has_no_rules";

/** A genome the caller resolved for this run, or the precise reason there is none. */
export type LocalGenome =
  | {
      available: true;
      /** The snapshot's own `dna_version`; stamped as the result's `uiDnaVersion`. */
      version: string;
      rules: GenomeRule[];
      /** Where it came from, for the report and the disclosure (a path or a URL). */
      source: string;
    }
  | {
      available: false;
      reason: Exclude<UngroundedReason, "no_genome_resolved">;
      /** One clause naming what was looked for and what was found instead. */
      detail: string;
    };

/** What a run's design-system grounding actually was. */
export type LocalGrounding =
  | {
      grounded: true;
      /** The genome version the critique was grounded on. */
      uiDnaVersion: string;
      /** Rules indexed for retrieval (the deep prompt receives the per-route top-k). */
      ruleCount: number;
      source: string;
      /** Which embedding function ranked the retrieval. */
      embedder: string;
      /**
       * Always false on a local run: rechecking that a genome version is still
       * effective at publish needs the authority service, which is not reachable
       * from here. The result is made advisory through the engine's own
       * `enforceGroundingAuthority`, exactly as an unknown authority is treated
       * in the deployed path.
       */
      authorityChecked: false;
    }
  | {
      grounded: false;
      reason: UngroundedReason;
      /** The `notReviewed` line stamped on the result. */
      disclosure: string;
    };

/**
 * The prefix every "no design system grounded this" disclosure starts with.
 * Stable on purpose, like `NO_MODEL_DISCLOSURE_PREFIX`: it is what a consumer
 * greps for and what a delivery surface deduplicates on.
 */
export const UNGROUNDED_DISCLOSURE_PREFIX = "[verdict] no design-system rule grounded this review";

/** Count what the context block carried, which is grounding the genome block is not. */
export function contextGroundingParts(context: ContextBlockInput): string[] {
  const parts: string[] = [];
  const tokens = Object.keys(context.tokens).length;
  if (tokens > 0) parts.push(`${tokens} design token(s)`);
  if (context.brand !== null) parts.push("a brand block");
  if (context.componentLibraries.length > 0) {
    parts.push(`${context.componentLibraries.length} detected component librar(ies)`);
  }
  return parts;
}

/**
 * The disclosure itself. Two shapes, because the two cases are genuinely
 * different for a reader: a repository that states a design system the review
 * partly used, and a repository that states none at all.
 */
export function ungroundedDisclosure(
  reason: UngroundedReason,
  detail: string,
  context: ContextBlockInput,
): string {
  const parts = contextGroundingParts(context);
  const rest =
    parts.length > 0
      ? `The critique was still grounded on what this repository does state about its design (${parts.join(
          ", ",
        )}) and on the measured facts, so it is a weaker review, not an empty one.`
      : "Nothing else carried this repository's design either: no design tokens, no brand block and " +
        "no component library were resolved. Beyond the measured facts, this critique was judged " +
        "against the built-in rubric alone.";
  return (
    `${UNGROUNDED_DISCLOSURE_PREFIX} (${reason}): ${detail}. ` +
    `No approved design-system rule was retrieved for any route. ${rest}`
  );
}

/** Resolve what happened, and the line to stamp when nothing did. */
export function resolveGrounding(
  genome: LocalGenome | undefined,
  context: ContextBlockInput,
  embedder: string,
): LocalGrounding {
  if (genome === undefined) {
    return {
      grounded: false,
      reason: "no_genome_resolved",
      disclosure: ungroundedDisclosure(
        "no_genome_resolved",
        "this run was given no UI-DNA genome to ground against",
        context,
      ),
    };
  }
  if (genome.available === false) {
    return {
      grounded: false,
      reason: genome.reason,
      disclosure: ungroundedDisclosure(genome.reason, genome.detail, context),
    };
  }
  // A resolved snapshot with no rules retrieves nothing, so it grounds nothing.
  // Reporting it as grounded because a version string existed is exactly the
  // silent overclaim this module exists to prevent.
  if (genome.rules.length === 0) {
    return {
      grounded: false,
      reason: "genome_has_no_rules",
      disclosure: ungroundedDisclosure(
        "genome_has_no_rules",
        `UI-DNA version ${genome.version} resolved from ${genome.source} and carried no rules`,
        context,
      ),
    };
  }
  return {
    grounded: true,
    uiDnaVersion: genome.version,
    ruleCount: genome.rules.length,
    source: genome.source,
    embedder,
    authorityChecked: false,
  };
}

/** Append a disclosure once, leaving an existing identical line alone. */
export function withDisclosure(notReviewed: readonly string[], line: string): string[] {
  return notReviewed.includes(line) ? [...notReviewed] : [...notReviewed, line];
}
