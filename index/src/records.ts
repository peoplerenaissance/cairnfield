// What the index holds for a record, and the check of a record against the index's own
// copy of its component (R9). A record is stored as valid, pending or rejected (KTD1):
// pending while its component's copy is not ready, and rejected with a reason from the
// protocol's closed list. A rejected record keeps no content (KTD31).

import { MAX_BLOB_BYTES, citedBlob, citedPaths, isFileMode, validateAgainstFiles } from "@cairnfield/protocol";
import type { AnyRecord, COMPONENT_STATES, CitedFile, FileEntry, RecordType, RejectionReason } from "@cairnfield/protocol";
import { codeOf, copyOf } from "./artifacts.ts";
import type { Repo } from "./artifacts.ts";
import type { Env } from "./env.ts";

export type ComponentState = (typeof COMPONENT_STATES)[number];
export type RecordState = "valid" | "pending" | "rejected";

/** How the index judged a record that passed the structure check. */
export type Judged =
  | { readonly state: "valid"; readonly cited?: string }
  | { readonly state: "pending" }
  | { readonly state: "rejected"; readonly reason: RejectionReason };

/**
 * The most records taken in one pass, whether a sync reads them from a node or a look
 * checks the ones that waited for a copy. A pass is one invocation, which may make a set
 * number of calls, and each record costs at most one fetch and three reads of the copy.
 * What is left is taken in the passes after it.
 */
export const PASS_RECORDS = 120;

/** One row of the records table. */
export interface StoredRecord {
  readonly node: string;
  readonly path: string;
  readonly component: string;
  readonly type: RecordType;
  readonly state: RecordState;
  readonly reason: RejectionReason | null;
  readonly hash: string;
  readonly head: string;
  readonly body: string | null;
  readonly cited: string | null;
  readonly received_at: number;
  readonly rebuilt: number;
}

/** The record of a stored body. The body is the index's own writing of a record that passed the structure check. */
export function recordOf(body: string): AnyRecord {
  return JSON.parse(body) as AnyRecord;
}

/** Adds one to a component's view version, or to every component's when none is named (KTD11). */
export function bump(db: D1Database, component?: string): D1PreparedStatement {
  return component === undefined
    ? db.prepare("UPDATE components SET view_version = view_version + 1")
    : db.prepare("UPDATE components SET view_version = view_version + 1 WHERE component = ?").bind(component);
}

const EMPTY = new Uint8Array(0);

/**
 * The longest file the index reads for a record: 32 MiB, the longest file a checkout of
 * the command holds, so the longest a finding can cite.
 */
const MAX_CITED_BYTES = 32 * 1024 * 1024;
/** The reason for a record that cites a longer file, from the protocol's closed list. */
const TOO_LARGE = "too-large" satisfies RejectionReason;

/**
 * The index's own copy of one component, for the checks of one pass. The copy is opened
 * once, and only when a record cites a file. Records that cite one file share its row
 * and its content.
 */
export class Copy {
  readonly #env: Env;
  readonly #component: string;
  #repo: Promise<Repo> | undefined;
  /** Each path asked for so far, with its row. A path the copy does not hold has none. The listing of a ready copy never changes. */
  readonly #rows = new Map<string, FileEntry | undefined>();
  /** The content of the blobs read so far, by hash. Only a blob within the size limit is kept, so what a pass holds is bounded. */
  readonly #contents = new Map<string, Uint8Array>();

  constructor(env: Env, component: string) {
    this.#env = env;
    this.#component = component;
  }

