// Which patches may go into a team's copy (R23): none at level 0, the team's own at
// level 1, and at level 2 also those of the teams its lens names (KTD38).
//
// The team's own patches are the patch records in its own repo, so a team working alone
// needs no index (KTD40). An index is asked only which patch records the named teams
// hold, and every record of a node the lens does not name is dropped before anything
// else is done with it. An index is not taken at its word for what a record says: a
// candidate is a node and a record ID, and the record itself is read from that node (see
// `verify.ts`). None is in the copy until its commit was fetched and checked.

import { compare, parseRecordPath } from "@cairnfield/protocol";
import type { NodeListing, View } from "@cairnfield/protocol";
import type { Home } from "../config.ts";
import type { Io } from "../io.ts";
import type { Lens } from "../lens.ts";
import { EXIT, stop } from "../outcome.ts";
import { indexView } from "../services.ts";

/** A patch record that the lens lets in: where it is, and nothing of what it says. */
export interface Candidate {
  /** The node of the team that published the record, whose fork holds the commit. */
  readonly node: string;
  /** The ID of the patch record. */
  readonly record: string;
  /** The patch ID the index gave. A record listed by the team's own repo comes with none. */
  readonly expected?: string;
}

/** The teams whose patches a lens lets in beside the team's own: those it names, at level 2. */
export function namedTeams(lens: Lens, own: string): string[] {
  return lens.patchLevel === 2 ? lens.teams.filter((team) => team !== own) : [];
}

/** The patch records of one component that the team's own repo lists. */
function ownCandidates(node: string, component: string, held: NodeListing | undefined): Candidate[] {
  return (held?.records ?? []).flatMap(({ path }) => {
    const named = parseRecordPath(path);
    return named?.component === component && named.type === "patch" ? [{ node, record: named.id }] : [];
  });
}

/** The patch records of the named teams in an index view. Each comes with the patch ID the index worked out for it. */
function namedCandidates(view: View, named: ReadonlySet<string>): Candidate[] {
  const candidates = view.patches.flatMap((group) =>
    group.patches.flatMap((patch) =>
      patch.records.filter(({ node }) => named.has(node)).map(({ node, id }) => ({ node, record: id, expected: patch.patchId })),
    ),
  );
  // In a fixed order, so two runs check the same candidates in the same order.
  const key = (candidate: Candidate): string => `${candidate.expected} ${candidate.node} ${candidate.record}`;
  // An index may list one record under many patch IDs. A record is one patch, so it is checked once, under the first.
  const listed = new Set<string>();
  return candidates
    .sort((a, b) => compare(key(a), key(b)))
    .filter(({ node, record }) => {
      const held = `${node} ${record}`;
      if (listed.has(held)) return false;
      listed.add(held);
      return true;
    });
}

/**
 * The candidates the lens lets in, the team's own first. `held` is the listing of the
 * team's own repo, or nothing when the team has published no record yet.
 */
export async function select(io: Io, home: Home, lens: Lens, component: string, held: NodeListing | undefined): Promise<Candidate[]> {
  if (lens.patchLevel === 0) return [];
  const { index, node } = home.config;
  const own = ownCandidates(node, component, held);
  if (lens.patchLevel === 1) return own;

  if (index === undefined) return stop(EXIT.noIndex, "no-index");
  // The team's own patches are read from its own repo, whatever the index says of them.
  return [...own, ...namedCandidates(await indexView(io, index, component), new Set(namedTeams(lens, node)))];
}
