// How the index reads from a node (R9, KTD30). Every read goes to the registered URL of
// one node, runs under a deadline, follows no redirect and stops at a size limit (KTD6).
// What comes back is hostile until it has been checked.

import { MAX_BLOB_BYTES, MAX_LISTING_ENTRIES, MAX_RECORD_BYTES, NODE_FETCHES, NODE_PATCH, NODE_REFUSAL, NODE_ROUTES, conforms, isGitHash } from "@cairnfield/protocol";
import type { NodeFetches, NodePatch } from "@cairnfield/protocol";

const DEADLINE_MS = 10_000;
/** A node's listing is read up to this size: the most entries it may hold, with room for each. */
const MAX_LISTING_BYTES = MAX_LISTING_ENTRIES * 512;
/** A patch commit's changed paths are read up to the same size: a node lists as many paths at most. */
const MAX_PATCH_BYTES = MAX_LISTING_BYTES;
/** A node's count of fetches is read up to this size: the room one entry of a listing is given. The answer is one hash and one number. */
const MAX_FETCHES_BYTES = 512;

/** A sync reads from a node this many at a time: as many connections as one invocation holds open at once. */
export const FETCH_AHEAD = 6;

/** Why a read from a node gave nothing the index can use. A code, never a sentence. */
export const READ_FAILURES = ["unreachable", "redirected", "too-large", "bad-answer"] as const;
export type ReadFailure = (typeof READ_FAILURES)[number];

export type Failed = { readonly ok: false; readonly reason: ReadFailure };

const failed = (reason: ReadFailure): Failed => ({ ok: false, reason });

/**
 * Reads a body up to `max` bytes. Returns at most `max + 1` bytes, so one byte more than
 * the limit says the body was longer, and nothing past it is kept.
 */
export async function readUpTo(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (body) {
    const reader = body.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const room = max + 1 - size;
      const chunk = read.value.subarray(0, room);
      chunks.push(chunk);
      size += chunk.length;
      if (read.value.length >= room) {
        await reader.cancel();
        break;
      }
    }
  }
  // Joined once, in a buffer no longer than what was read.
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

type Read = { readonly ok: true; readonly status: number; readonly bytes: Uint8Array } | Failed;

async function read(url: string, max: number): Promise<Read> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(DEADLINE_MS) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return failed("redirected");
    }
    return { ok: true, status: response.status, bytes: await readUpTo(response.body, max) };
  } catch {
    return failed("unreachable");
  }
}

