// The one sync path (R12). A push notice, a retry and a rebuild after a reset all end
// here: the index asks a registered node for its head and its listing, fetches the record
// files it has not read yet, checks each one, and stores it as valid, pending or rejected
// (KTD1, KTD31).
//
// A record is immutable and named by the hash of its content, so a file is read once.
// The index neither fetches nor stores a record of a component that is not registered,
// so a later sync reads it once the component is (KTD12).

import { MAX_RECORDS_PER_COMPONENT, canonicalJson, compare, parseRecordPath, sha256Hex, validateRecordFile } from "@cairnfield/protocol";
import type { RecordType } from "@cairnfield/protocol";
import type { Env } from "./env.ts";
import { readListing, readRecordFile } from "./fetch.ts";
import type { ReadFailure } from "./fetch.ts";
import { Copy, bump, judge } from "./records.ts";
import type { ComponentState, StoredRecord } from "./records.ts";

/**
 * The most record files read in one pass. A pass is one invocation, which may make a set
 * number of calls, and each record costs one fetch and up to three reads of the copy.
 * A node with more new records is read over several passes.
 */
const PASS_RECORDS = 120;

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
async function examine(copy: Copy, component: ComponentState, path: string, bytes: Uint8Array): Promise<Examined> {
  const verdict = await validateRecordFile(path, bytes);
  // No string of a refused file is kept: only the index's own hash of the bytes it read.
  if (!verdict.ok) return { state: "rejected", reason: verdict.reason, hash: await sha256Hex(bytes), body: null, cited: null };
  const judged = await judge(copy, component, verdict.record);
  return {
    state: judged.state,
    reason: judged.state === "rejected" ? judged.reason : null,
    hash: verdict.id,
    body: judged.state === "rejected" ? null : canonicalJson(verdict.record),
    cited: judged.state === "valid" ? (judged.cited ?? null) : null,
  };
}

/** Reads what a registered node holds that the index has not read yet. */
export async function syncNode(env: Env, node: string, now: number): Promise<SyncOutcome> {
  const db = env.DB;
  // Before the head is read: the mark of a queued sync goes, so a notice from here on
  // queues a sync of its own, and the notices so far are the ones this sync stands for (KTD11).
  const held = await db
    .prepare(
      "UPDATE nodes SET queued_at = NULL, absorbed_at = COALESCE(absorbed_at, noticed_at), noticed_at = NULL, syncs = syncs + 1 WHERE url = ? RETURNING processed, rebuilding, syncs",
    )
    .bind(node)
    .first<{ processed: string | null; rebuilding: number; syncs: number }>();
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
    return { ok: true, stored: 0, more: false };
  }

  const components = await db.prepare("SELECT component, state FROM components").all<{ component: string; state: ComponentState }>();
  const states = new Map(components.results.map(({ component, state }) => [component, state]));
  const known = await db.prepare("SELECT path FROM records WHERE node = ?").bind(node).all<{ path: string }>();
  const read = new Set(known.results.map(({ path }) => path));
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
    unseen.push({ path, component: named.component, type: named.type });
  }
  // In a fixed order, so two passes over one listing take the same files.
  unseen.sort((a, b) => compare(a.path, b.path));

  const copies = new Map<string, Copy>();
  const statements: D1PreparedStatement[] = [];
  const touched = new Set<string>();
  let failure: ReadFailure | undefined;
  for (const { path, component, type } of unseen.slice(0, PASS_RECORDS)) {
    const file = await readRecordFile(node, head, path);
    if (!file.ok) {
      failure = file.reason;
      break;
    }
    const copy = copies.get(component) ?? new Copy(env, component);
    copies.set(component, copy);
    const { state, reason, hash, body, cited } = await examine(copy, states.get(component) ?? "failed", path, file.bytes);
    statements.push(
      db
        .prepare(
          "INSERT INTO records (node, path, component, type, state, reason, hash, head, body, cited, received_at, rebuilt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (node, path) DO NOTHING",
        )
        .bind(node, path, component, type, state, reason, hash, head, body, cited, now, held.rebuilding),
    );
    touched.add(component);
  }
  const stored = statements.length;

  // The head counts as processed only when every record of it was read. What a pass did
  // read is kept either way.
  const complete = failure === undefined && stored === unseen.length;
  if (complete) statements.push(finished(head));
  // Every view lists each node with the commit last processed.
  if (complete && head !== held.processed) statements.push(bump(db));
  else for (const component of touched) statements.push(bump(db, component));
  if (statements.length > 0) await db.batch(statements);

  // A record stored for a component that was importing waits for the copy. The copy may
  // have become ready, or failed, after this pass read the component's state, and then
  // nothing would look at the record again. So such a component is looked at once more.
  const waited = [...touched].filter((component) => states.get(component) === "importing");
  if (waited.length > 0) {
    const settled = await db
      .prepare(`SELECT component FROM components WHERE state != 'importing' AND component IN (${waited.map(() => "?").join(", ")})`)
      .bind(...waited)
      .all<{ component: string }>();
    for (const { component } of settled.results) await env.SYNC.send({ kind: "component", component });
  }
  return failure === undefined ? { ok: true, head, stored, more: !complete } : { ok: false, reason: failure };
}
