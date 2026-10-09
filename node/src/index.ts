// The team node Worker (R6, R7): storage with a small HTTP contract (KTD7). It holds a
// team's repos in the team's own Artifacts namespace, serves its records and patch
// commits, and validates none of them.

import { admin } from "./admin.ts";
import { TEAM_BRANCH, TEAM_REPO, forkOf, issueToken, open } from "./artifacts.ts";
import type { Store } from "./artifacts.ts";
import {
  PATHS,
  RECORDS_FOLDER,
  blobQuery,
  fileQuery,
  listingQuery,
  patchQuery,
  readTokenQuery,
  refusal,
} from "./contract.ts";
import type { NodeListing, NodePatch, RepoToken } from "./contract.ts";
import type { Env } from "./env.ts";
import { changedFiles, filesUnder } from "./tree.ts";

// The Workflow that a push starts. The Wrangler config names this class.
export { OnPush } from "./workflow.ts";

/** The head commit of the team repo with every file under its records folder. */
async function listing(store: Store): Promise<Response> {
  const team = await open(store, TEAM_REPO);
  if (typeof team === "string") return refusal(team);
  // The branch is named, because `log()` reads `HEAD` otherwise (KTD36).
  const [head] = await team.log({ ref: TEAM_BRANCH, limit: 1 });
  if (!head) return refusal("not-found");
  const root = (await team.readTree(head.treeHash)) ?? [];
  const folder = root.find((child) => child.name === RECORDS_FOLDER && child.type === "tree");
  const files = folder ? await filesUnder(team, folder.hash, `${RECORDS_FOLDER}/`) : [];
  const records = files.map(({ path, blob }) => ({ path, blob }));
  return Response.json({ head: head.hash, records } satisfies NodeListing);
}

/** A record file at a given commit. A record is immutable, so a commit names its content for good (KTD1). */
async function file(store: Store, commit: string, path: string): Promise<Response> {
  const team = await open(store, TEAM_REPO);
  if (typeof team === "string") return refusal(team);
  const content = await team.readFile({ ref: commit, path });
  if (!content) return refusal("not-found");
  return new Response(content, { headers: { "content-type": "application/json" } });
}

/** A patch commit's parent and changed files, from the fork of its component (KTD4). */
async function patch(store: Store, component: string, commit: string): Promise<Response> {
  const fork = await open(store, forkOf(component));
  if (typeof fork === "string") return refusal(fork);
  const patched = await fork.readCommit(commit);
  const [parent] = patched?.parents ?? [];
  const base = parent === undefined ? null : await fork.readCommit(parent);
  if (!patched || parent === undefined || !base) return refusal("not-found");
  const changes = await changedFiles(fork, base.treeHash, patched.treeHash);
  return Response.json({ commit, parent, changes } satisfies NodePatch);
}

/** The content of one blob of a fork. */
async function blob(store: Store, component: string, hash: string): Promise<Response> {
  const fork = await open(store, forkOf(component));
  if (typeof fork === "string") return refusal(fork);
  const content = await fork.readBlob(hash);
  if (!content) return refusal("not-found");
  return new Response(content, { headers: { "content-type": "application/octet-stream" } });
}

/** A kept read token leaves the store this many seconds before it expires, so a reader has time to use it. */
const KEPT_TOKEN_MARGIN = 5 * 60;

/**
 * A read token for the fork of a component, for anyone who asks. The route takes a
 * component and nothing else, so it can name neither the team repo nor a write scope.
 * The node keeps one token per fork and serves that one until shortly before it expires,
 * so this route cannot mint without bound or spend the namespace's request budget (KTD7).
 */
async function readToken(env: Env, component: string): Promise<Response> {
  const name = forkOf(component);
  const kept = await env.READ_TOKENS.get<RepoToken>(name, "json");
  if (kept) return Response.json(kept);
  const fork = await open(env.ARTIFACTS, name);
  if (typeof fork === "string") return refusal(fork);
  const token = await issueToken(fork, "read");
  // The store drops the entry by itself, and the next request mints the next token.
  await env.READ_TOKENS.put(name, JSON.stringify(token), { expiration: token.expires - KEPT_TOKEN_MARGIN });
  return Response.json(token);
}

async function serve(path: string, url: URL, env: Env): Promise<Response> {
  const store = env.ARTIFACTS;
  if (path === PATHS.listing) {
    return listingQuery(url) ? listing(store) : refusal("bad-request");
  }
  if (path === PATHS.file) {
    const query = fileQuery(url);
    return query ? file(store, query.commit, query.path) : refusal("bad-request");
  }
  if (path === PATHS.patch) {
    const query = patchQuery(url);
    return query ? patch(store, query.component, query.commit) : refusal("bad-request");
  }
  if (path === PATHS.blob) {
    const query = blobQuery(url);
    return query ? blob(store, query.component, query.blob) : refusal("bad-request");
  }
  if (path === PATHS.readToken) {
    const query = readTokenQuery(url);
    return query ? readToken(env, query.component) : refusal("bad-request");
  }
  return refusal("not-found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // A route path is relative to the node's base URL, and a deployed node lives at the root of its host.
    const path = url.pathname.slice(1);
    if (path.startsWith("admin/")) return admin(request, path, env);
    if (request.method !== "GET") return refusal("not-found");
    return serve(path, url, env);
  },
} satisfies ExportedHandler<Env>;
