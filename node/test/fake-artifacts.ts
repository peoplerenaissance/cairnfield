// An in-memory stand-in for the Artifacts binding (KTD29). No test calls the live service.
//
// It copies the behavior of the service that the node depends on (Appendix B and M of
// the plan):
// - an import and a fork return at once and finish later, and `get()` throws until then;
// - every create, import and fork returns a token with write scope that lives 24 hours;
// - an imported repo reports `main` as its default branch, whatever branch it holds;
// - a fork copies only the default branch unless `defaultBranchOnly` is false;
// - `log()` reads `HEAD` unless told otherwise, and gives an empty list for a ref it
//   cannot resolve.
//
// Objects are named by a hash of their content, as in Git. The hash is not Git's own:
// the node never computes one, it only reports what the binding gives it.

import type { Store } from "../src/artifacts.ts";

export const NAMESPACE = "team-a";
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

async function hashOf(kind: Stored["kind"], body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${kind}\0${body}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 40);
}

/** The hash this store gives to a file with this content. */
export const blobHash = (content: string): Promise<string> => hashOf("blob", content);

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
  readonly plaintext: string;
  readonly scope: "read" | "write";
  readonly createdAt: number;
  readonly expiresAt: number;
  revoked: boolean;
  /** The arguments of the `createToken` call. A token that Artifacts returned by itself has neither. */
  readonly asked: { readonly scope: "read" | "write" | undefined; readonly ttl: number | undefined };
}

/** A token as a test sees it. */
export interface SeenToken {
  readonly plaintext: string;
  readonly scope: "read" | "write";
  readonly state: "active" | "expired" | "revoked";
  /** When the token expires, in Unix seconds. */
  readonly expires: number;
  readonly asked: IssuedToken["asked"];
}

class RepoState {
  status: "ready" | "importing" | "forking" = "ready";
  readonly refs = new Map<string, string>();
  readonly objects: Objects = new Map();
  readonly tokens: IssuedToken[] = [];
  readonly treeReads: string[] = [];
  readonly logRefs: (string | undefined)[] = [];
  readonly createdAt = new Date().toISOString();
  readonly name: string;
  readonly defaultBranch: string;
  readonly source: string | null;

  constructor(name: string, defaultBranch: string, source: string | null) {
    this.name = name;
    this.defaultBranch = defaultBranch;
    this.source = source;
  }

  get remote(): string {
    // The form of an Artifacts remote, on an invented host.
    return `https://0123456789abcdef0123456789abcdef.artifacts.example/git/${NAMESPACE}/${this.name}.git`;
  }

  /** The commit a branch, a full commit hash or `HEAD` names. */
  resolve(ref: string): ArtifactsCommitMetadata | undefined {
    const hash = ref === "HEAD" ? this.refs.get(this.defaultBranch) : (this.refs.get(ref) ?? ref);
    const object = hash === undefined ? undefined : this.objects.get(hash);
    return object?.kind === "commit" ? object.meta : undefined;
  }
}

const stateOf = (token: IssuedToken): SeenToken["state"] =>
  token.revoked ? "revoked" : token.expiresAt <= Date.now() ? "expired" : "active";

export class FakeArtifacts implements Store {
  /** Every `create` call, as the node made it. */
  readonly creates: { readonly name: string; readonly setDefaultBranch: string | undefined }[] = [];
  /** Every `import` call, as the node made it. */
  readonly imports: {
    readonly name: string;
    readonly url: string;
    readonly branch: string | undefined;
    readonly depth: number | undefined;
  }[] = [];
  /** Every `fork` call, as the node made it. */
  readonly forks: { readonly from: string; readonly name: string; readonly defaultBranchOnly: boolean | undefined }[] =
    [];
  readonly #repos = new Map<string, RepoState>();
  readonly #upstreams = new Map<string, RepoState>();
  #serial = 0;

  // The binding.