/** The JSON value that bytes hold, or nothing for bytes that are not JSON in UTF-8. */
export function jsonOf(bytes: Uint8Array): unknown {
  try {
    // A byte order mark is kept, so JSON parsing refuses it.
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** Whether a node refused a request as `not-found`, in the shape the contract gives a refusal. */
function isNotFound(status: number, body: unknown): boolean {
  return status === 404 && !conforms(NODE_REFUSAL, body) && (body as { error: unknown }).error === "not-found";
}

/** The head of a node's team repo with the paths it lists. A node with no team repo yet has no head. */
export type Listing = { readonly ok: true; readonly head?: string; readonly paths: readonly unknown[] } | Failed;

/**
 * Reads a node's listing (R7). Only its outline is checked here: a head that is a commit
 * and a list within the limit. Each path is checked where it is used, so one file with
 * another name does not hide the node's records.
 */
export async function readListing(node: string): Promise<Listing> {
  const answer = await read(`${node}/${NODE_ROUTES.listing.path}`, MAX_LISTING_BYTES);
  if (!answer.ok) return answer;
  if (answer.bytes.length > MAX_LISTING_BYTES) return failed("too-large");
  const body = jsonOf(answer.bytes);
  if (answer.status !== 200) {
    // A node whose team repo is not there yet says so. It has nothing to read.
    return isNotFound(answer.status, body) ? { ok: true, paths: [] } : failed("bad-answer");
  }
  if (typeof body !== "object" || body === null) return failed("bad-answer");
  const { head, records } = body as { readonly head?: unknown; readonly records?: unknown };
  if (!isGitHash(head) || !Array.isArray(records)) return failed("bad-answer");
  if (records.length > MAX_LISTING_ENTRIES) return failed("too-large");
  const paths = (records as readonly unknown[]).map((entry) =>
    typeof entry === "object" && entry !== null ? (entry as { readonly path?: unknown }).path : undefined,
  );
  return { ok: true, head, paths };
}

/**
 * The bytes of one record file. Of a file longer than a record may be, only the start is
 * held: one byte more than the limit, which is enough for the record check to refuse it.
 */
export type RecordFile = { readonly ok: true; readonly bytes: Uint8Array } | Failed;

/**
 * Reads one record file as the node serves it at a commit. The node validates nothing
 * (KTD7), so the caller checks the bytes. The path's shape is checked before this call.
 */
export async function readRecordFile(node: string, commit: string, path: string): Promise<RecordFile> {
  const query = new URLSearchParams({ commit, path });
  const answer = await read(`${node}/${NODE_ROUTES.file.path}?${query}`, MAX_RECORD_BYTES);
  if (!answer.ok) return answer;
  // The listing named the file at this commit, so a node that does not serve it gave a bad answer.
  if (answer.status !== 200) return failed("bad-answer");
  return { ok: true, bytes: answer.bytes };
}

/**
 * Reads a patch commit's parent and changed paths from the node whose fork holds it
 * (KTD7). Returns nothing when the node does not serve the commit: its fork does not
 * hold it yet, the node cannot be reached, or the answer is not in the contract's shape
 * for the commit that was asked for. Every hash, mode and path of what comes back is in
 * the shape the contract gives it, and nothing else of it is checked here.
 */
export async function readPatchCommit(node: string, component: string, commit: string): Promise<NodePatch | undefined> {
  const query = new URLSearchParams({ component, commit });
  const answer = await read(`${node}/${NODE_ROUTES.patch.path}?${query}`, MAX_PATCH_BYTES);
  if (!answer.ok || answer.status !== 200 || answer.bytes.length > MAX_PATCH_BYTES) return undefined;
  const body = jsonOf(answer.bytes);
  if (conforms(NODE_PATCH, body)) return undefined;
  const served = body as NodePatch;
  return served.commit === commit ? served : undefined;
}

/**
 * Reads one blob of a node's fork of a component. Of a blob longer than a served blob
 * may be (KTD6), only the start is held: one byte more than the limit, which is enough
 * for the patch checks to refuse it. The caller holds the content to the blob's hash.
 * Returns nothing when the node does not serve the blob.
 */
export async function readForkBlob(node: string, component: string, blob: string): Promise<Uint8Array | undefined> {
  const query = new URLSearchParams({ component, blob });
  const answer = await read(`${node}/${NODE_ROUTES.blob.path}?${query}`, MAX_BLOB_BYTES);
  return answer.ok && answer.status === 200 ? answer.bytes : undefined;
}

/** What a node says of the fetches of its fork of a component: its count, or that it has counted none. */
export type Fetches = { readonly counted: true; readonly fetches: number } | { readonly counted: false };

/**
 * Reads a node's count of the fetches of its fork of a component (R45, KTD43). A node
 * that has counted no fetch of the fork refuses as `not-found`, and so does a node from
 * before the route. Returns nothing for any other answer: the node cannot be reached, or
 * the answer is not in the contract's shape for the component that was asked for. The
 * number is the node's own statement. It is held to its form here, and nothing checks
 * its truth.
 */
export async function readFetches(node: string, component: string): Promise<Fetches | undefined> {
  const query = new URLSearchParams({ component });
  const answer = await read(`${node}/${NODE_ROUTES.fetches.path}?${query}`, MAX_FETCHES_BYTES);
  if (!answer.ok || answer.bytes.length > MAX_FETCHES_BYTES) return undefined;
  const body = jsonOf(answer.bytes);
  if (isNotFound(answer.status, body)) return { counted: false };
  if (answer.status !== 200 || conforms(NODE_FETCHES, body)) return undefined;
  const served = body as NodeFetches;
  return served.component === component ? { counted: true, fetches: served.fetches } : undefined;
}
