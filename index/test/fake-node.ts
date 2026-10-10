// Team nodes for a test, behind `fetch`. A fake node serves the two routes of the node
// contract that the index reads: its head with a listing of its record files, and one
// file at a commit (KTD7). Like a real node, it validates nothing. Every host is invented.

import { gitBlobHash, isGitHash, parseRecordPath, recordId, recordPath, sha256Hex } from "@cairnfield/protocol";
import type { AnyRecord } from "@cairnfield/protocol";
import { vi } from "vitest";

const encoder = new TextEncoder();

interface Held {
  readonly content: Uint8Array;
  /** The push that added the file. */
  readonly since: number;
}

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
  /** Answers a request in place of the node, or throws as a network would. */
  respond: ((url: URL) => Response | undefined) | undefined;
  readonly #files = new Map<string, Held>();

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
      if (this.head === undefined) return Response.json({ error: "not-found" }, { status: 404 });
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
      if (at < 0 || !held || held.since > at) return Response.json({ error: "not-found" }, { status: 404 });
      await this.onFile?.();
      return new Response(held.content, { headers: { "content-type": "application/json" } });
    }
    return Response.json({ error: "not-found" }, { status: 404 });
  }
}

/**
 * Puts the nodes behind `fetch` for the rest of the test. A request to any other host
 * fails as a network would. Returns every URL that was asked for, in order.
 */
export function nodesBehindFetch(...nodes: readonly FakeNode[]): string[] {
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    asked.push(request.url);
    const node = nodes.find(({ url }) => request.url === url || request.url.startsWith(`${url}/`));
    if (!node) throw new TypeError(`no such host: ${new URL(request.url).host}`);
    return node.answer(new URL(request.url));
  });
  return asked;
}
