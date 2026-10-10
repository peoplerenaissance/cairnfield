// The view of one component commit (R10, R13), built when it is read: findings in match
// groups with their confirmations, patches side by side with theirs, claims with their
// state, recipes, pending and rejected work, the component's import state and each
// node's last processed commit.
//
// Nothing here is declared by an author. Groups and counts come from the protocol's own
// rules over the valid records, and a patch's ID, kind, size and changed lines from the
// check of its commit (KTD5). A reference is resolved here and not when a record is
// stored, because a record can cite one on a node the index reads later (Appendix H).
// The findings a patch record names are resolved a first time when its commit is
// checked, which needs the lines they cite, and again here.
// The view holds data and no prose, and rejected work is four values (KTD31).

import { SCHEMA_VERSION, bySource, compare, isConfirmed, matchGroups, patchConfirmations, patchGroups } from "@cairnfield/protocol";
import type { AnyRecord, CLAIM_STATES, Claim, FileEntry, Patch, PatchRecheck, Recipe, Sourced, View } from "@cairnfield/protocol";
import type { Component } from "./components.ts";
import { claimTtlMs } from "./env.ts";
import type { Env } from "./env.ts";
import type { ComputedPatch } from "./patches.ts";
import { recordOf } from "./records.ts";
import type { StoredRecord } from "./records.ts";

/** The repo of a node that holds its records. */
const TEAM_REPO = "team";

/** A valid record with its node, repo, commit and path. */
interface Published<R extends AnyRecord = AnyRecord> extends Sourced<R> {
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
}

type Row = Pick<StoredRecord, "node" | "path" | "type" | "state" | "reason" | "hash" | "head" | "body" | "cited" | "received_at" | "rebuilt">;

interface NodeRow {
  readonly url: string;
  readonly processed: string | null;
  readonly noticed_at: number | null;
  readonly absorbed_at: number | null;
}

function byHash(a: { readonly node: string; readonly hash: string }, b: { readonly node: string; readonly hash: string }): number {
  return compare(a.hash, b.hash) || compare(a.node, b.node);
}

const nodesOf = (sourced: readonly { readonly node: string }[]): string[] => [...new Set(sourced.map(({ node }) => node))].sort();

function isOfType<T extends AnyRecord["type"]>(entry: Published, type: T): entry is Published<Extract<AnyRecord, { type: T }>> {
  return entry.record.type === type;
}

/** `matchGroups` gives back the records it was given. This finds each one's entry again. */
function entriesOf(all: readonly Published[]): <R extends AnyRecord>(matched: readonly Sourced<R>[]) => Published<R>[] {
  const known = new Map<Sourced, Published>(all.map((entry) => [entry, entry]));
  return <R extends AnyRecord>(matched: readonly Sourced<R>[]) => matched.flatMap((sourced) => (known.get(sourced) as Published<R> | undefined) ?? []);
}

/** Names a claim among the claims of every node. A record cites a claim of its own node. */
const claimKey = (node: string, claim: string): string => `${node} ${claim}`;

type ViewPatch = View["patches"][number]["patches"][number];

const byPatchId = (a: ViewPatch, b: ViewPatch): number => compare(a.patchId, b.patchId);

/**
 * The patches of a view (R16, R24). A patch record is shown once its commit passed the
 * patch checks, and only while every finding it names is a valid finding of this view
 * (KTD5): a view narrowed to some nodes may not hold a finding that another node
 * published. Patch records with one patch ID are one entry that lists its records and
 * its organizations, and the entries whose changed lines overlap or adjoin in one file
 * content are one group.
 */
