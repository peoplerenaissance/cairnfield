// The match rule and the confirmation counts of R10 and R24. Nothing here is declared
// by an author. All of it is computed from records and the component's file listing (KTD5).

import { compare } from "./compare.ts";
import { countsAgainst } from "./criteria.ts";
import { CRITERIA } from "./enums.ts";
import type { Criterion, Observation } from "./enums.ts";
import type { FileListing } from "./files.ts";
import { CONFIRMED_AT } from "./limits.ts";
import type { AnyRecord, CounterFinding, Finding, Recheck } from "./schemas.ts";

/**
 * A record with the node it came from and its ID. A record does not name its own node.
 * The node is the node's identity: its base URL in the one accepted spelling (KTD8).
 * Nodes are compared as strings, so the caller passes only a URL that `isNodeUrl` accepts.
 */
export interface Sourced<R extends AnyRecord = AnyRecord> {
  readonly node: string;
  readonly id: string;
  readonly record: R;
}

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** Two line ranges overlap when they share at least one line. */
export function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * A finding's cited content: the blob hash of its file at its component commit (KTD5).
 * Nothing when the path is not in the listing.
 */
export function citedBlob(finding: Finding, listing: FileListing): string | undefined {
  return listing.find((entry) => entry.path === finding.location.path)?.blob;
}

/** The cited content of each finding, without duplicates. Patch scope is checked against this (R11). */
export function citedBlobs(findings: readonly Finding[], listing: FileListing): string[] {
  const blobs = new Set<string>();
  for (const finding of findings) {
    const blob = citedBlob(finding, listing);
    if (blob !== undefined) blobs.add(blob);
  }
  return [...blobs].sort();
}

// Two destination findings share an observation only when they name the same host.
// Otherwise a finding about one host would confirm a finding about another.
function sameObservation(a: Finding, b: Finding): boolean {
  return a.observation === b.observation && a.host === b.host;
}

/**
 * R10: two findings match when they share an observation, cite the same file content and
 * their line ranges overlap. Byte-identical files at different paths count as one.
 */
export function findingsMatch(a: Finding, b: Finding, listing: FileListing): boolean {
  const blob = citedBlob(a, listing);
  return (
    blob !== undefined &&
    blob === citedBlob(b, listing) &&
    sameObservation(a, b) &&
    rangesOverlap(a.location, b.location)
  );
}

/** A finding or a patch is confirmed when two organizations stand behind it. */
export function isConfirmed(nodes: readonly string[]): boolean {
  return new Set(nodes).size >= CONFIRMED_AT;
}

/** The organizations that say a group breaks one criterion. */
export interface CriterionCount {
  readonly criterion: Criterion;
  /**
   * The authors of the group's findings that count against the criterion, and every node
   * with a confirming re-check of one. A finding against a weaker criterion counts
   * against every stricter one (R5).
   */
  readonly nodes: readonly string[];
  readonly confirmed: boolean;
}

/** Findings that match, with what other nodes published about them. */
export interface MatchGroup {
  /** The file content the findings cite. */
  readonly blob: string;
  readonly observation: Observation;
  readonly host?: string;
  /** Every path the findings cite. More than one when the content sits at several paths. */
  readonly paths: readonly string[];
  readonly findings: readonly Sourced<Finding>[];
  readonly rechecks: readonly Sourced<Recheck>[];
  /** Disputes are shown beside the findings. They never remove or hide one, and never change the count. */
  readonly counterFindings: readonly Sourced<CounterFinding>[];
  /** The organizations that stand behind the group: every author and every node with a confirming re-check. */
  readonly nodes: readonly string[];
  /** Whether two organizations saw the same thing. It says nothing about a criterion. */
  readonly confirmed: boolean;
  /**
   * One entry for each criterion that an organization says the group breaks, in the order
   * of `CRITERIA`. The early rejection check reads these, never `confirmed` (R10).
   */
  readonly criteria: readonly CriterionCount[];
}

function bySource(a: Sourced, b: Sourced): number {
  return compare(a.id, b.id) || compare(a.node, b.node);
}

function byLocation(a: Sourced<Finding>, b: Sourced<Finding>): number {
  return (
    compare(a.record.location.start, b.record.location.start) ||
    compare(a.record.location.end, b.record.location.end) ||
    bySource(a, b)
  );
}

function isOfType<T extends AnyRecord["type"]>(
  sourced: Sourced,
  type: T,
): sourced is Sourced<Extract<AnyRecord, { type: T }>> {
  return sourced.record.type === type;
}

function byTarget<R extends Recheck | CounterFinding>(all: readonly Sourced<R>[]): Map<string, Sourced<R>[]> {
  const index = new Map<string, Sourced<R>[]>();
  for (const sourced of all) {
    const list = index.get(sourced.record.finding);
    if (list) list.push(sourced);
    else index.set(sourced.record.finding, [sourced]);
  }
  return index;
}

