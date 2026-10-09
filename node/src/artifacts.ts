// The seam in front of the Artifacts binding (KTD29). The node calls only what is named
// here, so a test can put an in-memory fake in its place. The shapes are the binding
// types bundled with Wrangler, which are the source of truth for the binding.

import type { RepoToken } from "./contract.ts";

/** The calls the node makes on a namespace. */
export type Store = Pick<Artifacts, "create" | "get" | "import">;
/** One repo. Every read names a branch or a full commit hash, never `HEAD` (KTD36). */
export type Repo = ArtifactsRepo;

// The repos of a node, by name. A component is its full commit hash (R8), so a copy and
// its fork carry that hash in their names.

/** The repo that holds the team's records. */
export const TEAM_REPO = "team";
/** The branch of the team repo that records are pushed to. It is set when the repo is created (KTD36). */
export const TEAM_BRANCH = "main";
/** The pinned import of a component. No write token is ever issued for it (R8). */
export const copyOf = (component: string): string => `copy-${component}`;
/** The team's fork of a component copy, which holds its patch commits (KTD4). */
export const forkOf = (component: string): string => `fork-${component}`;

/** The longest life a token may have, in seconds (KTD10). */
export const LONGEST_TOKEN_LIFE = 60 * 60;
// The life of every token the node hands out. It is set under the limit, so that a
// token of the node's own never reads as one that lives too long.
const TOKEN_LIFE = 50 * 60;

/**
 * Issues a token. Every token the node hands out comes from this call, which sets both
 * the scope and the lifetime: left out, they are write scope and 24 hours (KTD10).
 */
export async function issueToken(repo: Repo, scope: "read" | "write"): Promise<RepoToken> {
  const token = await repo.createToken(scope, TOKEN_LIFE);
  const { remote } = await repo.info();
  return { remote, token: token.plaintext, expires: Math.floor(Date.parse(token.expiresAt) / 1000) };
}

/** Why a repo cannot be read: there is none, or its create, import or fork still runs. */
export type Unavailable = "not-found" | "not-ready";

const IN_PROGRESS: readonly unknown[] = ["CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS"];

/**
 * Gets a repo. `get()` throws until an import or a fork has finished, and that is the
 * only sign of it: `list()` gives no status (KTD36).
 */
export async function open(store: Store, name: string): Promise<Repo | Unavailable> {
  try {
    return await store.get(name);
  } catch (error) {
    const code: unknown = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "NOT_FOUND") return "not-found";
    if (IN_PROGRESS.includes(code)) return "not-ready";
    throw error;
  }
}
