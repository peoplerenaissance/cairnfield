// An in-memory stand-in for the Artifacts binding (KTD29). No test calls the live service.
//
// It copies the behavior of the service that the index depends on (Appendix B and M of
// the plan):
// - an import returns at once and finishes later, and `get()` throws until then;
// - an import returns a token with write scope that lives 24 hours;
// - an import copies the one branch it was given, and a commit that branch does not
//   reach is not in the copy.
//
// A blob is named by its Git hash, so the index can hold content to it. A tree and a
// commit are named by a hash of their own: the index only reports what the binding gives.

import { gitBlobHash, sha256Hex } from "@cairnfield/protocol";
import type { Repo, Store } from "../src/artifacts.ts";

const DAY = 86_400;

/** The files of one commit: each path with its content, and its mode when it is not a plain file. */
export interface Files {
  readonly [path: string]: string | { readonly content: string; readonly mode: string };
}

type Stored =
  | { readonly kind: "blob"; readonly content: string }
  | { readonly kind: "tree"; readonly entries: readonly ArtifactsTreeEntry[] }
  | { readonly kind: "commit"; readonly meta: ArtifactsCommitMetadata };

type Objects = Map<string, Stored>;

const encoder = new TextEncoder();

async function hashOf(kind: "tree" | "commit", body: string): Promise<string> {
  return (await sha256Hex(encoder.encode(`${kind}\0${body}`))).slice(0, 40);
}

/** The Git hash of a file with this content. */
export const blobHash = (content: string): Promise<string> => gitBlobHash(encoder.encode(content));

const ENTRY_TYPES: { readonly [mode: string]: ArtifactsTreeEntryType } = {
  "40000": "tree",
  "100644": "blob",
  "100755": "exec",
  "120000": "symlink",
  "160000": "gitlink",
};

function entry(name: string, mode: string, hash: string): ArtifactsTreeEntry {
  const type = ENTRY_TYPES[mode];
  if (type === undefined) throw new Error(`the fake knows no mode ${mode}`);
  return { name, mode, hash, type };
}

async function writeTree(objects: Objects, files: Files): Promise<string> {
  const entries: ArtifactsTreeEntry[] = [];
  const folders = new Map<string, { [path: string]: Files[string] }>();
  for (const [path, file] of Object.entries(files)) {
    const slash = path.indexOf("/");
    if (slash >= 0) {
      const name = path.slice(0, slash);
      const folder = folders.get(name) ?? {};
      folder[path.slice(slash + 1)] = file;
      folders.set(name, folder);
      continue;
    }
    const { content, mode } = typeof file === "string" ? { content: file, mode: "100644" } : file;
    const hash = await blobHash(content);
    objects.set(hash, { kind: "blob", content });
    entries.push(entry(path, mode, hash));
  }
  for (const [name, folder] of folders) entries.push(entry(name, "40000", await writeTree(objects, folder)));
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  const hash = await hashOf("tree", JSON.stringify(entries));
  objects.set(hash, { kind: "tree", entries });
  return hash;
}

function copyReachable(from: Objects, to: Objects, hash: string): void {
  const object = from.get(hash);
  if (!object || to.has(hash)) return;
  to.set(hash, object);
  if (object.kind === "commit") {
    for (const next of [object.meta.treeHash, ...object.meta.parents]) copyReachable(from, to, next);
  } else if (object.kind === "tree") {
    for (const child of object.entries) copyReachable(from, to, child.hash);
  }
}

function failure(code: ArtifactsErrorCode): ArtifactsError {
  return Object.assign(new Error(code), { name: "ArtifactsError" as const, code, numericCode: 0 });
}

interface IssuedToken {
  readonly id: string;
  readonly scope: "read" | "write";
  readonly createdAt: number;
  readonly expiresAt: number;
  revoked: boolean;
}

/** A token as a test sees it. */
export interface SeenToken {
  readonly scope: "read" | "write";
  readonly state: "active" | "expired" | "revoked";
}

class RepoState {
  importing = true;
  readonly objects: Objects = new Map();
  readonly tokens: IssuedToken[] = [];
  /** How many times the index read a blob of this repo. */
  blobReads = 0;
  /** How many times the index read a tree of this repo. */
  treeReads = 0;
}

/** A public repo on another host, for `import` to copy: its branches and what they reach. */
class Upstream {
  readonly branches = new Map<string, string>();
  readonly objects: Objects = new Map();
}

const stateOf = (token: IssuedToken): SeenToken["state"] =>
  token.revoked ? "revoked" : token.expiresAt <= Date.now() ? "expired" : "active";

