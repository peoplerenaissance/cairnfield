// Team nodes for a test, behind `fetch`. A fake node serves the routes of the node
// contract that the index reads: its head with a listing of its record files, one file
// at a commit, a patch commit's parent and changed paths, one blob of a fork, and its
// count of a fork's fetches (KTD7). Like a real node, it validates nothing. Every host
// is invented.

import { DELETED_BLOB, DELETED_MODE, gitBlobHash, isGitHash, parseRecordPath, recordId, recordPath, sha256Hex } from "@cairnfield/protocol";
import type { AnyRecord } from "@cairnfield/protocol";
import { vi } from "vitest";

const encoder = new TextEncoder();

interface Held {
  readonly content: Uint8Array;
  /** The push that added the file. */
  readonly since: number;
}

/**
 * One path a patch commit changes, with its new content. The mode is given for a file
 * that is no plain file. A change with no content deletes the path.
 */
export interface Change {
  readonly path: string;
  readonly content?: string;
  readonly mode?: string;
}

/** A patch commit as the node serves it. */
interface PatchCommit {
  readonly parent: string;
  readonly changes: readonly { readonly path: string; readonly mode: string; readonly blob: string }[];
}

/** The node's fork of one component: its patch commits, and the content it serves for each blob. */
interface Fork {
  readonly commits: Map<string, PatchCommit>;
  readonly blobs: Map<string, Uint8Array>;
}

const notFound = (): Response => Response.json({ error: "not-found" }, { status: 404 });

export class FakeNode {
  readonly url: string;
  /** The commits of the team repo, oldest first. The last one is the head. */
  readonly commits: string[] = [];
  /** Every URL the index asked this node for. */
  readonly requests: string[] = [];
  /** Called each time the listing is read, once it is made and before it is returned. */
  onListing: (() => Promise<void>) | undefined;
  /** Called each time a record file is read, before it is returned. */
  onFile: (() => Promise<void>) | undefined;
  /** Called each time a count of fetches is read, once the answer is made and before it is returned. */
  onFetches: (() => Promise<void>) | undefined;
  /** Answers a request in place of the node, or throws as a network would. */
  respond: ((url: URL) => Response | undefined) | undefined;
  readonly #files = new Map<string, Held>();
  readonly #forks = new Map<string, Fork>();
  /** The fetches the node has counted for its fork of each component. A fork with no counted fetch has no entry. */
  readonly #fetches = new Map<string, number>();

  constructor(url: string) {
    this.url = url;
  }

  get head(): string | undefined {
    return this.commits[this.commits.length - 1];
  }

  /** A push of record files, as `publish` makes them. Returns the record IDs. */
  async publish(...records: readonly object[]): Promise<string[]> {
    const ids: string[] = [];
    for (const record of records) {
      const id = await recordId(record);
      ids.push(id);
      this.#files.set(recordPath(record as AnyRecord, id), { content: encoder.encode(JSON.stringify(record)), since: this.commits.length });
    }
    await this.#commit();
    return ids;
  }

  /** A push of one file as it is, whatever its path and content. */
  async push(path: string, content: string | Uint8Array): Promise<void> {
    this.#files.set(path, { content: typeof content === "string" ? encoder.encode(content) : content, since: this.commits.length });
    await this.#commit();
  }

  /** A push that takes every record file out of the tree, as the demo's reset does. */
  async empty(): Promise<void> {
    this.#files.clear();
    await this.#commit();
  }

