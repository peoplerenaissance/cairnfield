// Which patches may go into a team's copy (R23): none at level 0, the team's own at
// level 1, and at level 2 also those of the teams its lens names (KTD38).
//
// The team's own patches are the patch records in its own repo, so a team working alone
// needs no index (KTD40). An index is asked only where the patches of the named teams
// are, and every record of a node the lens does not name is dropped before anything
// else is done with it. What comes back are candidates. None is in the copy until its
// commit was fetched and checked (see `verify.ts`).

import { parseRecordPath } from "@cairnfield/protocol";
import type { NodeListing, View } from "@cairnfield/protocol";
import type { Home } from "../config.ts";
import type { Io } from "../io.ts";
import type { Lens } from "../lens.ts";
import { EXIT, stop } from "../outcome.ts";
import { indexView, readRecord } from "../services.ts";

/** A patch that the lens lets in, as a record announced it. */
export interface Candidate {
  /** The node of the team that published the record, whose fork holds the commit. */
  readonly node: string;
  /** The ID of the patch record. */
  readonly record: string;
  /** The patch commit the record names. */
  readonly commit: string;
  /** The IDs of the findings the record ties the patch to. */
  readonly findings: readonly string[];
  /** The patch ID the index gave. A record read from the team's own repo comes with none. */
  readonly expected?: string;
}

/** A candidate that did not get into the copy, with the code of why. */
export interface Refusal {
  readonly node: string;
  readonly record: string;
  readonly reason: string;
}

export interface Selection {
  readonly candidates: readonly Candidate[];
  readonly refused: readonly Refusal[];
}

/** The teams whose patches a lens lets in beside the team's own: those it names, at level 2. */
export function namedTeams(lens: Lens, own: string): string[] {
  return lens.patchLevel === 2 ? lens.teams.filter((team) => team !== own) : [];
}

/** How many record files are read from the node at once. */
const READS_AT_ONCE = 8;

/**
 * The patch records of one component in the team's own repo. The node validates nothing,
 * so each file is held to its name, which is the hash of its content (KTD1).
 */
async function ownCandidates(io: Io, home: Home, component: string, held: NodeListing | undefined): Promise<Selection> {
  const { node } = home.config;
  const candidates: Candidate[] = [];
  const refused: Refusal[] = [];
  if (!held) return { candidates, refused };
  const patches = held.records.flatMap(({ path }) => {
    const named = parseRecordPath(path);
    return named?.component === component && named.type === "patch" ? [{ path, id: named.id }] : [];
  });
  // A few at a time, and each batch in the listing's order, so two runs give the same lists.
  for (let at = 0; at < patches.length; at += READS_AT_ONCE) {
    const batch = patches.slice(at, at + READS_AT_ONCE);
    const files = await Promise.all(batch.map(({ path }) => readRecord(io, node, held.head, path)));
    for (const [which, { id }] of batch.entries()) {
      const file = files[which];
      if (file?.ok && file.record.type === "patch") {
        candidates.push({ node, record: id, commit: file.record.commit, findings: file.record.findings });
      } else {
        refused.push({ node, record: id, reason: file && !file.ok ? file.reason : "unresolved-reference" });
      }
    }
  }
  return { candidates, refused };
}

/** The patch records of the named teams in an index view. Each comes with the patch ID the index worked out for it. */
function namedCandidates(view: View, named: ReadonlySet<string>): Candidate[] {
  const candidates = view.patches.flatMap((group) =>
    group.patches.flatMap((patch) =>
      patch.records
        .filter(({ node, record }) => named.has(node) && record.component === view.component)
        .map(({ node, id, record }) => ({ node, record: id, commit: record.commit, findings: record.findings, expected: patch.patchId })),
    ),
  );
  // In a fixed order, so two runs check the same candidates in the same order.
  const key = (candidate: Candidate): string => `${candidate.expected} ${candidate.node} ${candidate.record}`;
  return candidates.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

/**
 * The candidates the lens lets in, the team's own first. `held` is the listing of the
 * team's own repo, or nothing when the team has published no record yet.
 */
export async function select(io: Io, home: Home, lens: Lens, component: string, held: NodeListing | undefined): Promise<Selection> {
  if (lens.patchLevel === 0) return { candidates: [], refused: [] };
  const own = await ownCandidates(io, home, component, held);
  if (lens.patchLevel === 1) return own;

  const { index, node } = home.config;
  if (index === undefined) return stop(EXIT.noIndex, "no-index");
  // The team's own patches are read from its own repo, whatever the index says of them.
  const named = namedCandidates(await indexView(io, index, component), new Set(namedTeams(lens, node)));
  return { candidates: [...own.candidates, ...named], refused: own.refused };
}
