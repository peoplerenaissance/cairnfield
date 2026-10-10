// The one sync path (R12). A push notice, a retry and a rebuild after a reset all end
// here: the index asks a registered node for its head and its listing, fetches the record
// files it has not read yet, checks each one, and stores it as valid, pending or rejected
// (KTD1, KTD31).
//
// A record is immutable and named by the hash of its content, so a file is read once.
// The index neither fetches nor stores a record of a component that is not registered,
// so a later sync reads it once the component is (KTD12).
//
// A patch record is stored as pending, and a look at its commit is queued (see `patches.ts`).

import { MAX_LISTING_ENTRIES, MAX_RECORDS_PER_COMPONENT, canonicalJson, compare, parseRecordPath, sha256Hex, validateRecordFile } from "@cairnfield/protocol";
import type { RecordType } from "@cairnfield/protocol";
import type { Env } from "./env.ts";
import { readListing, readRecordFile } from "./fetch.ts";
import type { ReadFailure } from "./fetch.ts";
import { lookAtPatches } from "./patches.ts";
import type { PatchName } from "./patches.ts";
import { Copy, PASS_RECORDS, bump, judge, reasonAndCited } from "./records.ts";
import type { ComponentState, StoredRecord } from "./records.ts";

/** Record files are fetched this many at a time: as many connections as one invocation holds open at once. */
const FETCH_AHEAD = 6;

export type SyncOutcome =
  /** `more` says the node holds records that this pass did not get to. */
  | { readonly ok: true; readonly head?: string; readonly stored: number; readonly more: boolean }
  | { readonly ok: false; readonly reason: ReadFailure };

interface Listed {
  readonly path: string;
  readonly component: string;
  readonly type: RecordType;
}

type Examined = Pick<StoredRecord, "state" | "reason" | "hash" | "body" | "cited">;

/** Checks the bytes of one record file and says what to store for it. */
async function examine(copy: Copy, state: ComponentState, path: string, bytes: Uint8Array): Promise<Examined> {
  const verdict = await validateRecordFile(path, bytes);
  // No string of a refused file is kept: only the index's own hash of the bytes it read.
  if (!verdict.ok) return { state: "rejected", reason: verdict.reason, hash: await sha256Hex(bytes), body: null, cited: null };
  const judged = await judge(copy, state, verdict.record);
  return {
    state: judged.state,
    hash: verdict.id,
    body: judged.state === "rejected" ? null : canonicalJson(verdict.record),
    ...reasonAndCited(judged),
  };
}

/**
 * Queues a look at each component that is no longer importing and still holds a record
 * of this node that waits for its copy. Such a record was stored while the component was
 * importing. The copy may have become ready, or failed, after the pass read the
 * component's state, and then nothing else would look at the record again. Every sync
 * asks, not only the one that stored the record: that one may have ended before its look
 * was queued. A patch record is not asked for: it waits for its commit, and the sync
 * that stores it queues a look of its own.
 */
async function lookAtSettled(env: Env, node: string): Promise<void> {
  const settled = await env.DB.prepare(
    "SELECT component FROM components WHERE state != 'importing' AND component IN (SELECT component FROM records WHERE node = ? AND state = 'pending' AND type != 'patch')",
  )
    .bind(node)
    .all<{ component: string }>();
  if (settled.results.length > 0) await env.SYNC.sendBatch(settled.results.map(({ component }) => ({ body: { kind: "component", component } })));
}

