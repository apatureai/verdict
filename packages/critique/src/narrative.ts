/**
 * Reconcile the model's narrative with the findings that actually survived
 * validation (#32/#33/#106).
 *
 * The model writes `overall` in the same breath as its findings, before the
 * grounding gate has deleted anything. The validation tail then deletes findings
 * and floors the grade to what is left, but until now it left the narrative
 * untouched, so a run whose every finding cited a route or element that was
 * never captured published `grade: ship`, `findings: []` and a paragraph reading
 * "the hero block is misaligned and the CTA is off-grid". Both halves of that
 * result came out of the same engine and they contradict each other, and the
 * half a human reads first is the prose.
 *
 * `hallucinationDrops` made the deletion COUNTABLE, which is not the same as
 * reconciled: a count in a sibling field does not stop a reader, or an agent,
 * from taking the paragraph at face value. So the narrative is settled here, at
 * the point where both the model's claim and the surviving evidence are known.
 *
 * Three cases, decided deliberately:
 *
 *   - Nothing was deleted: the narrative describes exactly the findings that
 *     shipped. It is returned untouched, so the overwhelming majority of results
 *     are byte-identical to before.
 *
 *   - EVERY finding was deleted: the narrative describes only findings that
 *     could not be pointed at, so it is not a description of the page and must
 *     not read as this run's conclusion. `overall` becomes a true statement of
 *     what happened, and the model's own words are preserved verbatim in
 *     `ungroundedNarrative`. Deleting them would be its own dishonesty: what the
 *     model claimed is the most useful thing this engine knows about its own
 *     judge, and it is what an operator needs to debug a bad prompt or a bad
 *     capture. The reader simply must not mistake it for a conclusion.
 *
 *   - SOME were deleted: the narrative may describe both the survivors and the
 *     deleted, and nothing in the payload says which sentence is which. Moving
 *     it wholesale would discard real description of a real page; leaving it
 *     bare would let deleted findings keep their prose. So it stays as the
 *     result's narrative with a caveat PREPENDED, naming the counts. Prepended,
 *     not appended, because consumers truncate this field for display (Gate caps
 *     it before rendering) and a caveat that can be truncated away is not a
 *     caveat.
 *
 * Pure and deterministic; the same counts and the same text always produce the
 * same bytes.
 */

export interface NarrativeReconciliationInput {
  /** The model's own summary, verbatim, exactly as it came out of the pass(es). */
  overall: string;
  /** Findings the model produced, counted BEFORE the validation tail ran. */
  modelFindingsSeen: number;
  /** Findings that survived the whole tail and are in the published result. */
  survivingFindings: number;
  /**
   * How many of the deleted findings the grounding gate deleted (#32). The rest
   * of the deleted total was removed by the confidence floor / trust budget
   * (#33), and the two are named separately because they mean different things:
   * one is a model that pointed at nothing, the other is a model the calibrated
   * budget did not trust enough to publish.
   */
  hallucinationDrops: number;
  /**
   * How many of the SURVIVING findings are ungrounded (W1-03): a real shot but no
   * element to point at, so they are ranked last and held out of the grade. They
   * are not deleted and so are not part of `modelFindingsSeen - survivingFindings`;
   * this count is disclosed on its own so a reader is told the grade was formed
   * without them. Defaults to 0.
   */
  ungroundedFindings?: number;
  /**
   * Surviving findings that made a claim no deterministic check had already
   * published (judge-unlock §4.4). When this is 0 and the model produced
   * findings, the run restated measurements instead of judging, and the narrative
   * says so in its first sentence — the "visibly unhelpful rather than invisibly
   * useless" property. Defaults to `survivingFindings` (i.e. no restatement gate).
   */
  netNewFindings?: number;
  /** Findings dropped as duplicates of a reported measurement (judge-unlock §4.4). */
  duplicateFactDrops?: number;
  /** Findings demoted for restating a reported measurement (judge-unlock §4.4). */
  restatedFindings?: number;
}

export interface ReconciledNarrative {
  /** The narrative the result publishes. */
  overall: string;
  /**
   * The model's summary, verbatim, when it is no longer this result's narrative.
   * Present ONLY when every finding it was written about was deleted, and only
   * when the model actually wrote one.
   */
  ungroundedNarrative?: string;
}