function patchesOf(valid: readonly Published[], computed: readonly ComputedPatch[]): View["patches"] {
  // A node and a record path name one record. Neither holds a space.
  const computedFor = new Map(computed.map((row) => [`${row.node} ${row.path}`, row]));
  const findings = new Set(valid.filter((entry) => isOfType(entry, "finding")).map(({ id }) => id));
  const identities = new Map<string, { readonly computed: ComputedPatch; readonly records: Published<Patch>[] }>();
  for (const entry of valid) {
    if (!isOfType(entry, "patch")) continue;
    const row = computedFor.get(`${entry.node} ${entry.path}`);
    if (!row || !entry.record.findings.every((id) => findings.has(id))) continue;
    const held = identities.get(row.patch_id);
    if (held) held.records.push(entry);
    else identities.set(row.patch_id, { computed: row, records: [entry] });
  }
  const authors = [...identities].flatMap(([patchId, { records }]) => records.map(({ node }) => ({ node, patchId })));
  const entries = [...identities].map(([patchId, { computed: row, records }]): ViewPatch => {
    // The organizations behind a patch identity: its authors, and each node whose re-check says it resolves its finding.
    const nodes = patchConfirmations(patchId, authors, valid);
    return {
      patchId,
      kind: row.kind,
      size: row.size,
      // Identical patches replace the same contents the same way, so what was computed for one holds for all.
      changes: JSON.parse(row.changes) as ViewPatch["changes"],
      paths: JSON.parse(row.paths) as ViewPatch["paths"],
      records,
      rechecks: valid.filter((entry): entry is Published<PatchRecheck> => isOfType(entry, "patch-re-check") && entry.record.patch === patchId),
      nodes,
      confirmed: isConfirmed(nodes),
    };
  });
  // In a fixed order, so an unchanged view reads the same on the next poll.
  return patchGroups(entries)
    .map((group) => ({ patches: group.sort(byPatchId) }))
    .sort((a, b) => compare(a.patches[0]?.patchId ?? "", b.patches[0]?.patchId ?? ""));
}

/** The state of a claim. One first seen in a rebuild counts as expired, whatever cites it (KTD13). */
function claimState(row: Row, closed: boolean, pastItsTime: boolean): (typeof CLAIM_STATES)[number] {
  if (row.rebuilt) return "expired";
  if (closed) return "closed";
  return pastItsTime ? "expired" : "live";
}

/**
 * The view of a registered component, or nothing for a commit that is not registered.
 * With `teams`, only the records of the listed nodes are read, and they are grouped and
 * counted (KTD38). The version is the component's, however the view is narrowed.
 */
