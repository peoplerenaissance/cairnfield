// Patch intake (R11, R24). A patch record announces one commit in the fork of the node
// that published it. The index asks that node for the commit's parent and changed paths
// and for the blobs the commit puts in place, runs the protocol's patch checks against
// its own copy, and stores the record as valid with what it computed, or as rejected
// with a reason from the protocol's closed list (KTD5).
//
// The index trusts the node for the parent and for the completeness of the list of
// changed paths. It holds each served blob to its hash, and takes the content a patch
// replaces from its own copy and from nowhere else (KTD7). A hostile node can hide a
// change from the index, so assembly checks again (KTD23).
//
// A look at a patch record runs from the queue. A record whose commit the node does not
// serve yet, or whose findings are not valid here yet, is looked at again after a while,
// a set number of times (KTD11). After that it stays pending, and is looked at once more
// at each later sync of its node and when a finding it names becomes valid.

import {
  DELETED_MODE,
  MAX_PATCH_REPLACEMENTS,
  applyChanges,
  changedPaths,
  checkPatch,
  citedRanges,
  isInScope,
  modesAreRegular,
  replacementsOf,
} from "@cairnfield/protocol";
import type { CitedRange, FileListing, Finding, Patch, PatchFacts, PatchKind, RejectionReason, Replacement } from "@cairnfield/protocol";
import { MAX_BATCH_MESSAGES } from "./env.ts";
import type { Env } from "./env.ts";
import { readForkBlob, readPatchCommit } from "./fetch.ts";
import { Copy, TOO_LARGE, bump, recordOf, settle } from "./records.ts";
import type { ComponentState } from "./records.ts";

/** A patch record that cannot be checked yet is looked at again after this many seconds (KTD11). */
export const PATCH_WAIT_SECONDS = 30;
/** A patch record is looked at this many times at most. After the last look it stays pending. */
export const PATCH_TRIES = 20;

/** A patch record, by its node and its path in the node's team repo. */
export interface PatchName {
  readonly node: string;
  readonly path: string;
}

/** One row of the patches table: what the index computed for a valid patch record. */
export interface ComputedPatch extends PatchName {
  readonly patch_id: string;
  readonly kind: PatchKind;
  readonly size: number;
  /** A JSON list: the changed lines of each replaced content. */
  readonly changes: string;
  /** A JSON list: every path the patch changes. */
  readonly paths: string;
}

/** Queues a look at each of these patch records, as the look that comes after `tries` others. */
async function queueLooks(env: Env, patches: readonly PatchName[], tries: number): Promise<void> {
  for (let at = 0; at < patches.length; at += MAX_BATCH_MESSAGES) {
    await env.SYNC.sendBatch(patches.slice(at, at + MAX_BATCH_MESSAGES).map(({ node, path }) => ({ body: { kind: "patch", node, path, tries } })));
  }
}

/** Queues a first look at each of these patch records: the first of the set number of tries. */
export function lookAtPatches(env: Env, patches: readonly PatchName[]): Promise<void> {
  return queueLooks(env, patches, 0);
}

/** Names a patch record among the records of every node. Neither part holds a space. */
const nameOf = ({ node, path }: PatchName): string => `${node} ${path}`;

/**
 * Queues one look at each of these patch records, and none at a record in `first`, whose
 * first look was just queued. A record that is named twice gets one look. The look is
 * sent as the last of the tries, so one that must still wait queues nothing more.
 */
export function lookOnceAtPatches(env: Env, patches: readonly PatchName[], first: readonly PatchName[] = []): Promise<void> {
  const taken = new Set(first.map(nameOf));
  const once = patches.filter((patch) => {
    const name = nameOf(patch);
    if (taken.has(name)) return false;
    taken.add(name);
    return true;
  });
  return queueLooks(env, once, PATCH_TRIES - 1);
}

/**
 * The patch records of a node that still wait, on a component whose copy is ready. Each
 * sync of the node looks at them once more: the look that the storing sync queued may
 * have been lost, and the fork may hold the commit only after the tries were spent. That
 * costs one read of the node for each such record at each sync of the node.
 */