  #fork(component: string): Fork {
    const fork = this.#forks.get(component) ?? { commits: new Map(), blobs: new Map() };
    this.#forks.set(component, fork);
    return fork;
  }

  /**
   * A push of a patch commit to the node's fork of a component, as a person who writes a
   * patch by hand makes it (R21). The commit sits on the component unless another parent
   * is given. Returns the commit: the one given, or one made up from what it holds.
   */
  async patchCommit(component: string, changes: readonly Change[], made: { readonly commit?: string; readonly parent?: string } = {}): Promise<string> {
    const fork = this.#fork(component);
    const parent = made.parent ?? component;
    const changed = [];
    for (const { path, content, mode } of changes) {
      if (content === undefined) {
        // A deleted path carries the deletion marker, as a real node serves it. The fork holds no blob for it.
        changed.push({ path, mode: DELETED_MODE, blob: DELETED_BLOB });
        continue;
      }
      const bytes = encoder.encode(content);
      const blob = await gitBlobHash(bytes);
      fork.blobs.set(blob, bytes);
      changed.push({ path, mode: mode ?? "100644", blob });
    }
    const commit = made.commit ?? (await sha256Hex(encoder.encode(JSON.stringify([this.url, parent, changed])))).slice(0, 40);
    fork.commits.set(commit, { parent, changes: changed });
    return commit;
  }

  /** Has the fork serve other content under a blob's hash, as a node that is wrong about a blob does. */
  serveInstead(component: string, blob: string, content: string): void {
    this.#fork(component).blobs.set(blob, encoder.encode(content));
  }

  /**
   * Sets how many fetches of its fork of a component the node has counted (R45). With no
   * number the node has counted none, as after its fork was made anew.
   */
  counted(component: string, fetches?: number): void {
    if (fetches === undefined) this.#fetches.delete(component);
    else this.#fetches.set(component, fetches);
  }

  async #commit(): Promise<void> {
    const name = await sha256Hex(encoder.encode(`${this.url} ${this.commits.length}`));
    this.commits.push(name.slice(0, 40));
  }

  async answer(url: URL): Promise<Response> {
    this.requests.push(url.href);
    const given = this.respond?.(url);
    if (given) return given;
    const route = url.href.slice(this.url.length + 1).split("?")[0];
    if (route === "records") {
      if (this.head === undefined) return notFound();
      const records = [];
      for (const [path, held] of this.#files) records.push({ path, blob: await gitBlobHash(held.content) });
      const listing = { head: this.head, records };
      await this.onListing?.();
      return Response.json(listing);
    }
    if (route === "file") {
      const commit = url.searchParams.get("commit");
      const path = url.searchParams.get("path");
      // The values name nothing but an entry of this map, and only in the shapes the contract gives them.
      const at = isGitHash(commit) ? this.commits.indexOf(commit) : -1;
      const held = parseRecordPath(path) && typeof path === "string" ? this.#files.get(path) : undefined;
      if (at < 0 || !held || held.since > at) return notFound();
      await this.onFile?.();
      return new Response(held.content, { headers: { "content-type": "application/json" } });
    }
    if (route === "patch" || route === "blob") {
      // Each value names nothing but an entry of a map, and only when it is a hash.
      const component = url.searchParams.get("component");
      const fork = isGitHash(component) ? this.#forks.get(component) : undefined;
      if (route === "patch") {
        const commit = url.searchParams.get("commit");
        const held = isGitHash(commit) ? fork?.commits.get(commit) : undefined;
        return held ? Response.json({ commit, parent: held.parent, changes: held.changes }) : notFound();
      }
      const blob = url.searchParams.get("blob");
      const content = isGitHash(blob) ? fork?.blobs.get(blob) : undefined;
      return content ? new Response(content, { headers: { "content-type": "application/octet-stream" } }) : notFound();
    }
    if (route === "fetches") {
      // A fork with no counted fetch has no count, and the node says so as it does for a path it does not serve.
      const component = url.searchParams.get("component");
      const fetches = isGitHash(component) ? this.#fetches.get(component) : undefined;
      const counted = fetches === undefined ? notFound() : Response.json({ component, fetches });
      await this.onFetches?.();
      return counted;
    }
    return notFound();
  }
}

/**
 * Puts the nodes behind `fetch` for the rest of the test. A request to any other host
 * fails as a network would. As `fetch` does, it hands a redirect back only to a caller
 * that asked for that, and follows it for any other. Returns every URL that was asked
 * for, in order.
 */
export function nodesBehindFetch(...nodes: readonly FakeNode[]): string[] {
  const asked: string[] = [];
  const ask = async (url: string, redirect: string): Promise<Response> => {
    asked.push(url);
    const node = nodes.find((held) => url === held.url || url.startsWith(`${held.url}/`));
    if (!node) throw new TypeError(`no such host: ${new URL(url).host}`);
    const response = await node.answer(new URL(url));
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location === null || redirect === "manual") return response;
    return ask(new URL(location, url).href, redirect);
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return ask(request.url, request.redirect);
  });
  return asked;
}
