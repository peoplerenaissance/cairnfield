// A registered component and the index's own copy of it (KTD12, KTD36). The index
// imports the branch that holds the commit, waits until the copy is ready, stores the
// copy's file listing, and then checks the records that waited for it.
//
// All of it runs from the queue. Each step may run again and again, so a message that
// is delivered twice, or that fails halfway, changes nothing it should not.

import { ENTRY_MODES, IMPORT_ERRORS, isPath } from "@cairnfield/protocol";
import type { FileEntry } from "@cairnfield/protocol";
import { codeOf, copyOf, open } from "./artifacts.ts";
import type { Repo } from "./artifacts.ts";
import type { Env } from "./env.ts";
import { lookAtWaitingPatches, lookOnceAtPatches, patchesWaitingFor } from "./patches.ts";
import { Copy, PASS_RECORDS, bump, recordOf, settle } from "./records.ts";
import type { ComponentState, Judged } from "./records.ts";

type ImportError = (typeof IMPORT_ERRORS)[number];

/** How long to wait before the copy is looked at again, in seconds. */
const POLL_SECONDS = 5;
/**
 * A copy that is not ready this long after its import started never will be, and a
 * remote that cannot be reached this long after the registration is given up (KTD12).
 * A first value.
 */
const IMPORT_DEADLINE_MS = 5 * 60_000;
/**
 * The most folders and the most files that the walk of a copy's tree takes. A copy with
 * more of either is given up. First values.
 */
const MAX_COPY_FOLDERS = 500;
const MAX_COPY_FILES = 20_000;
/** One statement holds this many rows of a listing: four values a row, under the limit of 100 a statement. */
const ROWS_PER_STATEMENT = 25;
const STATEMENTS_PER_BATCH = 40;

export interface Component {
  readonly component: string;
  readonly url: string;
  readonly branch: string;
  readonly state: ComponentState;
  readonly import_error: ImportError | null;
  readonly registered_at: number;
  /** When the import was started, or nothing while no look has started it. */
  readonly import_started_at: number | null;
  readonly view_version: number;
}

export function componentOf(env: Env, component: string): Promise<Component | null> {
  return env.DB.prepare("SELECT * FROM components WHERE component = ?").bind(component).first<Component>();
}

/** What the list of an index's components says of one of them. */
type Listed = Pick<Component, "component" | "url" | "branch" | "state">;

/**
 * Every registered component, in the order they were first registered. A row is written
 * once and never taken away, so the order of the rows is that order. `registered_at` is
 * not: registering a failed component again sets it again.
 */
export async function registeredComponents(env: Env): Promise<Listed[]> {
  const { results } = await env.DB.prepare("SELECT component, url, branch, state FROM components ORDER BY rowid").all<Listed>();
  return results;
}

/** What one walk of a copy's tree has met so far: the folders below the commit's tree, and the files. */
interface Walked {
  folders: number;
  readonly files: FileEntry[];
}

/**
 * Every file under a tree, with its path after `prefix`, or nothing when the copy holds
 * more folders or more files than a walk takes. `readTree` gives the children of one tree
 * per call. The trees below add to the one list. The walk ends at the first entry past a
 * cap: it reads no tree and takes no file after it.
 */
async function filesUnder(repo: Repo, tree: string, prefix: string, walked: Walked = { folders: 0, files: [] }): Promise<FileEntry[] | undefined> {
  for (const child of (await repo.readTree(tree)) ?? []) {
    const path = `${prefix}${child.name}`;
    if (child.type === "tree") {
      walked.folders += 1;
      if (walked.folders > MAX_COPY_FOLDERS) return undefined;
      if ((await filesUnder(repo, child.hash, `${path}/`, walked)) === undefined) return undefined;
    } else {
      if (walked.files.length === MAX_COPY_FILES) return undefined;
      walked.files.push({ path, mode: child.mode, blob: child.hash });
    }
  }
  return walked.files;
}

/**
 * Revokes every token of a copy. Artifacts returns a token from an import, with write
 * scope and a life of 24 hours, and no call can revoke it while the import runs. The
 * index issues no token of its own, so every active one goes (R8, KTD10).
 */
