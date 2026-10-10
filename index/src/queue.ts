// Push notices and the queue behind them (KTD11). A notice is an unauthenticated hint
// that names one node. It queues a sync of that node, and the sync always pulls from the
// registered URL. Notices for one node within 5 seconds cause one sync. A sync reads the
// node's head after every notice it stands for has arrived, so a notice that arrives
// after a sync has read the head queues another.
//
// The same queue carries the looks at a component whose copy is still importing.

import { NOTICE, conforms } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import { advance } from "./components.ts";
import type { Env } from "./env.ts";
import { answer, refusal } from "./respond.ts";
import { syncNode } from "./sync.ts";

/** What the queue carries: a node to sync, or a component whose copy to look at again. */
export type Message =
  | { readonly kind: "node"; readonly node: string }
  | { readonly kind: "component"; readonly component: string };

/** Notices for one node within this many seconds cause one sync (KTD11). */
const COALESCE_SECONDS = 5;
/** A queued sync that has not started after this long is taken as lost, and the next notice queues another. */
const LOST_AFTER_MS = 60_000;
/** A sync that failed, or a message whose handling threw, is tried again after this many seconds. */
const RETRY_SECONDS = 30;

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
      db.prepare("UPDATE nodes SET noticed_at = COALESCE(noticed_at, ?) WHERE url = ?").bind(now, node),
      // The mark is what makes fifty notices one sync. A sync takes it away before it reads the node's head.
      db.prepare("UPDATE nodes SET queued_at = ? WHERE url = ? AND (queued_at IS NULL OR queued_at <= ?)").bind(now, node, now - LOST_AFTER_MS),
    ]),
  );
  const changed = (at: number): boolean => (results[at]?.meta.changes ?? 0) > 0;
  const toQueue = nodes.filter((_, at) => changed(2 * at + 1));
  try {
    if (toQueue.length > 0) {
      await env.SYNC.sendBatch(
        toQueue.map((node) => ({ body: { kind: "node", node } })),
        { delaySeconds },
      );
    }
  } catch (error) {
    // Nothing was queued, so the marks go, and the next notice queues a sync.
    await db.batch(toQueue.map((node) => db.prepare("UPDATE nodes SET queued_at = NULL WHERE url = ? AND queued_at = ?").bind(node, now)));
    throw error;
  }
  return nodes.filter((_, at) => changed(2 * at));
}

/** Takes a notice. One for a node that is not registered is ignored: nothing is queued and nothing is fetched. */
export async function notice(env: Env, body: unknown, now: number): Promise<Response> {
  if (conforms(NOTICE, body)) return refusal("bad-request");
  const { node } = body as Infer<typeof NOTICE>;
  const registered = await schedule(env, [node], now, COALESCE_SECONDS);
  return registered.length === 0 ? refusal("not-found") : answer({});
}

/** Handles the messages of a batch, each by itself, so one that fails sends no other back. */
export async function consume(batch: MessageBatch<Message>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const { body } = message;
    const now = Date.now();
    try {
      if (body.kind === "node") {
        const outcome = await syncNode(env, body.node, now);
        if (outcome.ok) {
          // The node holds more new records than one pass takes. The rest is read at once.
          if (outcome.more) await schedule(env, [body.node], now, 0);
          message.ack();
        } else {
          // A code from a closed list and a registered URL. Nothing a node sent is logged.
          console.warn(JSON.stringify({ event: "sync-failed", node: body.node, reason: outcome.reason }));
          message.retry({ delaySeconds: RETRY_SECONDS });
        }
      } else {
        // A look at a copy that is still importing is a new message each time, because
        // a message is only delivered again a few times.
        const again = await advance(env, body.component, now);
        if (again !== undefined) await env.SYNC.send(body, { delaySeconds: again });
        message.ack();
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "message-failed", kind: body.kind, error: error instanceof Error ? error.name : "unknown" }));
      message.retry({ delaySeconds: RETRY_SECONDS });
    }
  }
}