/** Reads what a registered node holds that the index has not read yet. */
export async function syncNode(env: Env, node: string, now: number): Promise<SyncOutcome> {
  const db = env.DB;
  // Before the head is read: the mark of a queued sync goes, so a notice from here on
  // queues a sync of its own, and the notices so far are the ones this sync stands for (KTD11).
  const held = await db
    .prepare(
      "UPDATE nodes SET queued_at = NULL, absorbed_at = COALESCE(absorbed_at, noticed_at), noticed_at = NULL, syncs = syncs + 1 WHERE url = ? RETURNING processed, syncs",
    )
    .bind(node)
    .first<{ processed: string | null; syncs: number }>();
  // Only a registered node is read, and only at the URL it was registered with.
  if (!held) return { ok: true, stored: 0, more: false };

  const listing = await readListing(node);
  if (!listing.ok) return listing;
  // Only the sync that started last says what is processed. One that started before it
  // read an older head, and may finish after it.
  const finished = (processed: string | null): D1PreparedStatement =>
    db.prepare("UPDATE nodes SET processed = ?, rebuilding = 0, absorbed_at = NULL WHERE url = ? AND syncs = ?").bind(processed, node, held.syncs);
  const { head } = listing;
  if (head === undefined) {
    await finished(held.processed).run();
    await lookAtSettled(env, node);
    return { ok: true, stored: 0, more: false };
  }

  const components = await db.prepare("SELECT component, state FROM components").all<{ component: string; state: ComponentState }>();
  const states = new Map(components.results.map(({ component, state }) => [component, state]));
  const known = await db.prepare("SELECT path, component FROM records WHERE node = ?").bind(node).all<{ path: string; component: string }>();
  const read = new Set(known.results.map(({ path }) => path));
  // The limits of a listing also hold for what the index would keep for the node: the
  // records stored so far with the ones this listing adds. No stored record is ever
  // dropped, so a node that lists other records at each head would add to them without
  // end. A node that never takes a record away is held to its listing and no more.
  const kept = new Map<string, number>();
  for (const { component } of known.results) kept.set(component, (kept.get(component) ?? 0) + 1);
  let keptForNode = known.results.length;
  const perComponent = new Map<string, number>();
  const unseen: Listed[] = [];
  for (const path of listing.paths) {
    // A path in any other shape is never fetched, and nothing of it is kept (KTD31).
    const named = parseRecordPath(path);
    if (!named || typeof path !== "string") continue;
    const count = (perComponent.get(named.component) ?? 0) + 1;
    if (count > MAX_RECORDS_PER_COMPONENT) return { ok: false, reason: "too-large" };
    perComponent.set(named.component, count);
    if (!states.has(named.component) || read.has(path)) continue;
    read.add(path);
    const keptForComponent = (kept.get(named.component) ?? 0) + 1;
    keptForNode += 1;
    if (keptForComponent > MAX_RECORDS_PER_COMPONENT || keptForNode > MAX_LISTING_ENTRIES) return { ok: false, reason: "too-large" };
    kept.set(named.component, keptForComponent);
    unseen.push({ path, component: named.component, type: named.type });
  }
  // In a fixed order, so two passes over one listing take the same files.
  unseen.sort((a, b) => compare(a.path, b.path));

  const copies = new Map<string, Copy>();
  const statements: D1PreparedStatement[] = [];
  const touched = new Set<string>();
  /** The view of each component that the pass stored a record for has changed. */
  const bumps = (): D1PreparedStatement[] => [...touched].map((component) => bump(db, component));
  /**
   * The patch records the pass stores as pending. A look at each one's commit is queued
   * once they are written, whatever the state of its component was when the pass began:
   * the look reads the state as it is by then.
   */
  const patches: PatchName[] = [];
  let failure: ReadFailure | undefined;
  const pass = unseen.slice(0, PASS_RECORDS);
  for (let at = 0; at < pass.length && failure === undefined; at += FETCH_AHEAD) {
    // The files are fetched together. Each is then checked by itself, in the order of the pass.
    const fetched = await Promise.all(
      pass.slice(at, at + FETCH_AHEAD).map(async (listed) => ({ listed, file: await readRecordFile(node, head, listed.path) })),
    );
    for (const { listed, file } of fetched) {
      // The pass stops at the first file that was not read, and keeps nothing that came after it.
      if (!file.ok) {
        failure = file.reason;
        break;
      }
      const { path, component, type } = listed;
      const copy = copies.get(component) ?? new Copy(env, component);
      copies.set(component, copy);
      let examined: Examined;
      try {
        examined = await examine(copy, states.get(component) ?? "failed", path, file.bytes);
      } catch (error) {
        // The copy could not be read. What the pass judged before this record is written
        // first, so the sync that is tried next starts after it. The head is not processed.
        if (statements.length > 0) await db.batch([...statements, ...bumps()]);
        await lookAtPatches(env, patches);
        throw error;
      }
      const { state, reason, hash, body, cited } = examined;
      statements.push(
        db
          .prepare(
            // Whether the node is being rebuilt is read as the record is stored. A reset
            // may have come since this sync started, and its records count as rebuilt then.
            "INSERT INTO records (node, path, component, type, state, reason, hash, head, body, cited, received_at, rebuilt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, (SELECT rebuilding FROM nodes WHERE url = ?1)) ON CONFLICT (node, path) DO NOTHING",
          )
          .bind(node, path, component, type, state, reason, hash, head, body, cited, now),
      );
      touched.add(component);
      if (type === "patch" && state === "pending") patches.push({ node, path });
    }
  }
  const stored = statements.length;

  // The head counts as processed only when every record of it was read. What a pass did
  // read is kept either way.
  const complete = failure === undefined && stored === unseen.length;
  if (complete) statements.push(finished(head));
  // Every view lists each node with the commit last processed.
  if (complete && head !== held.processed) statements.push(bump(db));
  else statements.push(...bumps());
  if (statements.length > 0) await db.batch(statements);

  await lookAtPatches(env, patches);
  await lookAtSettled(env, node);
  return failure === undefined ? { ok: true, head, stored, more: !complete } : { ok: false, reason: failure };
}