async function revokeTokens(repo: Repo): Promise<void> {
  const { tokens } = await repo.listTokens();
  for (const token of tokens) {
    if (token.state === "active") await repo.revokeToken(token.id);
  }
}

/** Rejects every record that waits for a component, while the component is in one state. */
function rejectWaiting(db: D1Database, component: string, state: ComponentState): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE records SET state = 'rejected', reason = 'unknown-component', body = NULL WHERE component = ?1 AND state = 'pending' AND EXISTS (SELECT 1 FROM components WHERE component = ?1 AND state = ?2)",
    )
    .bind(component, state);
}

/**
 * Marks a component that is importing as failed, and rejects every record that waited
 * for its copy (KTD12). For a component in any other state nothing changes: another look
 * may have found the copy ready, or given it up, since this one looked.
 */
async function fail(env: Env, component: string, error: ImportError | undefined): Promise<void> {
  await env.DB.batch([
    // It runs first, under the condition of the statement after it, which ends that condition.
    rejectWaiting(env.DB, component, "importing"),
    env.DB.prepare("UPDATE components SET state = 'failed', import_error = ?2, view_version = view_version + 1 WHERE component = ?1 AND state = 'importing'").bind(
      component,
      error ?? null,
    ),
  ]);
}

/** Rejects the records that were stored as pending after their component had failed. */
async function rejectLate(env: Env, component: string): Promise<void> {
  await env.DB.batch([
    rejectWaiting(env.DB, component, "failed"),
    env.DB.prepare("UPDATE components SET view_version = view_version + 1 WHERE component = ?1 AND state = 'failed'").bind(component),
  ]);
}

/**
 * Stores the listing of a copy that is ready: each path with its mode and blob (KTD12).
 * Returns whether it did. It stores nothing for a copy with more folders or files than a
 * walk takes.
 */
async function storeListing(env: Env, component: string, repo: Repo, tree: string): Promise<boolean> {
  const walked = await filesUnder(repo, tree, "");
  if (!walked) return false;
  // A path that no record can cite is left out, and so is an entry with a mode Git does not have.
  const files = walked.filter(({ path, mode }) => isPath(path) && (ENTRY_MODES as readonly string[]).includes(mode));
  // A commit's tree never changes, so a look that runs twice finds its rows there and leaves them.
  const statements = [];
  for (let at = 0; at < files.length; at += ROWS_PER_STATEMENT) {
    const rows = files.slice(at, at + ROWS_PER_STATEMENT);
    statements.push(
      env.DB.prepare(`INSERT OR IGNORE INTO files (component, path, mode, blob) VALUES ${rows.map(() => "(?, ?, ?, ?)").join(", ")}`).bind(
        ...rows.flatMap(({ path, mode, blob }) => [component, path, mode, blob]),
      ),
    );
  }
  // The component is ready only once its whole listing is stored.
  statements.push(env.DB.prepare("UPDATE components SET state = 'ready' WHERE component = ? AND state = 'importing'").bind(component), bump(env.DB, component));
  for (let at = 0; at < statements.length; at += STATEMENTS_PER_BATCH) {
    await env.DB.batch(statements.slice(at, at + STATEMENTS_PER_BATCH));
  }
  return true;
}

/**
 * Looks at the copy of a component that is importing. The first look starts the import:
 * it names the branch and sets no depth, so the copy holds every commit the branch
 * reaches (KTD12). A copy is ready when `get()` no longer throws and `readCommit` returns
 * the pinned commit (KTD36).
 *
 * The time a copy has to become ready counts from when its import started, so a first
 * look that runs late does not fail an import that has only just begun.
 */
