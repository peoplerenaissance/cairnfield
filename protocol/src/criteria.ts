// The implication order of the shared criteria (R5) and the lens rule (R23).

import type { Criterion } from "./enums.ts";

/** The safety criteria, weakest first. Each one implies those before it. works-as-documented stands apart. */
export const SAFETY_CRITERIA = [
  "safe-to-read",
  "safe-to-run-sandboxed",
  "safe-to-run-with-access",
] as const satisfies readonly Criterion[];

function rank(criterion: Criterion): number {
  return (SAFETY_CRITERIA as readonly Criterion[]).indexOf(criterion);
}

/** The criteria that a criterion implies: every weaker safety criterion. */
export function implied(criterion: Criterion): Criterion[] {
  const at = rank(criterion);
  return at < 0 ? [] : SAFETY_CRITERIA.slice(0, at);
}

/**
 * Whether a finding against `found` counts against a component that must meet `required`.
 * A finding counts against its own criterion and against every stricter one, because a
 * stricter criterion implies the one the finding breaks.
 */
export function countsAgainst(found: Criterion, required: Criterion): boolean {
  return found === required || implied(required).includes(found);
}

/** The part of a lens that the early rejection check applies (R23). */
export interface LensRule {
  /** The criteria the team requires for the use at hand. */
  readonly required: readonly Criterion[];
  /** The outside hosts the team approves, by exact name. */
  readonly approvedHosts: readonly string[];
}

/** What the rule reads from a finding: its criterion and, for a destination finding, its host. */
export interface CountedFinding {
  readonly criterion: Criterion;
  readonly host?: string;
}

/**
 * Whether a finding counts against a lens. A destination finding whose host is on the
 * approved list does not count. Any other finding counts when it counts against a
 * criterion the lens requires. The early rejection check passes confirmed findings only.
 */
export function countsAgainstLens(finding: CountedFinding, lens: LensRule): boolean {
  if (finding.host !== undefined && lens.approvedHosts.includes(finding.host)) return false;
  return lens.required.some((required) => countsAgainst(finding.criterion, required));
}
