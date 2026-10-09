// The team node Worker (R6, R7): storage with a small HTTP contract (KTD7). It holds a
// team's repos in the team's own Artifacts namespace, serves its records and patch
// commits, and validates none of them.

import { admin } from "./admin.ts";
import { TEAM_REPO, forkOf, issueToken, open } from "./artifacts.ts";
import type { Store } from "./artifacts.ts";
import {
  PATHS,
  RECORDS_FOLDER,
  TEAM_BRANCH,
  blobQuery,
  fileQuery,
  listingQuery,
  patchQuery,
  readTokenQuery,
  refusal,
} from "./contract.ts";
import type { NodeListing, NodePatch } from "./contract.ts";
import type { Env } from "./env.ts";
import { changedFiles, filesUnder } from "./tree.ts";

// The Workflow that a push starts and the object that keeps a fork's read token. The
// Wrangler config names both classes.
export { ReadTokens } from "./read-tokens.ts";
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

/**
 * A read token for the fork of a component, for anyone who asks. The route takes a
 * component and nothing else, so it can name neither the team repo nor a write scope.
 * The node keeps one token per fork and serves that one until shortly before it expires,
 * so this route cannot mint without bound or spend the namespace's request budget (KTD7).
 */
async function readToken(env: Env, context: ExecutionContext, component: string): Promise<Response> {
  const name = forkOf(component);
  const kept = env.READ_TOKENS.get(env.READ_TOKENS.idFromName(name));
  const asked = kept.tokenOr(async () => {
    const fork = await open(env.ARTIFACTS, name);
    return typeof fork === "string" ? fork : issueToken(fork, "read");
  });
  // The object calls back into this request to mint. A client that goes away must not
  // take the mint with it: the requests waiting on the object would fail, and a token
  // made but not yet kept would be lost. So this request lives until the object answers.
  context.waitUntil(asked.then(noop, noop));
  const token = await asked;
  return typeof token === "string" ? refusal(token) : Response.json(token);
}

function noop(): void {}

async function serve(path: string, url: URL, env: Env, context: ExecutionContext): Promise<Response> {
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
    return query ? readToken(env, context, query.component) : refusal("bad-request");
  }
  return refusal("not-found");
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // A route path is relative to the node's base URL, and a deployed node lives at the root of its host.
    const path = url.pathname.slice(1);
    if (path.startsWith("admin/")) return admin(request, path, env);
    if (request.method !== "GET") return refusal("not-found");
    return serve(path, url, env, context);
  },
} satisfies ExportedHandler<Env>;