async function lookAtCopy(env: Env, held: Component, now: number): Promise<"ready" | "waiting" | "failed"> {
  const { component, url, branch } = held;
  const name = copyOf(component);
  const failed = async (error?: ImportError): Promise<"failed"> => {
    await fail(env, component, error);
    return "failed";
  };
  const started = held.import_started_at;
  const copy = await open(env.ARTIFACTS, name);
  if (copy === "not-found") {
    // An import that was started a full time ago and left no copy never will.
    if (started !== null && now - started >= IMPORT_DEADLINE_MS) return failed();
    try {
      await env.ARTIFACTS.import({ source: { url, branch }, target: { name } });
    } catch (error) {
      const code = codeOf(error);
      // Only a remote that cannot be reached is worth another try (KTD12). No import has
      // started then, so this time counts from the registration.
      if (code === "UPSTREAM_UNAVAILABLE") return now - held.registered_at >= IMPORT_DEADLINE_MS ? failed(code) : "waiting";
      if ((IMPORT_ERRORS as readonly unknown[]).includes(code)) return failed(code as ImportError);
      // Another look may have started the import between this one's look and its own start.
      if (code !== "ALREADY_EXISTS") throw error;
    }
    // Written once: a later start of the same import leaves the time as it is.
    await env.DB.prepare("UPDATE components SET import_started_at = ? WHERE component = ? AND import_started_at IS NULL").bind(now, component).run();
    return "waiting";
  }
  // With no start written down, the import runs since the registration at the latest.
  if (copy === "not-ready") return now - (started ?? held.registered_at) >= IMPORT_DEADLINE_MS ? failed() : "waiting";
  await revokeTokens(copy);
  const pinned = await copy.readCommit(component);
  // A copy that finished without the commit never will hold it.
  if (!pinned) return failed("NOT_FOUND");
  // A copy too large to list is given up with no error code, as one that ran out of time is.
  if (!(await storeListing(env, component, copy, pinned.treeHash))) return failed();
  return "ready";
}

/**
 * Checks records that waited for the copy, a pass at a time. A patch record is not one
 * of them: it waits for its commit. Returns whether more records wait.
 *
 * A pass that is not the last one queues one look at each waiting patch record that
 * names a finding it settled as valid. After the last pass the caller queues a look at
 * every waiting patch record, those among them.
 */
async function checkWaiting(env: Env, component: string): Promise<boolean> {
  const { results } = await env.DB.prepare(
    "SELECT node, path, hash, body FROM records WHERE component = ? AND state = 'pending' AND type != 'patch' ORDER BY node, path LIMIT ?",
  )
    .bind(component, PASS_RECORDS + 1)
    .all<{ node: string; path: string; hash: string; body: string }>();
  const pass = results.slice(0, PASS_RECORDS);
  if (pass.length === 0) return false;
  const more = results.length > PASS_RECORDS;
  const copy = new Copy(env, component);
  const statements: D1PreparedStatement[] = [];
  /** The findings the pass judged as valid. */
  const valid: string[] = [];
  /** Settles what the pass judged. With `lookAgain`, also queues the looks at the patch records that waited for it. */
  const write = async (lookAgain: boolean): Promise<void> => {
    if (statements.length > 0) await env.DB.batch([...statements, bump(env.DB, component)]);
    if (lookAgain) await lookOnceAtPatches(env, await patchesWaitingFor(env, new Map([[component, valid]])));
  };
  for (const { node, path, hash, body } of pass) {
    const record = recordOf(body);
    let judged: Judged;
    try {
      judged = await copy.check(record);
    } catch (error) {
      // The copy could not be read. The records judged before this one are settled first,
      // so the look that is tried next starts after them.
      await write(true);
      throw error;
    }
    statements.push(settle(env.DB, node, path, judged));
    if (record.type === "finding" && judged.state === "valid") valid.push(hash);
  }
  await write(more);
  return more;
}

/**
 * Moves a component along: starts its import, waits for its copy, stores the listing,
 * then checks the records that waited. Returns the seconds after which to look again,
 * or nothing when there is no more to do.
 *
 * A patch record waits for its commit and not only for the copy. Once no other record
 * waits for the copy, a look at each waiting patch record is queued, so the findings a
 * patch names are checked before the patch is.
 */
export async function advance(env: Env, component: string, now: number): Promise<number | undefined> {
  const held = await componentOf(env, component);
  if (!held) return undefined;
  if (held.state === "failed") {
    // A record that was stored as pending after the component failed is rejected with the rest.
    await rejectLate(env, component);
    return undefined;
  }
  if (held.state === "importing") {
    const looked = await lookAtCopy(env, held, now);
    if (looked !== "ready") return looked === "waiting" ? POLL_SECONDS : undefined;
  }
  if (await checkWaiting(env, component)) return 0;
  await lookAtWaitingPatches(env, component);
  return undefined;
}