export async function viewOf(env: Env, component: string, teams: readonly string[] | undefined, now: number): Promise<View | undefined> {
  const db = env.DB;
  // A claim that the index received by this time has passed its time (KTD15).
  const lastToPass = now - claimTtlMs(env);
  // The listed nodes go in as one value, so a long list meets no limit on the values of a statement.
  const only = teams === undefined ? null : JSON.stringify(teams);
  // One batch, so the component, the nodes, the records and what was computed for the patch records are read as they stood together.
  const [found, registered, stored, computed, passed] = (await db.batch([
    db.prepare("SELECT state, view_version FROM components WHERE component = ?").bind(component),
    db.prepare("SELECT url, processed, noticed_at, absorbed_at FROM nodes ORDER BY url"),
    db
      .prepare(
        "SELECT node, path, type, state, reason, hash, head, body, cited, received_at, rebuilt FROM records WHERE component = ?1 AND (?2 IS NULL OR node IN (SELECT value FROM json_each(?2)))",
      )
      .bind(component, only),
    // What was computed for a patch record is read for the listed nodes only, like the record itself.
    db
      .prepare("SELECT node, path, patch_id, kind, size, changes, paths FROM patches WHERE component = ?1 AND (?2 IS NULL OR node IN (SELECT value FROM json_each(?2)))")
      .bind(component, only),
    // Counted over every node, listed or not.
    db.prepare("SELECT COUNT(*) AS claims FROM records WHERE component = ?1 AND type = 'claim' AND state = 'valid' AND received_at <= ?2").bind(component, lastToPass),
  ])) as [D1Result<Pick<Component, "state" | "view_version">>, D1Result<NodeRow>, D1Result<Row>, D1Result<ComputedPatch>, D1Result<{ claims: number }>];
  const [held] = found.results;
  if (!held) return undefined;
  const listed = teams === undefined ? undefined : new Set(teams);
  const rows = stored.results;

  const pastItsTime = (row: Row): boolean => row.received_at <= lastToPass;

  const valid: Published[] = [];
  const rowOf = new Map<Published, Row>();
  // The claims that a record of the same node cites. A record that still waits for its
  // copy or its commit cites its claim too: the work the claim announced is published.
  const closed = new Set<string>();
  // Each cited path with its content, as it was worked out against the copy when the finding was checked (KTD5).
  const citedContent = new Map<string, FileEntry>();
  for (const row of rows) {
    if (row.state === "rejected" || row.body === null) continue;
    const record = recordOf(row.body);
    if ((record.type === "finding" || record.type === "patch") && record.claim !== undefined) closed.add(claimKey(row.node, record.claim));
    if (row.state !== "valid") continue;
    const entry: Published = { node: row.node, repo: TEAM_REPO, commit: row.head, path: row.path, id: row.hash, record };
    valid.push(entry);
    rowOf.set(entry, row);
    if (record.type === "finding" && row.cited !== null) {
      const { path } = record.location;
      citedContent.set(path, { path, mode: "100644", blob: row.cited });
    }
  }
  valid.sort(bySource);

  const entries = entriesOf(valid);
  const findings = matchGroups(valid, [...citedContent.values()]).map((group) => ({
    blob: group.blob,
    observation: group.observation,
    ...(group.host === undefined ? {} : { host: group.host }),
    paths: [...group.paths],
    findings: entries(group.findings),
    rechecks: entries(group.rechecks),
    counterFindings: entries(group.counterFindings),
    nodes: [...group.nodes],
    confirmed: group.confirmed,
    criteria: group.criteria.map((count) => ({ ...count, nodes: [...count.nodes] })),
  }));

  const hosts = new Map<string, number>();
  for (const group of findings) {
    if (group.host !== undefined) hosts.set(group.host, (hosts.get(group.host) ?? 0) + group.findings.length);
  }

  const claims = valid.flatMap((entry) => {
    const row = rowOf.get(entry);
    if (!row || !isOfType(entry, "claim")) return [];
    const state = claimState(row, closed.has(claimKey(entry.node, entry.id)), pastItsTime(row));
    return [{ ...(entry satisfies Published<Claim>), state } as const];
  });

  const byTree = new Map<string, Published<Recipe>[]>();
  for (const entry of valid) {
    if (!isOfType(entry, "recipe")) continue;
    const records = byTree.get(entry.record.tree);
    if (records) records.push(entry);
    else byTree.set(entry.record.tree, [entry]);
  }
  const recipes = [...byTree].sort(([a], [b]) => compare(a, b)).map(([tree, records]) => ({ tree, records, nodes: nodesOf(records) }));

  const nodes = registered.results.filter(({ url }) => listed === undefined || listed.has(url));
  // The index lag: the time since the oldest notice that is not yet processed arrived (Appendix H).
  const waiting = registered.results.flatMap(({ noticed_at, absorbed_at }) => [noticed_at, absorbed_at]).filter((at) => at !== null);
  // A claim that passes its time changes the view with no write, so the version counts
  // those claims on top of the stored number. Both only go up.
  const timedOut = passed.results[0]?.claims ?? 0;

  return {
    version: SCHEMA_VERSION,
    component,
    state: held.state,
    viewVersion: held.view_version + timedOut,
    lag: waiting.length === 0 ? 0 : Math.max(0, now - Math.min(...waiting)),
    organizations: nodes.length,
    nodes: nodes.map(({ url, processed }) => ({ node: url, ...(processed === null ? {} : { processed }), simulated: false, historyRewritten: false })),
    claims,
    findings,
    hosts: [...hosts].map(([host, count]) => ({ host, count })).sort((a, b) => compare(a.host, b.host)),
    patches: patchesOf(valid, computed.results),
    recipes,
    pending: rows.filter(({ state }) => state === "pending").map(({ node, hash, type }) => ({ node, hash, type })).sort(byHash),
    rejected: rows.flatMap(({ node, hash, type, state, reason }) => (state === "rejected" && reason !== null ? [{ node, hash, type, reason }] : [])).sort(byHash),
  };
}
