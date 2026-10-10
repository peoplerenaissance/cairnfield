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
import { bump } from "./records.ts";
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
  const [added] = await db.batch([
    // The cap is checked in the statement that adds the node, so two calls at once cannot pass it.
    db
      .prepare("INSERT INTO nodes (url, registered_at) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM nodes) < ?3 AND NOT EXISTS (SELECT 1 FROM nodes WHERE url = ?1)")
      .bind(url, now, maxNodes(env)),
    // Every view lists the registered nodes.
    bump(db),
  ]);
  if (added?.meta.changes === 1) return answer({ node: url });
  const held = await db.prepare("SELECT 1 FROM nodes WHERE url = ?").bind(url).first();
  return refusal(held ? "already-registered" : "limit-reached");
}

function statusOf({ component, state, import_error: importError }: Component): Response {
  return answer({ component, state, ...(importError === null ? {} : { importError }) });
}

/**
 * Registers a component with its Git URL, branch and commit (KTD12). The import runs
 * from the queue. A component that is registered already answers with its state.
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
  }
  // Asked again for a component that is still importing, so a look that was lost is made up for.
  if (held.state === "importing") await env.SYNC.send({ kind: "component", component: commit });
  return statusOf(held);
}

/**
 * Drops every record and has every node read again (R12). A claim first seen in that
 * rebuild counts as expired (KTD13). Nodes and components stay registered.
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