  async create(name: string, opts?: { setDefaultBranch?: string }): Promise<ArtifactsCreateRepoResult> {
    this.creates.push({ name, setDefaultBranch: opts?.setDefaultBranch });
    if (this.#repos.has(name)) throw failure("ALREADY_EXISTS");
    const state = new RepoState(name, opts?.setDefaultBranch ?? "main", null);
    this.#repos.set(name, state);
    return this.#created(state);
  }

  async get(name: string): Promise<ArtifactsRepo> {
    const state = this.#repos.get(name);
    if (!state) throw failure("NOT_FOUND");
    if (state.status === "importing") throw failure("IMPORT_IN_PROGRESS");
    if (state.status === "forking") throw failure("FORK_IN_PROGRESS");
    return this.#handle(state);
  }

  async import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string };
  }): Promise<ArtifactsCreateRepoResult> {
    const { source, target } = params;
    this.imports.push({ name: target.name, url: source.url, branch: source.branch, depth: source.depth });
    if (this.#repos.has(target.name)) throw failure("ALREADY_EXISTS");
    const upstream = this.#upstreams.get(source.url);
    const branch = source.branch ?? upstream?.defaultBranch;
    const head = branch === undefined ? undefined : upstream?.refs.get(branch);
    if (!upstream || branch === undefined || head === undefined) throw failure("NOT_FOUND");
    // The copy reports `main`, though it holds only the branch it was given.
    const state = new RepoState(target.name, "main", `git:${source.url}`);
    state.status = "importing";
    state.refs.set(branch, head);
    copyReachable(upstream.objects, state.objects, head);
    this.#repos.set(target.name, state);
    return this.#created(state);
  }

  // What a test does from outside the node.

  /**
   * A push over Git: one commit that holds exactly these files. Its parent is `parent`,
   * or the branch's last commit. `target` is a repo of the namespace, or the URL of a
   * repo on another host for `import` to copy.
   */
  async push(target: string, branch: string, files: Files, parent?: string): Promise<string> {
    const state = this.#pushable(target);
    const before = parent ?? state.refs.get(branch);
    const treeHash = await writeTree(state.objects, files);
    const person = { name: "A test", email: "test@team-a.example" };
    const at = 1_760_000_000 + this.#serial++;
    const parents = before === undefined ? [] : [before];
    const hash = await hashOf("commit", JSON.stringify({ treeHash, parents, at }));
    const meta = { hash, treeHash, message: "push", author: person, committer: person, parents };
    state.objects.set(hash, { kind: "commit", meta: { ...meta, authoredAt: at, committedAt: at } });
    state.refs.set(branch, hash);
    return hash;
  }

  /** A repo is deleted from outside the node, as a reset of the demo does. Its tokens go with it. */
  remove(repo: string): void {
    this.#state(repo);
    this.#repos.delete(repo);
  }

  /** Every import and fork in progress finishes. */
  finish(): void {
    for (const state of this.#repos.values()) state.status = "ready";
  }

  /** The repos of the namespace, by name. */
  repos(): string[] {
    return [...this.#repos.keys()];
  }

  /** Every token of a repo, whoever asked for it. */
  tokens(repo: string): SeenToken[] {
    return this.#state(repo).tokens.map((token) => ({
      plaintext: token.plaintext,
      scope: token.scope,
      state: stateOf(token),
      expires: Math.floor(token.expiresAt / 1000),
      asked: token.asked,
    }));
  }

  /** The remote of a repo. */
  remote(repo: string): string {
    return this.#state(repo).remote;
  }

  /** Whether a repo holds an object. */
  holds(repo: string, hash: string): boolean {
    return this.#state(repo).objects.has(hash);
  }

  /** Every tree hash the node has read from a repo. */
  treeReads(repo: string): readonly string[] {
    return this.#state(repo).treeReads;
  }

  /** The ref of every `log` call the node has made on a repo. A call that names none reads `HEAD`. */
  logRefs(repo: string): readonly (string | undefined)[] {
    return this.#state(repo).logRefs;
  }

  #state(repo: string): RepoState {
    const state = this.#repos.get(repo);
    if (!state) throw new Error(`the fake has no repo ${repo}`);
    return state;
  }

  #pushable(target: string): RepoState {
    if (!target.startsWith("https://")) return this.#state(target);
    const upstream = this.#upstreams.get(target) ?? new RepoState(target, "main", null);
    this.#upstreams.set(target, upstream);
    return upstream;
  }

  #issue(state: RepoState, scope: "read" | "write" | undefined, ttl: number | undefined): IssuedToken {
    const serial = ++this.#serial;
    const createdAt = Date.now();
    const expiresAt = createdAt + (ttl ?? DAY) * 1000;
    const token: IssuedToken = {
      id: `token-${serial}`,
      // The form the service issues: a prefix, hexadecimal characters and the expiry.
      plaintext: `art_v2_${serial.toString(16).padStart(40, "0")}?expires=${Math.floor(expiresAt / 1000)}`,
      scope: scope ?? "write",
      createdAt,
      expiresAt,
      revoked: false,
      asked: { scope, ttl },
    };
    state.tokens.push(token);
    return token;
  }

  #created(state: RepoState): ArtifactsCreateRepoResult {
    const token = this.#issue(state, undefined, undefined);
    return {
      id: `repo-${state.name}`,
      name: state.name,
      description: null,
      defaultBranch: state.defaultBranch,
      remote: state.remote,
      token: token.plaintext,
    };
  }

  #handle(state: RepoState): ArtifactsRepo {
    return {
      createToken: async (scope, ttl) => {
        const token = this.#issue(state, scope, ttl);
        return {
          id: token.id,
          plaintext: token.plaintext,
          scope: token.scope,
          expiresAt: new Date(token.expiresAt).toISOString(),
        };
      },
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
        const token = state.tokens.find((held) => held.id === tokenOrId || held.plaintext === tokenOrId);
        if (!token) return false;
        token.revoked = true;
        return true;
      },
      info: async () => ({
        id: `repo-${state.name}`,
        name: state.name,
        description: null,
        defaultBranch: state.defaultBranch,
        createdAt: state.createdAt,
        updatedAt: state.createdAt,
        lastPushAt: null,
        source: state.source,
        readOnly: false,
        remote: state.remote,
      }),
      readBlob: async (hash) => {
        const object = state.objects.get(hash);
        return object?.kind === "blob" ? new Blob([object.content]) : null;
      },
      readTree: async (hash) => {
        state.treeReads.push(hash);
        const object = state.objects.get(hash);
        return object?.kind === "tree" ? object.entries.map((child) => ({ ...child })) : null;
      },
      readCommit: async (hash) => {
        const object = state.objects.get(hash);
        return object?.kind === "commit" ? object.meta : null;
      },
      readFile: async ({ ref, path }) => {
        let hash = state.resolve(ref)?.treeHash;
        for (const part of path.split("/")) {
          const tree = hash === undefined ? undefined : state.objects.get(hash);
          hash = tree?.kind === "tree" ? tree.entries.find((child) => child.name === part)?.hash : undefined;
        }
        const object = hash === undefined ? undefined : state.objects.get(hash);
        // The service picks a content type that is safe in a browser, whatever the file is.
        return object?.kind === "blob" ? new Blob([object.content], { type: "text/plain" }) : null;
      },
      log: async (opts) => {
        state.logRefs.push(opts?.ref);
        const commits: ArtifactsCommitMetadata[] = [];
        let commit = state.resolve(opts?.ref ?? "HEAD");
        while (commit && commits.length < (opts?.limit ?? 50)) {
          commits.push(commit);
          const [first] = commit.parents;
          commit = first === undefined ? undefined : state.resolve(first);
        }
        return commits;
      },
      fork: async (name, opts) => {
        this.forks.push({ from: state.name, name, defaultBranchOnly: opts?.defaultBranchOnly });
        if (this.#repos.has(name)) throw failure("ALREADY_EXISTS");
        const fork = new RepoState(name, state.defaultBranch, `artifacts:${NAMESPACE}/${state.name}`);
        fork.status = "forking";
        for (const [branch, head] of state.refs) {
          if (opts?.defaultBranchOnly !== false && branch !== state.defaultBranch) continue;
          fork.refs.set(branch, head);
          copyReachable(state.objects, fork.objects, head);
        }
        this.#repos.set(name, fork);
        return this.#created(fork);
      },
      [Symbol.dispose]() {},
    };
  }
}
