// Who can add work to the index (KTD30). A node and a component are registered with the
// registration key, up to a cap, and a component only from a Git URL on the allow-list.
// A reset needs the reset key, which is another key. An index with no key set refuses.

import { REGISTER_COMPONENT_REQUEST, REGISTER_NODE_REQUEST, conforms } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import { componentOf } from "./components.ts";
import type { Component } from "./components.ts";
import { allowedGitUrls, maxComponents, maxNodes } from "./env.ts";
import type { Env } from "./env.ts";
import { schedule } from "./queue.ts";
import { answer, refusal } from "./respond.ts";

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Whether a request carries a key in its header. A key that is not set, or is empty, is carried by no request. */
export async function carriesKey(request: Request, header: string, key: string | undefined): Promise<boolean> {
  const sent = request.headers.get(header);
  if (!key || !sent) return false;
  // Both are hashed first, so the comparison takes the same time whatever was sent.
  return crypto.subtle.timingSafeEqual(await sha256(key), await sha256(sent));
}

/**
 * Registers a node by its base URL, which is its identity (KTD8). The protocol accepts
 * one spelling and nothing rewrites it, so two strings never name one node.
 */
export async function registerNode(env: Env, body: unknown, now: number): Promise<Response> {
  if (conforms(REGISTER_NODE_REQUEST, body)) return refusal("bad-request");
  const { url } = body as Infer<typeof REGISTER_NODE_REQUEST>;
  const db = env.DB;
  // The cap is checked in the statement that adds the node, so two calls at once cannot pass it.
  const room = "(SELECT COUNT(*) FROM nodes) < ?2 AND NOT EXISTS (SELECT 1 FROM nodes WHERE url = ?1)";
  const [, added] = await db.batch([
    // Every view lists the registered nodes, so every version goes up. It runs first, under
    // the condition of the statement after it, so it goes up only when a node is added.
    db.prepare(`UPDATE components SET view_version = view_version + 1 WHERE ${room}`).bind(url, maxNodes(env)),
    db.prepare(`INSERT INTO nodes (url, registered_at) SELECT ?1, ?3 WHERE ${room}`).bind(url, maxNodes(env), now),
  ]);
  if (added?.meta.changes === 1) return answer({ node: url });
  const held = await db.prepare("SELECT 1 FROM nodes WHERE url = ?").bind(url).first();
  return refusal(held ? "already-registered" : "limit-reached");
}

function statusOf({ component, state, import_error: importError }: Component): Response {
  return answer({ component, state, ...(importError === null ? {} : { importError }) });
}

/**
 * Starts a failed component over, under the Git URL and branch it is stored with. Its
 * import and the time it has count from now. The records that were rejected because the
 * component had failed are dropped, so each node's next sync reads them again.
 */
async function startOver(env: Env, { component, url, branch }: Component, now: number): Promise<void> {
  const db = env.DB;
  // Both statements hold only for a component that is still failed, so of two calls at once one starts it over.
  const failed = "component = ?1 AND state = 'failed' AND url = ?2 AND branch = ?3";
  await db.batch([
    // It runs first, under the condition of the statement after it, which ends that condition.
    db.prepare(`DELETE FROM records WHERE component = ?1 AND state = 'rejected' AND reason = 'unknown-component' AND EXISTS (SELECT 1 FROM components WHERE ${failed})`).bind(component, url, branch),
    db
      .prepare(
        `UPDATE components SET state = 'importing', import_error = NULL, import_started_at = NULL, registered_at = ?4, view_version = view_version + 1 WHERE ${failed}`,
      )
      .bind(component, url, branch, now),
  ]);
}

/**
 * Registers a component with its Git URL, branch and commit (KTD12). The import runs
 * from the queue. A component that is registered already answers with its state, and
 * one that failed is started over when the request names the URL and branch it has.
 */
export async function registerComponent(env: Env, body: unknown, now: number): Promise<Response> {
  if (conforms(REGISTER_COMPONENT_REQUEST, body)) return refusal("bad-request");
  const { url, branch, commit } = body as Infer<typeof REGISTER_COMPONENT_REQUEST>;
  if (!allowedGitUrls(env).includes(url)) return refusal("not-allowed");
  let held = await componentOf(env, commit);
  if (!held) {
    await env.DB.prepare(
      "INSERT INTO components (component, url, branch, state, registered_at) SELECT ?1, ?2, ?3, 'importing', ?4 WHERE (SELECT COUNT(*) FROM components) < ?5 ON CONFLICT (component) DO NOTHING",
    )
      .bind(commit, url, branch, now, maxComponents(env))
      .run();
    held = await componentOf(env, commit);
    if (!held) return refusal("limit-reached");
  } else if (held.state === "failed" && held.url === url && held.branch === branch) {
    // A request that names another URL or branch for the commit starts nothing, and is told the state.
    await startOver(env, held, now);
    held = (await componentOf(env, commit)) ?? held;
  }
  // Asked for a component that is importing: one that was just registered or started
  // over, or one that still imports, so a look that was lost is made up for.
  if (held.state === "importing") await env.SYNC.send({ kind: "component", component: commit });
  return statusOf(held);
}

/**
 * Drops every record and has every node read again (R12). A claim first seen in that
 * rebuild counts as expired (KTD13), and every patch commit is checked again. Nodes and
 * components stay registered.
 */
export async function reset(env: Env, now: number): Promise<Response> {
  const db = env.DB;
  const nodes = await db.prepare("SELECT url FROM nodes").all<{ url: string }>();
  await db.batch([
    // A view's version also counts the claims that have passed their time, and those go.
    // So the version moves on by more than they added, and never back.
    db.prepare(
      "UPDATE components SET view_version = view_version + 1 + (SELECT COUNT(*) FROM records WHERE records.component = components.component AND records.type = 'claim')",
    ),
    db.prepare("DELETE FROM records"),
    // What the index computed for a patch record goes with the record.
    db.prepare("DELETE FROM patches"),
    // A sync that runs now started before the reset, so it reports nothing as processed.
    db.prepare("UPDATE nodes SET processed = NULL, rebuilding = 1, queued_at = NULL, syncs = syncs + 1"),
  ]);
  await schedule(
    env,
    nodes.results.map(({ url }) => url),
    now,
    0,
  );
  return answer({});
}
