// Which of a team's own findings move to a newer commit of a component (R37, KTD39).
//
// A finding is tied to the content it cites, not to a path in one commit. It carries
// when the newer commit still holds that content. It is then written again for the newer
// commit, as a new record: at the same path when that path still holds the content, and
// otherwise at the first path in sorted order that does. A second location is placed by
// the same rule, and a finding whose second location has no place does not carry. Only
// the same bytes count as the same content. No rename and no likeness is looked for.
//
// The findings are read from the team's own repo. The node validates nothing (KTD7), so
// each is held to the checks the outbox runs, against the older checkout. A record the
// node lists and answers not-found for is refused. Any other answer that is no success is
// a read that failed: it says nothing of the finding, and ends the command.

import { citedPaths, compare, parseRecordPath, recordId, recordPath, validateAgainstFiles } from "@cairnfield/protocol";
import type { CitedFiles, FileListing, Finding, NodeListing } from "@cairnfield/protocol";
import type { Listing } from "../checkout.ts";
import type { Io } from "../io.ts";
import { readRecord } from "../services.ts";

/** What became of one finding of the team's at the older commit. A reason is a code from a closed list. */
export type FindingEntry =
  /** Written again for the newer commit as the record `as`, at `path`. A location that moved is at another path than it was. */
  | { readonly finding: string; readonly carried: true; readonly reason: "content-unchanged" | "content-moved"; readonly as: string; readonly path: string }
  /** The newer commit holds the cited content at no path, or the content of the second location at none. */
  | { readonly finding: string; readonly carried: false; readonly reason: "content-changed" | "second-location-changed" }
  /** The record did not pass a check at the older commit. `check` is that check's code. */
  | { readonly finding: string; readonly carried: false; readonly reason: "refused"; readonly check: string };

/** A finding as it was written for the newer commit, with its ID there. */
export interface Carried {
  readonly id: string;
  readonly record: Finding;
}

export interface CarriedFindings {
  /** One entry for each finding the team's repo lists at the older commit, in the order of their IDs. */
  readonly entries: readonly FindingEntry[];
  /** What each finding that carried became, by the ID it had at the older commit. */
  readonly carried: ReadonlyMap<string, Carried>;
}

/**
 * Finds where the content at a path of the older commit sits in the newer one: at the
 * same path when it still holds that content, and otherwise at the first path in sorted
 * order that does. Gives nothing when no path does.
 */
function placer(older: FileListing, newer: FileListing): (path: string) => string | undefined {
  const blobAt = new Map(older.map((file) => [file.path, file.blob]));
  const holders = new Map<string, string[]>();
  for (const { path, blob } of newer) {
    const paths = holders.get(blob);
    if (paths) paths.push(path);
    else holders.set(blob, [path]);
  }
  return (path) => {
    const paths = holders.get(blobAt.get(path) ?? "") ?? [];
    return paths.includes(path) ? path : [...paths].sort(compare)[0];
  };
}

/**
 * Decides each finding the team's own repo holds at the older commit, and writes each
 * that carries again for the newer one. `held` is the listing of the team's repo, and
 * `files` reads the older checkout. Nothing is written here: the caller puts the new
 * records in the outbox.
 */
export async function carryFindings(
  io: Io,
  node: string,
  held: NodeListing,
  older: Listing,
  newer: Listing,
  files: (paths: readonly string[]) => Promise<CitedFiles>,
): Promise<CarriedFindings> {
  const place = placer(older.files, newer.files);
  const entries: FindingEntry[] = [];
  const carried = new Map<string, Carried>();
  const ids = held.records.flatMap(({ path }) => {
    const named = parseRecordPath(path);
    return named?.component === older.component && named.type === "finding" ? [named.id] : [];
  });
  for (const id of ids.sort(compare)) {
    // The node is the team's own, so a read of it that fails ends the command.
    const file = await readRecord(io, node, held.head, recordPath({ component: older.component, type: "finding" }, id), true);
    // A file the node lists and answers not-found for is no record, and neither is one that is not valid.
    if (!file?.ok || file.record.type !== "finding") {
      entries.push({ finding: id, carried: false, reason: "refused", check: file && !file.ok ? file.reason : "unresolved-reference" });
      continue;
    }
    const cited = validateAgainstFiles(file.record, await files(citedPaths(file.record)));
    if (!cited.ok) {
      entries.push({ finding: id, carried: false, reason: "refused", check: cited.reason });
      continue;
    }
    // A carried finding closes no claim: a claim is a record of the older commit.
    const { claim, contradicts, ...finding } = file.record;
    const path = place(finding.location.path);
    if (path === undefined) {
      entries.push({ finding: id, carried: false, reason: "content-changed" });
      continue;
    }
    const second = contradicts && place(contradicts.path);
    if (contradicts && second === undefined) {
      entries.push({ finding: id, carried: false, reason: "second-location-changed" });
      continue;
    }
    const record: Finding = {
      ...finding,
      component: newer.component,
      location: { ...finding.location, path },
      ...(contradicts && second !== undefined ? { contradicts: { ...contradicts, path: second } } : {}),
    };
    const moved = path !== finding.location.path || (contradicts !== undefined && second !== contradicts.path);
    const as = await recordId(record);
    entries.push({ finding: id, carried: true, reason: moved ? "content-moved" : "content-unchanged", as, path });
    carried.set(id, { id: as, record });
  }
  return { entries, carried };
}
