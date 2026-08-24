import type { Finding, Grade, Severity } from "@apatureai/verdict-types";

/**
 * Grade helpers (#106). The grade is the model's holistic judgment, but the
 * validation tail DROPS findings after it (hallucination gate #32, post-filter
 * #33). A grade justified only by a dropped finding must not survive. E.g. a
 * "blocked" grade with zero surviving blocker findings would block a PR on
 * nothing. So the grade is FLOORED to what the surviving findings support
 * (lowered only, never raised: the model may grade conservatively above its
 * individual findings, but never MORE severely than any surviving one).
 */
export const GRADE_RANK: Record<Grade, number> = { ship: 0, ship_with_nits: 1, needs_work: 2, blocked: 3 };

const SEVERITY_RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 };

/** The most severe grade among `grades` (default ship). */
export function worstGrade(grades: Grade[]): Grade {
  return grades.reduce<Grade>((worst, g) => (GRADE_RANK[g] > GRADE_RANK[worst] ? g : worst), "ship");
}

/** The maximum grade the surviving findings justify (none ⇒ ship). */
export function gradeFromFindings(findings: Finding[]): Grade {
  if (findings.length === 0) return "ship";
  const worst = findings.reduce<Severity>((w, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[w] ? f.severity : w), "nit");
  switch (worst) {
    case "blocker":
      return "blocked";
    case "major":
    case "minor":
      return "needs_work";
    case "nit":
    default:
      return "ship_with_nits";
  }
}

/** Floor the model grade to what surviving findings support (lower only, never raise). */
export function reconcileGrade(modelGrade: Grade, findings: Finding[]): Grade {
  const implied = gradeFromFindings(findings);
  return GRADE_RANK[modelGrade] <= GRADE_RANK[implied] ? modelGrade : implied;
}