  /** The rows of the paths a record cites. A path the copy does not hold is left out. */
  async #listing(paths: readonly string[]): Promise<FileEntry[]> {
    const unasked = paths.filter((path) => !this.#rows.has(path));
    if (unasked.length > 0) {
      const marks = unasked.map(() => "?").join(", ");
      const { results } = await this.#env.DB.prepare(`SELECT path, mode, blob FROM files WHERE component = ? AND path IN (${marks})`)
        .bind(this.#component, ...unasked)
        .all<FileEntry>();
      for (const path of unasked) this.#rows.set(path, undefined);
      for (const row of results) this.#rows.set(row.path, row);
    }
    return paths.flatMap((path) => this.#rows.get(path) ?? []);
  }

  /**
   * The files a record cites, as the copy holds them, or `too-large` when one of them is
   * longer than the index reads. A path the copy does not hold is left out.
   */
  async #files(paths: readonly string[]): Promise<{ readonly files: Map<string, CitedFile>; readonly listing: FileEntry[] } | typeof TOO_LARGE> {
    const listing = await this.#listing(paths);
    const files = new Map<string, CitedFile>();
    // The blobs of one record are read one after another, so the copy hands over one long
    // blob at a time. Only a regular file can be cited, and the check refuses any other
    // before it reads content.
    for (const { path, mode, blob } of listing) {
      const content = isFileMode(mode) ? await this.read(blob) : EMPTY;
      if (content === TOO_LARGE) return TOO_LARGE;
      files.set(path, { mode, content });
    }
    return { files, listing };
  }

  /**
   * The content of a blob that the copy's listing names, or `too-large` for one that is
   * longer than the index reads. Any other failed read throws. A patch check reads the
   * content a patch replaces here, and from nowhere else (KTD7).
   */
  async read(blob: string): Promise<Uint8Array | typeof TOO_LARGE> {
    const held = this.#contents.get(blob);
    if (held) return held;
    this.#repo ??= this.#env.ARTIFACTS.get(copyOf(this.#component));
    const repo = await this.#repo;
    let content: Blob | null;
    try {
      content = await repo.readBlob(blob);
    } catch (error) {
      // The binding hands over no blob that is too long for it to hold.
      if (codeOf(error) === "MEMORY_LIMIT") return TOO_LARGE;
      throw error;
    }
    // The listing came from this copy, so a blob it names is there.
    if (!content) throw new Error("the copy does not hold a blob of its own listing");
    // The size is known before the content is asked for, so a longer blob is never buffered here.
    if (content.size > MAX_CITED_BYTES) return TOO_LARGE;
    const bytes = new Uint8Array(await content.arrayBuffer());
    // A longer blob is read again each time a record cites it.
    if (bytes.length <= MAX_BLOB_BYTES) this.#contents.set(blob, bytes);
    return bytes;
  }

  /**
   * Checks a record against the copy: a cited path is a regular file of the pinned
   * commit, a line range is within its file, and a finding's host appears in the lines
   * it cites (R9). A valid finding comes back with its cited content (KTD5). A record
   * that cites a file longer than the index reads is rejected as too large.
   */
  async check(record: AnyRecord): Promise<Judged> {
    const cites = await this.#files(citedPaths(record));
    if (cites === TOO_LARGE) return { state: "rejected", reason: TOO_LARGE };
    const { files, listing } = cites;
    const verdict = validateAgainstFiles(record, files);
    if (!verdict.ok) return { state: "rejected", reason: verdict.reason };
    const cited = record.type === "finding" ? citedBlob(record, listing) : undefined;
    return cited === undefined ? { state: "valid" } : { state: "valid", cited };
  }
}

/**
 * Judges a record that passed the structure check, by the state of its component's copy
 * (KTD12). A patch record waits as pending until its commit has been checked (see
 * `patches.ts`).
 */
export async function judge(copy: Copy, state: ComponentState, record: AnyRecord): Promise<Judged> {
  if (state === "failed") return { state: "rejected", reason: "unknown-component" };
  if (state === "importing" || record.type === "patch") return { state: "pending" };
  return copy.check(record);
}

/** The reason and the cited content to store for a judged record. Only a rejected record has a reason, and only a valid one cited content. */
export function reasonAndCited(judged: Judged): Pick<StoredRecord, "reason" | "cited"> {
  return {
    reason: judged.state === "rejected" ? judged.reason : null,
    cited: judged.state === "valid" ? (judged.cited ?? null) : null,
  };
}

/** Moves a pending record to the state it was judged to have. A rejected record keeps no content. */
export function settle(db: D1Database, node: string, path: string, judged: Judged): D1PreparedStatement {
  const { reason, cited } = reasonAndCited(judged);
  return db
    .prepare(
      "UPDATE records SET state = ?1, reason = ?2, cited = ?3, body = CASE WHEN ?1 = 'rejected' THEN NULL ELSE body END WHERE node = ?4 AND path = ?5 AND state = 'pending'",
    )
    .bind(judged.state, reason, cited, node, path);
}
