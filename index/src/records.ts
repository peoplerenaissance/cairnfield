// What the index holds for a record, and the check of a record against the index's own
// copy of its component (R9). A record is stored as valid, pending or rejected (KTD1):
// pending while its component's copy is not ready, and rejected with a reason from the
// protocol's closed list. A rejected record keeps no content (KTD31).

import { citedBlob, citedPaths, isFileMode, validateAgainstFiles } from "@cairnfield/protocol";
import type { AnyRecord, CitedFile, RecordType, RejectionReason } from "@cairnfield/protocol";
import { copyOf } from "./artifacts.ts";
import type { Repo } from "./artifacts.ts";
import type { Env } from "./env.ts";

export type ComponentState = "importing" | "ready" | "failed";
export type RecordState = "valid" | "pending" | "rejected";

/** How the index judged a record that passed the structure check. */
export type Judged =
  | { readonly state: "valid"; readonly cited?: string }
  | { readonly state: "pending" }
  | { readonly state: "rejected"; readonly reason: RejectionReason };

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

/** Adds one to a component's view version, or to every component's when none is named (KTD11). */
export function bump(db: D1Database, component?: string): D1PreparedStatement {
  return component === undefined
    ? db.prepare("UPDATE components SET view_version = view_version + 1")
    : db.prepare("UPDATE components SET view_version = view_version + 1 WHERE component = ?").bind(component);
}

const EMPTY = new Uint8Array(0);

/**
 * The index's own copy of one component, for the checks of one pass. The copy is opened
 * once, and only when a record cites a file.
 */
export class Copy {
  readonly #env: Env;
  readonly #component: string;
  #repo: Promise<Repo> | undefined;

  constructor(env: Env, component: string) {
    this.#env = env;
    this.#component = component;
  }

  /** The files a record cites, as the copy holds them. A path the copy does not hold is left out. */
  async #files(paths: readonly string[]): Promise<{ readonly files: Map<string, CitedFile>; readonly listing: { path: string; mode: string; blob: string }[] }> {
    const files = new Map<string, CitedFile>();
    if (paths.length === 0) return { files, listing: [] };
    const marks = paths.map(() => "?").join(", ");
    const { results } = await this.#env.DB.prepare(`SELECT path, mode, blob FROM files WHERE component = ? AND path IN (${marks})`)
      .bind(this.#component, ...paths)
      .all<{ path: string; mode: string; blob: string }>();
    for (const { path, mode, blob } of results) {
      // Only a regular file can be cited, and the check refuses any other before it reads content.
      files.set(path, { mode, content: isFileMode(mode) ? await this.#read(blob) : EMPTY });
    }
    return { files, listing: results };
  }

  async #read(blob: string): Promise<Uint8Array> {
    this.#repo ??= this.#env.ARTIFACTS.get(copyOf(this.#component));
    const content = await (await this.#repo).readBlob(blob);
    // The listing came from this copy, so a blob it names is there.
    if (!content) throw new Error("the copy does not hold a blob of its own listing");
    return new Uint8Array(await content.arrayBuffer());
  }

  /**
   * Checks a record against the copy: a cited path is a regular file of the pinned
   * commit, a line range is within its file, and a finding's host appears in the lines
   * it cites (R9). A valid finding comes back with its cited content (KTD5).
   */
  async check(record: AnyRecord): Promise<Judged> {
    const { files, listing } = await this.#files(citedPaths(record));
    const verdict = validateAgainstFiles(record, files);
    if (!verdict.ok) return { state: "rejected", reason: verdict.reason };
    const cited = record.type === "finding" ? citedBlob(record, listing) : undefined;
    return cited === undefined ? { state: "valid" } : { state: "valid", cited };
  }
}

/**
 * Judges a record that passed the structure check, by the state of its component's copy
 * (KTD12). A patch record waits as pending until its commit has been checked.
 */
export async function judge(copy: Copy, component: ComponentState, record: AnyRecord): Promise<Judged> {
  if (component === "failed") return { state: "rejected", reason: "unknown-component" };
  if (component === "importing" || record.type === "patch") return { state: "pending" };
  return copy.check(record);
}

/** Moves a pending record to the state it was judged to have. A rejected record keeps no content. */
export function settle(db: D1Database, node: string, path: string, judged: Judged): D1PreparedStatement {
  const reason = judged.state === "rejected" ? judged.reason : null;
  const cited = judged.state === "valid" ? (judged.cited ?? null) : null;
  return db
    .prepare(
      "UPDATE records SET state = ?1, reason = ?2, cited = ?3, body = CASE WHEN ?1 = 'rejected' THEN NULL ELSE body END WHERE node = ?4 AND path = ?5 AND state = 'pending'",
    )
    .bind(judged.state, reason, cited, node, path);
}
