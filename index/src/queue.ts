// Push notices and the queue behind them (KTD11). A notice is an unauthenticated hint
// that names one node. It queues a sync of that node, and the sync always pulls from the
// registered URL. Notices for one node within 5 seconds cause one sync. A sync reads the
// node's head after every notice it stands for has arrived, so a notice that arrives
// after a sync has read the head queues another.
//
// The same queue carries the looks at a component whose copy is still importing, and the
// looks at a patch record whose commit is to be checked.

import { NOTICE, conforms } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import { advance } from "./components.ts";
import { MAX_BATCH_MESSAGES } from "./env.ts";
import type { Env } from "./env.ts";
import { PATCH_TRIES, PATCH_WAIT_SECONDS, lookAtPatch } from "./patches.ts";
import { answer, refusal } from "./respond.ts";
import { syncNode } from "./sync.ts";

/**
 * What the queue carries: a node to sync, a component whose copy to look at again, or a
 * patch record whose commit to check. `tries` counts the looks at the record before this one.
 */
export type Message =
  | { readonly kind: "node"; readonly node: string }
  | { readonly kind: "component"; readonly component: string }
  | { readonly kind: "patch"; readonly node: string; readonly path: string; readonly tries: number };

/** Notices for one node within this many seconds cause one sync (KTD11). */
const COALESCE_SECONDS = 5;
/** A queued sync that has not started after this long is taken as lost, and the next notice queues another. */
const LOST_AFTER_MS = 60_000;
/** A sync that failed, or a message whose handling threw, is tried again after this many seconds. */
const RETRY_SECONDS = 30;
const RETRY: QueueRetryOptions = { delaySeconds: RETRY_SECONDS };

/**
 * Queues a sync of each of these nodes after `delaySeconds`, unless one is queued for it
 * already. Each node is marked as having news that no sync has taken up yet, which is
 * what the index lag counts from. Returns the nodes that are registered.
 */
export async function schedule(env: Env, nodes: readonly string[], now: number, delaySeconds: number): Promise<string[]> {
  if (nodes.length === 0) return [];
  const db = env.DB;
  const results = await db.batch(
    nodes.flatMap((node) => [
      db.prepare("SELECT 1 FROM nodes WHERE url = ?").bind(node),
      // Only the oldest notice that no sync has taken up is written down, so a later one writes nothing.
      db.prepare("UPDATE nodes SET noticed_at = ? WHERE url = ? AND noticed_at IS NULL").bind(now, node),
      // The mark is what makes fifty notices one sync. A sync takes it away before it reads the node's head.
      db.prepare("UPDATE nodes SET queued_at = ? WHERE url = ? AND (queued_at IS NULL OR queued_at <= ?)").bind(now, node, now - LOST_AFTER_MS),
    ]),
  );
  // Three statements a node: whether it is registered, its notice and its mark.
  const registered = nodes.filter((_, at) => (results[3 * at]?.results.length ?? 0) > 0);
  const toQueue = nodes.filter((_, at) => (results[3 * at + 2]?.meta.changes ?? 0) > 0);
  let queued = 0;
  try {
    for (; queued < toQueue.length; queued += MAX_BATCH_MESSAGES) {
      await env.SYNC.sendBatch(
        toQueue.slice(queued, queued + MAX_BATCH_MESSAGES).map((node) => ({ body: { kind: "node", node } })),
        { delaySeconds },
      );
    }
  } catch (error) {
    // No sync was queued for the nodes from here on, so their marks go, and the next notice queues one.
    await db.batch(toQueue.slice(queued).map((node) => db.prepare("UPDATE nodes SET queued_at = NULL WHERE url = ? AND queued_at = ?").bind(node, now)));
    throw error;
  }
  return registered;
}

/** Takes a notice. One for a node that is not registered is ignored: nothing is queued and nothing is fetched. */
export async function notice(env: Env, body: unknown, now: number): Promise<Response> {
  if (conforms(NOTICE, body)) return refusal("bad-request");
  const { node } = body as Infer<typeof NOTICE>;
  const registered = await schedule(env, [node], now, COALESCE_SECONDS);
  return registered.length === 0 ? refusal("not-found") : answer({});
}

/** Syncs a node. Returns whether its message is done with: a sync that failed is tried again. */
async function handleNode(env: Env, node: string, now: number): Promise<boolean> {
  const outcome = await syncNode(env, node, now);
  if (!outcome.ok) {
    // A code from a closed list and a registered URL. Nothing a node sent is logged.
    console.warn(JSON.stringify({ event: "sync-failed", node, reason: outcome.reason }));
    return false;
  }
  // The node holds more new records than one pass takes. The rest is read at once.
  if (outcome.more) await schedule(env, [node], now, 0);
  return true;
}

/** Looks at a component's copy. Its message is always done with. */
async function handleComponent(env: Env, body: Extract<Message, { kind: "component" }>, now: number): Promise<boolean> {
  // A look at a copy that is still importing is a new message each time, because
  // a message is only delivered again a few times.
  const again = await advance(env, body.component, now);
  if (again !== undefined) await env.SYNC.send(body, { delaySeconds: again });
  return true;
}

/**
 * Looks at a patch record's commit. Its message is always done with: a record that must
 * be looked at again gets a new message after a while, a set number of times (KTD11).
 * After the last look it stays pending.
 */
async function handlePatch(env: Env, body: Extract<Message, { kind: "patch" }>): Promise<boolean> {
  const again = await lookAtPatch(env, body);
  const tries = body.tries + 1;
  if (again && tries < PATCH_TRIES) await env.SYNC.send({ ...body, tries }, { delaySeconds: PATCH_WAIT_SECONDS });
  return true;
}

/** Handles one message. Returns whether it is done with. */
function handle(env: Env, body: Message, now: number): Promise<boolean> {
  if (body.kind === "node") return handleNode(env, body.node, now);
  if (body.kind === "component") return handleComponent(env, body, now);
  return handlePatch(env, body);
}

/** Handles the messages of a batch, each by itself, so one that fails sends no other back. */
export async function consume(batch: MessageBatch<Message>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const { body } = message;
    const now = Date.now();
    try {
      const done = await handle(env, body, now);
      if (done) message.ack();
      else message.retry(RETRY);
    } catch (error) {
      console.warn(JSON.stringify({ event: "message-failed", kind: body.kind, error: error instanceof Error ? error.name : "unknown" }));
      message.retry(RETRY);
    }
  }
}
