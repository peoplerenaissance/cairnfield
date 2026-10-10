// The seam in front of the Artifacts binding (KTD29). The index calls only what is named
// here, so a test can put an in-memory fake in its place. The shapes are the binding
// types bundled with Wrangler, which are the source of truth for the binding.

/**
 * One component copy. The index only reads it and revokes tokens on it. Every read names
 * a full commit, tree or blob hash, never a branch and never `HEAD` (KTD36).
 */
export type Repo = Pick<ArtifactsRepo, "readCommit" | "readTree" | "readBlob" | "listTokens" | "revokeToken">;

/** The calls the index makes on its namespace. */
export interface Store {
  get(name: string): Promise<Repo>;
  import: Artifacts["import"];
}

/** The index's own pinned import of a component. A component is its full commit hash (R8). */
export const copyOf = (component: string): string => `copy-${component}`;

/** Why a copy cannot be read: there is none, or its import still runs. */
export type Unavailable = "not-found" | "not-ready";

const IN_PROGRESS: readonly unknown[] = ["CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS"];

/** The code of an error the binding threw, or nothing for any other error. */
export function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * Gets a repo. `get()` throws until an import has finished, and that is the only sign of
 * it (KTD36).
 */
export async function open(store: Store, name: string): Promise<Repo | Unavailable> {
  try {
    return await store.get(name);
  } catch (error) {
    const code = codeOf(error);
    if (code === "NOT_FOUND") return "not-found";
    if (IN_PROGRESS.includes(code)) return "not-ready";
    throw error;
  }
}
