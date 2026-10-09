// The admin routes (KTD10). The command calls them with the node's key to import a
// component copy, create the team repo and a fork, and get repo tokens.

import { LONGEST_TOKEN_LIFE, TEAM_BRANCH, TEAM_REPO, codeOf, copyOf, forkOf, issueToken, open } from "./artifacts.ts";
import type { Repo, Store, Unavailable } from "./artifacts.ts";
import { ADMIN_KEY_HEADER, PATHS, forkRequest, importRequest, refusal, tokenRequest } from "./contract.ts";
import type { AdminRepo, ForkRequest, ImportRequest, NodeError, TokenRequest } from "./contract.ts";
import type { Env } from "./env.ts";

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Whether a request carries the node's admin key. A node with no key set refuses every call. */
async function carriesKey(request: Request, env: Env): Promise<boolean> {
  const sent = request.headers.get(ADMIN_KEY_HEADER);
  if (!env.ADMIN_KEY || sent === null) return false;
  // Both are hashed first, so the comparison takes the same time whatever was sent.
  return crypto.subtle.timingSafeEqual(await sha256(env.ADMIN_KEY), await sha256(sent));
}

type Role = TokenRequest["repo"];

/**
 * Revokes every token of a repo that the node did not issue. Artifacts returns a token
 * from each create, import and fork, with write scope and a life of 24 hours, and no
 * call can revoke it while the import or the fork runs. So every admin route does this
 * before it uses a repo that is ready. A token the node issues lives
 * under an hour, and on a copy it only reads. So a token that lives longer, or that
 * writes to a copy, is not the node's, and revoking it is what keeps R8 and the limit of
 * one hour true (KTD10).
 */
async function revokeOtherTokens(repo: Repo, role: Role): Promise<void> {
  const { tokens } = await repo.listTokens();
  for (const token of tokens) {
    if (token.state !== "active") continue;
    const life = (Date.parse(token.expiresAt) - Date.parse(token.createdAt)) / 1000;
    if (life > LONGEST_TOKEN_LIFE || (role === "copy" && token.scope === "write")) await repo.revokeToken(token.id);
  }
}

/**
 * Reports a repo that a create, an import or a fork has started. A copy or a fork is
 * ready when `get()` no longer throws and `readCommit` returns the pinned commit, which
 * is also the check that it holds that commit (KTD36).
 */
async function report(repo: Repo | Unavailable, name: string, role: Role, pinned?: string): Promise<Response> {
  let ready = false;
  if (typeof repo !== "string") {
    await revokeOtherTokens(repo, role);
    ready = pinned === undefined || (await repo.readCommit(pinned)) !== null;
  }
  return Response.json({ repo: name, ready } satisfies AdminRepo);
}

// Each of the three routes below may be called again and again. The first call starts
// the work, and every call says whether the repo is ready. The token that Artifacts
// returns from the first call is dropped where it arrives: it is never returned, stored
// or logged.

// What the binding throws when another call made the repo, or is making it, between this
// call's look for the repo and its own start. The repo is started either way.
const STARTED_BEFORE: readonly unknown[] = ["ALREADY_EXISTS", "FORK_IN_PROGRESS"];

/** Waits for a call that starts a repo. A repo that another call started first is no failure. */
async function started(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    if (!STARTED_BEFORE.includes(codeOf(error))) throw error;
  }
}

// The codes with which Artifacts refuses an import, and what the node answers for each.
// The contract has no code of its own for a failed import. An upstream that cannot be
// reached is worth another try, so it reads as not ready.
const IMPORT_REFUSALS: ReadonlyMap<unknown, NodeError> = new Map([
  ["INVALID_URL", "bad-request"],
  ["REMOTE_AUTH_REQUIRED", "refused"],
  ["NOT_FOUND", "not-found"],
  ["UPSTREAM_UNAVAILABLE", "not-ready"],
  ["MEMORY_LIMIT", "refused"],
]);

async function createTeamRepo(store: Store): Promise<Response> {
  let team = await open(store, TEAM_REPO);
  if (team === "not-found") {
    await started(store.create(TEAM_REPO, { setDefaultBranch: TEAM_BRANCH }));
    team = await open(store, TEAM_REPO);
  }
  return report(team, TEAM_REPO, "team");
}

async function importCopy(store: Store, { url, branch, commit }: ImportRequest): Promise<Response> {
  const name = copyOf(commit);
  let copy = await open(store, name);
  if (copy === "not-found") {
    // The branch is named and no depth is set, so every commit the branch reaches can be pinned (KTD12).
    try {
      await started(store.import({ source: { url, branch }, target: { name } }));
    } catch (error) {
      const refused = IMPORT_REFUSALS.get(codeOf(error));
      if (refused === undefined) throw error;
      return refusal(refused);
    }
    copy = await open(store, name);
  }
  return report(copy, name, "copy", commit);
}

async function createFork(env: Env, { component }: ForkRequest): Promise<Response> {
  const store = env.ARTIFACTS;
  const name = forkOf(component);
  let fork = await open(store, name);
  if (fork === "not-found") {
    const copy = await open(store, copyOf(component));
    if (typeof copy === "string") return refusal(copy);
    // The import call that started the copy may never have been made again, so the token
    // Artifacts returned for the copy may still be active.
    await revokeOtherTokens(copy, "copy");
    // A fork copies only the default branch unless told otherwise, and a copy can report
    // a default branch it does not have (KTD36).
    await started(copy.fork(name, { defaultBranchOnly: false }));
    // A read token kept under this name belongs to a fork that was deleted, and died with it.
    await env.READ_TOKENS.delete(name);
    fork = await open(store, name);
  }
  return report(fork, name, "fork", component);
}

async function repoToken(store: Store, wanted: TokenRequest): Promise<Response> {
  // No route returns a write token for a component copy (R8).
  if (wanted.repo === "copy" && wanted.scope === "write") return refusal("refused");
  const name =
    wanted.repo === "team" ? TEAM_REPO : wanted.repo === "copy" ? copyOf(wanted.component) : forkOf(wanted.component);
  const repo = await open(store, name);
  if (typeof repo === "string") return refusal(repo);
  // No token of the node's own is issued beside one the node did not issue.
  await revokeOtherTokens(repo, wanted.repo);
  return Response.json(await issueToken(repo, wanted.scope));
}

/** Answers a request to an admin route. */
export async function admin(request: Request, path: string, env: Env): Promise<Response> {
  if (!(await carriesKey(request, env))) return refusal("unauthorized");
  if (request.method !== "POST") return refusal("not-found");
  const store = env.ARTIFACTS;
  if (path === PATHS.createTeamRepo) return createTeamRepo(store);
  // A body that is not JSON reads as nothing, which no route accepts.
  const body: unknown = await request.json().catch(() => undefined);
  if (path === PATHS.importCopy) {
    const wanted = importRequest(body);
    return wanted ? importCopy(store, wanted) : refusal("bad-request");
  }
  if (path === PATHS.createFork) {
    const wanted = forkRequest(body);
    return wanted ? createFork(env, wanted) : refusal("bad-request");
  }
  if (path === PATHS.repoToken) {
    const wanted = tokenRequest(body);
    return wanted ? repoToken(store, wanted) : refusal("bad-request");
  }
  return refusal("not-found");
}