/** "3 for citing a route or element that was never captured, 2 as duplicates of a measurement, 1 by the trust budget". */
function deletionClause(hallucinationDrops: number, duplicates: number, filtered: number): string {
  const parts: string[] = [];
  if (hallucinationDrops > 0) {
    parts.push(
      `${hallucinationDrops} for citing a route or element that was never captured`,
    );
  }
  if (duplicates > 0) {
    parts.push(`${duplicates} for restating a measurement already reported`);
  }
  if (filtered > 0) {
    parts.push(`${filtered} by the confidence floor and trust budget`);
  }
  // All zero cannot reach here (the caller only calls with a positive deleted
  // count), but a total that is not attributable to any stage is still stated
  // rather than silently rounded into one of them.
  if (parts.length === 0) parts.push("by the validation tail");
  return parts.join(", ");
}

/** "1 finding could not be tied to a specific element, so it is listed last…". */
function ungroundedDisclosure(count: number): string {
  const noun = count === 1 ? "finding" : "findings";
  const pronoun = count === 1 ? "it is" : "they are";
  return (
    `${count} ${noun} in this result could not be tied to a specific element; ` +
    `${pronoun} listed last and excluded from the grade.`
  );
}

/** Append the ungrounded disclosure to a reconciled narrative's `overall` when there is one. */
function withUngroundedDisclosure(narrative: ReconciledNarrative, ungrounded: number): ReconciledNarrative {
  if (ungrounded <= 0) return narrative;
  const disclosure = ungroundedDisclosure(ungrounded);
  const overall = narrative.overall.trim().length === 0 ? disclosure : `${narrative.overall} ${disclosure}`;
  return { ...narrative, overall };
}

/**
 * Settle `overall` against what survived validation. See the module comment for
 * why each case is what it is.
 */
/**
 * Prepend the zero-net-new statement (judge-unlock §4.4) when the model produced
 * findings but none survived as a net-new judgment: they all restated
 * measurements the deterministic checker had already reported. Prepended, not
 * appended, for the same reason the deletion caveat is: consumers truncate this
 * field, and a statement that can be truncated away is no statement.
 */
function withRestatementDisclosure(
  narrative: ReconciledNarrative,
  input: NarrativeReconciliationInput,
): ReconciledNarrative {
  const seen = Math.max(0, input.modelFindingsSeen);
  const netNew = input.netNewFindings ?? Math.max(0, input.survivingFindings);
  const restated = Math.max(0, input.restatedFindings ?? 0);
  const dropped = Math.max(0, input.duplicateFactDrops ?? 0);
  // Only fires when the run PRODUCED findings, none were net-new, and restatement
  // (drop or demote) was the reason. A run that simply found nothing, or whose
  // findings were all hallucination-dropped, is explained by the other branches.
  if (seen === 0 || netNew > 0 || restated + dropped === 0) return narrative;
  const statement =
    `The judge produced ${seen} finding(s). All of them restated measurements the deterministic ` +
    `checker had already reported; none made a judgment the checker could not make. No net-new ` +
    `finding was produced for this route.`;
  const overall =
    narrative.overall.trim().length === 0 ? statement : `${statement} ${narrative.overall}`;
  return { ...narrative, overall };
}

export function reconcileNarrative(input: NarrativeReconciliationInput): ReconciledNarrative {
  const seen = Math.max(0, input.modelFindingsSeen);
  const surviving = Math.max(0, input.survivingFindings);
  const deleted = Math.max(0, seen - surviving);
  const ungrounded = Math.max(0, input.ungroundedFindings ?? 0);

  if (seen === 0 || deleted === 0) {
    return withRestatementDisclosure(
      withUngroundedDisclosure({ overall: input.overall }, ungrounded),
      input,
    );
  }

  const drops = Math.max(0, Math.min(input.hallucinationDrops, deleted));
  const duplicates = Math.max(0, Math.min(input.duplicateFactDrops ?? 0, deleted - drops));
  const clause = deletionClause(drops, duplicates, deleted - drops - duplicates);
  const narrative = input.overall.trim();

  if (surviving === 0) {
    const statement =
      `No finding in this review survived validation, so this run reports nothing about the page. ` +
      `The model produced ${seen} finding(s) and all ${seen} were deleted (${clause}).`;
    const base: ReconciledNarrative =
      narrative.length === 0
        ? { overall: `${statement} The model wrote no summary.` }
        : {
            overall:
              `${statement} The summary it wrote describes those deleted findings rather than this page, ` +
              `so it is recorded under ungroundedNarrative instead of here.`,
            ungroundedNarrative: input.overall,
          };
    return withRestatementDisclosure(base, input);
  }

  const caveat =
    `Caveat: ${deleted} of the ${seen} finding(s) the model reported were deleted before ` +
    `publication (${clause}). The summary that follows was written before that, so part of it ` +
    `may describe findings that are not in this result.`;
  return withRestatementDisclosure(
    withUngroundedDisclosure(
      { overall: narrative.length === 0 ? caveat : `${caveat} ${input.overall}` },
      ungrounded,
    ),
    input,
  );
}