function targeting<R extends Recheck | CounterFinding>(
  index: ReadonlyMap<string, readonly Sourced<R>[]>,
  ids: ReadonlySet<string>,
): Sourced<R>[] {
  return [...ids].flatMap((id) => index.get(id) ?? []).sort(bySource);
}

/**
 * R10: confirmation per criterion. What two organizations saw is a fact they share. Which
 * criterion it breaks is a judgment, so each criterion needs its own two organizations.
 * A re-check stands behind the criterion of the finding it confirms.
 */
function criteriaOf(
  members: readonly Sourced<Finding>[],
  confirming: readonly Sourced<Recheck>[],
): CriterionCount[] {
  const named = new Map(members.map((member) => [member.id, member.record.criterion]));
  const stands = [
    ...members.map((member) => ({ criterion: member.record.criterion, node: member.node })),
    ...confirming.flatMap((recheck) => {
      const criterion = named.get(recheck.record.finding);
      return criterion === undefined ? [] : [{ criterion, node: recheck.node }];
    }),
  ];
  return CRITERIA.flatMap((criterion) => {
    const behind = stands.filter((stand) => countsAgainst(stand.criterion, criterion));
    const nodes = [...new Set(behind.map((stand) => stand.node))].sort();
    return nodes.length === 0 ? [] : [{ criterion, nodes, confirmed: isConfirmed(nodes) }];
  });
}

/**
 * Groups the findings of one component by the match rule. A chain of overlapping findings
 * is one group. Pass the records of one component with that component's listing.
 * A finding whose path is not in the listing is left out. Other record types are ignored,
 * apart from re-checks and counter-findings, which attach to the group of their target.
 */
export function matchGroups(records: readonly Sourced[], listing: FileListing): MatchGroup[] {
  const blobOf = new Map(listing.map((entry) => [entry.path, entry.blob]));
  const rechecks = byTarget(records.filter((sourced) => isOfType(sourced, "re-check")));
  const counterFindings = byTarget(records.filter((sourced) => isOfType(sourced, "counter-finding")));

  // Findings that could match share a blob, an observation and a host.
  const candidates = new Map<string, Sourced<Finding>[]>();
  for (const sourced of records) {
    if (!isOfType(sourced, "finding")) continue;
    const blob = blobOf.get(sourced.record.location.path);
    if (blob === undefined) continue;
    const key = `${blob}\n${sourced.record.observation}\n${sourced.record.host ?? ""}`;
    const list = candidates.get(key);
    if (list) list.push(sourced);
    else candidates.set(key, [sourced]);
  }

  const groups: MatchGroup[] = [];
  for (const key of [...candidates.keys()].sort()) {
    const sorted = (candidates.get(key) ?? []).sort(byLocation);
    // Sorted by first line, a finding joins the group before it when it starts within that group's lines.
    let members: Sourced<Finding>[] = [];
    let lastLine = 0;
    const close = (): void => {
      const first = members[0];
      if (first === undefined) return;
      const ids = new Set(members.map((member) => member.id));
      const confirming = targeting(rechecks, ids);
      const nodes = [...new Set([...members, ...confirming].map((sourced) => sourced.node))].sort();
      groups.push({
        blob: blobOf.get(first.record.location.path) ?? "",
        observation: first.record.observation,
        ...(first.record.host === undefined ? {} : { host: first.record.host }),
        paths: [...new Set(members.map((member) => member.record.location.path))].sort(),
        findings: members,
        rechecks: confirming,
        counterFindings: targeting(counterFindings, ids),
        nodes,
        confirmed: isConfirmed(nodes),
        criteria: criteriaOf(members, confirming),
      });
    };
    for (const sourced of sorted) {
      if (members.length > 0 && sourced.record.location.start > lastLine) {
        close();
        members = [];
        lastLine = 0;
      }
      members.push(sourced);
      lastLine = Math.max(lastLine, sourced.record.location.end);
    }
    close();
  }
  return groups;
}

/** A patch as a node published it, with the patch ID computed from its commit. A record never declares that ID. */
export interface SourcedPatch {
  readonly node: string;
  readonly patchId: string;
}

/**
 * R24: the organizations behind a patch identity. They are the nodes that wrote a patch
 * with this ID, plus the nodes whose patch re-check says it resolves its finding.
 */
export function patchConfirmations(
  patchId: string,
  patches: readonly SourcedPatch[],
  records: readonly Sourced[],
): string[] {
  const nodes = new Set<string>();
  for (const patch of patches) {
    if (patch.patchId === patchId) nodes.add(patch.node);
  }
  for (const sourced of records) {
    if (!isOfType(sourced, "patch-re-check")) continue;
    if (sourced.record.patch === patchId && sourced.record.verdict === "resolves") nodes.add(sourced.node);
  }
  return [...nodes].sort();
}