export async function waitingPatchesOf(env: Env, node: string): Promise<PatchName[]> {
  const { results } = await env.DB.prepare(
    "SELECT records.node, records.path FROM records JOIN components ON components.component = records.component WHERE records.node = ? AND records.type = 'patch' AND records.state = 'pending' AND components.state = 'ready' ORDER BY records.path",
  )
    .bind(node)
    .all<PatchName>();
  return results;
}

/**
 * The patch records that still wait and name one of these findings, from any node.
 * `findings` holds the findings that became valid, by component. A patch can name a
 * finding on a node the index reads later, when its own tries may be spent.
 */
export async function patchesWaitingFor(env: Env, findings: ReadonlyMap<string, readonly string[]>): Promise<PatchName[]> {
  const waiting: PatchName[] = [];
  for (const [component, ids] of findings) {
    if (ids.length === 0) continue;
    // The findings go in as one value, so a long list meets no limit on the values of a statement.
    const { results } = await env.DB.prepare(
      "SELECT node, path FROM records WHERE component = ?1 AND state = 'pending' AND type = 'patch' AND EXISTS (SELECT 1 FROM json_each(records.body, '$.findings') AS named WHERE named.value IN (SELECT value FROM json_each(?2))) ORDER BY node, path",
    )
      .bind(component, JSON.stringify(ids))
      .all<PatchName>();
    waiting.push(...results);
  }
  return waiting;
}

/**
 * Queues a first look at every patch record of a component that still waits, all in one
 * invocation. At the caps that is the registered nodes times 500 records, sent 100 to a batch.
 */
export async function lookAtWaitingPatches(env: Env, component: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT node, path FROM records WHERE component = ? AND state = 'pending' AND type = 'patch' ORDER BY node, path")
    .bind(component)
    .all<PatchName>();
  await lookAtPatches(env, results);
}

/**
 * The findings a patch record names, or nothing while one of them is not a valid finding
 * of the component here (KTD5). A patch can name a finding on a node the index reads
 * later, so a missing one is waited for and is no reason to reject (Appendix H).
 */