export class FakeArtifacts implements Store {
  /** Every `import` call, as the index made it. */
  readonly imports: {
    readonly name: string;
    readonly url: string;
    readonly branch: string | undefined;
    readonly depth: number | undefined;
  }[] = [];
  /** Set by a test: every import fails with this code, as when Artifacts refuses the remote. */
  importFailure: ArtifactsErrorCode | undefined;
  readonly #repos = new Map<string, RepoState>();
  readonly #upstreams = new Map<string, Upstream>();
  #serial = 0;

  // The binding.

  async get(name: string): Promise<Repo> {
    const state = this.#repos.get(name);
    if (!state) throw failure("NOT_FOUND");
    if (state.importing) throw failure("IMPORT_IN_PROGRESS");
    return this.#handle(state);
  }

  async import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string };
  }): Promise<ArtifactsCreateRepoResult> {
    const { source, target } = params;
    this.imports.push({ name: target.name, url: source.url, branch: source.branch, depth: source.depth });
    if (this.#repos.has(target.name)) throw failure("ALREADY_EXISTS");
    if (this.importFailure !== undefined) throw failure(this.importFailure);
    const upstream = this.#upstreams.get(source.url);
    const head = source.branch === undefined ? undefined : upstream?.branches.get(source.branch);
    if (!upstream || head === undefined) throw failure("NOT_FOUND");
    const state = new RepoState();
    copyReachable(upstream.objects, state.objects, head);
    this.#repos.set(target.name, state);
    // The token Artifacts returns by itself: write scope, 24 hours.
    const createdAt = Date.now();
    const serial = ++this.#serial;
    state.tokens.push({ id: `token-${serial}`, scope: "write", createdAt, expiresAt: createdAt + DAY * 1000, revoked: false });
    return {
      id: `repo-${target.name}`,
      name: target.name,
      description: null,
      defaultBranch: "main",
      remote: `https://0123456789abcdef0123456789abcdef.artifacts.example/git/index/${target.name}.git`,
      token: `art_v2_${serial.toString(16).padStart(40, "0")}?expires=${Math.floor(createdAt / 1000) + DAY}`,
    };
  }

  // What a test does from outside the index.

  /**
   * A push to a public repo on another host: one commit on a branch that holds exactly
   * these files, on top of the branch's last commit. Returns the commit.
   */
  async host(url: string, branch: string, files: Files): Promise<string> {
    const upstream = this.#upstreams.get(url) ?? new Upstream();
    this.#upstreams.set(url, upstream);
    const treeHash = await writeTree(upstream.objects, files);
    const before = upstream.branches.get(branch);
    const parents = before === undefined ? [] : [before];
    const at = 1_760_000_000 + this.#serial++;
    const person = { name: "A test", email: "test@fellbeck-tools.example" };
    const hash = await hashOf("commit", JSON.stringify({ treeHash, parents, at }));
    const meta = { hash, treeHash, message: "push", author: person, committer: person, parents };
    upstream.objects.set(hash, { kind: "commit", meta: { ...meta, authoredAt: at, committedAt: at } });
    upstream.branches.set(branch, hash);
    return hash;
  }

  /** Every import in progress finishes. */
  finish(): void {
    for (const state of this.#repos.values()) state.importing = false;
  }

  /** The repos of the namespace, by name. */
  repos(): string[] {
    return [...this.#repos.keys()];
  }

  /** Every token of a repo. */
  tokens(repo: string): SeenToken[] {
    return this.#state(repo).tokens.map((token) => ({ scope: token.scope, state: stateOf(token) }));
  }

  /** How many blobs and trees the index has read from a repo. */
  reads(repo: string): { readonly blobs: number; readonly trees: number } {
    const state = this.#state(repo);
    return { blobs: state.blobReads, trees: state.treeReads };
  }

  #state(repo: string): RepoState {
    const state = this.#repos.get(repo);
    if (!state) throw new Error(`the fake has no repo ${repo}`);
    return state;
  }

  #handle(state: RepoState): Repo {
    return {
      listTokens: async () => ({
        tokens: state.tokens.map((token) => ({
          id: token.id,
          scope: token.scope,
          state: stateOf(token),
          createdAt: new Date(token.createdAt).toISOString(),
          expiresAt: new Date(token.expiresAt).toISOString(),
        })),
        total: state.tokens.length,
      }),
      revokeToken: async (tokenOrId) => {
        const token = state.tokens.find((held) => held.id === tokenOrId);
        if (!token) return false;
        token.revoked = true;
        return true;
      },
      readBlob: async (hash) => {
        state.blobReads += 1;
        const object = state.objects.get(hash);
        return object?.kind === "blob" ? new Blob([object.content]) : null;
      },
      readTree: async (hash) => {
        state.treeReads += 1;
        const object = state.objects.get(hash);
        return object?.kind === "tree" ? object.entries.map((child) => ({ ...child })) : null;
      },
      readCommit: async (hash) => {
        const object = state.objects.get(hash);
        return object?.kind === "commit" ? object.meta : null;
      },
    };
  }
}