async function findingsOf(db: D1Database, component: string, ids: readonly string[]): Promise<Finding[] | undefined> {
  const marks = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT hash, body FROM records WHERE component = ? AND type = 'finding' AND state = 'valid' AND hash IN (${marks})`)
    .bind(component, ...ids)
    .all<{ hash: string; body: string }>();
  // A finding that two nodes hold is one record, whichever node published it (KTD1).
  const found = new Map<string, Finding>();
  for (const { hash, body } of results) {
    const record = recordOf(body);
    if (record.type === "finding") found.set(hash, record);
  }
  return found.size === ids.length ? [...found.values()] : undefined;
}

type Checked =
  | { readonly state: "valid"; readonly facts: PatchFacts }
  | { readonly state: "rejected"; readonly reason: RejectionReason };

const rejected = (reason: RejectionReason): Checked => ({ state: "rejected", reason });

/**
 * The replacements whose content the patch checks will read: those that change a content,
 * and none for a commit that fails a check that reads no content. It follows the order
 * of `checkPatch`, and `cli/src/assemble/verify.ts` does the same before it reads content.
 */
function contentToRead(base: FileListing, patched: FileListing, cited: readonly CitedRange[]): Replacement[] {
  const paths = changedPaths(base, patched);
  if (!modesAreRegular(paths) || !isInScope(paths, cited)) return [];
  const replacements = replacementsOf(base, paths);
  if (replacements === undefined || replacements.length > MAX_PATCH_REPLACEMENTS) return [];
  return replacements.filter(({ oldBlob, newBlob }) => newBlob !== oldBlob);
}

/**
 * Checks the commit a patch record names against the index's own copy. Returns nothing
 * when the check cannot run yet: a finding is not valid here, or the node does not serve
 * the commit or one of its blobs.
 */
async function check(env: Env, node: string, component: string, record: Patch): Promise<Checked | undefined> {
  const findings = await findingsOf(env.DB, component, record.findings);
  if (!findings) return undefined;
  const served = await readPatchCommit(node, component, record.commit);
  if (!served) return undefined;
  // A patch is one commit on the pinned commit (KTD4). The node is trusted for the parent it reports.
  if (served.parent !== component) return rejected("wrong-parent");

  const copy = new Copy(env, component);
  const base = await copy.listing();
  // The lines the patch may change are the lines its findings cite in the index's own copy.
  const cited = citedRanges(findings, base);
  const patched = applyChanges(base, served.changes);

  // Only the content that the patch checks will read is fetched. The protocol runs the
  // checks that read no content first, so a commit that fails one of them costs no read
  // of the copy and no fetch from the node. A patch replaces no more contents than
  // `MAX_PATCH_REPLACEMENTS` allows (KTD6).
  const toRead = contentToRead(base, patched, cited);
  // The node is asked first, for content that is short (KTD6). The copy may hold long
  // content, and it is read only once the node has served all of its own. So a node that
  // reports a commit and serves no blob costs no read of the copy, however often it is asked.
  const after = new Map<string, Uint8Array>();
  for (const { newBlob, newMode } of toRead) {
    if (newMode === DELETED_MODE || after.has(newBlob)) continue;
    const content = await readForkBlob(node, component, newBlob);
    if (!content) return undefined;
    after.set(newBlob, content);
  }
  const before = new Map<string, Uint8Array>();
  for (const { oldBlob } of toRead) {
    if (before.has(oldBlob)) continue;
    const content = await copy.read(oldBlob);
    if (content === TOO_LARGE) return rejected(TOO_LARGE);
    before.set(oldBlob, content);
  }

  // The verdict is the protocol's own, in the order the protocol checks.
  const verdict = await checkPatch({ base: { files: base, content: before }, patched: { files: patched, content: after }, cited });
  return verdict.ok ? { state: "valid", facts: verdict } : rejected(verdict.reason);
}

/**
 * Stores what the index computed for a patch record that is still pending. It runs in
 * one batch with the statement that settles the record, and before it.
 */
function keep(db: D1Database, { node, path }: PatchName, component: string, facts: PatchFacts): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO patches (node, path, component, patch_id, kind, size, changes, paths) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE EXISTS (SELECT 1 FROM records WHERE node = ?1 AND path = ?2 AND state = 'pending') ON CONFLICT (node, path) DO NOTHING",
    )
    .bind(node, path, component, facts.patchId, facts.kind, facts.size, JSON.stringify(facts.changes), JSON.stringify(facts.paths));
}

/**
 * Looks at one patch record that waits for its commit, and settles it when the commit
 * can be checked. Returns whether the record must be looked at again.
 */
export async function lookAtPatch(env: Env, name: PatchName): Promise<boolean> {
  const db = env.DB;
  const held = await db
    .prepare(
      "SELECT records.component, records.body, components.state FROM records JOIN components ON components.component = records.component WHERE records.node = ? AND records.path = ? AND records.type = 'patch' AND records.state = 'pending'",
    )
    .bind(name.node, name.path)
    .first<{ component: string; body: string | null; state: ComponentState }>();
  // An earlier look settled the record, or a reset dropped it.
  if (!held || held.body === null) return false;
  const { component } = held;
  // Without a ready copy there is nothing to check the commit against. The look that
  // finds the copy ready queues a look at this record again.
  if (held.state !== "ready") return false;
  const record = recordOf(held.body);
  if (record.type !== "patch") return false;

  const checked = await check(env, name.node, component, record);
  if (!checked) return true;
  const statements =
    checked.state === "valid"
      ? [keep(db, name, component, checked.facts), settle(db, name.node, name.path, { state: "valid" })]
      : [settle(db, name.node, name.path, checked)];
  await db.batch([...statements, bump(db, component)]);
  return false;
}
