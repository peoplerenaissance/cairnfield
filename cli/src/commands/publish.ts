// `publish`: validates the outbox and pushes it to the team repo (KTD20).
//
// Records are immutable and named by the hash of their content (KTD1), so two pushes
// never differ on a file, only on where the branch points. When the branch has moved,
// the command reads it again, adds its files on top and pushes again. A file that the
// branch already holds is left as it is.
//
// After the push the command tells a configured index that its node has news (KTD11).
// The notice is a hint, and a run with nothing new to push sends it again.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INDEX_ROUTES, NODE_ROUTES, TEAM_BRANCH, validateRecordFile } from "@cairnfield/protocol";
import type { FileMode } from "@cairnfield/protocol";
import type { Home } from "../config.ts";
import { fetchRef, readBlobs, said, withScratch } from "../git.ts";
import type { Access, Scratch } from "../git.ts";
import type { Io } from "../io.ts";
import { checkOutbox } from "../outbox.ts";
import type { Checked } from "../outbox.ts";
import { EXIT, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { adminKey, callIndex, callNode, nodeFailed, repoAccess, untilReady } from "../services.ts";
import { verdict } from "./validate.ts";

const BRANCH = `refs/heads/${TEAM_BRANCH}`;
/** A record file is a plain file. */
const RECORD_MODE: FileMode = "100644";
/** Three runs at once all landed within three tries on Artifacts, so this leaves room. */
const MAX_TRIES = 6;
/** A try waits up to this long, times its number, so runs that collide spread out. */
const RETRY_SPREAD_MS = 400;

/** A record file as Git holds it: its path in the team repo and the blob of its bytes. */
interface Stored {
  readonly path: string;
  readonly blob: string;
}

const lines = (all: readonly string[]): Uint8Array => new TextEncoder().encode(all.map((line) => `${line}\n`).join(""));

/** Stores each record's validated bytes as a blob, with no filter. */
async function storeBlobs(scratch: Scratch, records: readonly Checked[]): Promise<Stored[]> {
  const dir = join(scratch.dir, "records");
  await mkdir(dir);
  const files = records.map((record, at) => ({ record, file: join(dir, String(at)) }));
  await Promise.all(files.map(({ record, file }) => writeFile(file, record.content)));
  const hashed = await scratch.git("hash-object", ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
    input: lines(files.map(({ file }) => file)),
  });
  const blobs = said(hashed).split("\n");
  if (blobs.length !== records.length) stop(EXIT.git, "git-failed", { step: "hash-object" });
  return records.map((record, at) => ({ path: record.path, blob: blobs[at] ?? "" }));
}

/** The commit the team branch points to, fetched at depth 1. Nothing for a repo with no push yet. */
async function fetchHead(scratch: Scratch, access: Access): Promise<string | undefined> {
  const listed = await scratch.git("ls-remote", ["ls-remote", access.remote, BRANCH], { access });
  return said(listed) === "" ? undefined : fetchRef(scratch, access, BRANCH);
}

/**
 * The files a commit does not hold yet. Only these files are asked about, however many
 * the commit holds. A path the commit does hold must hold this record already: the same
 * bytes, or the same record with other spacing. Anything else there ends the command,
 * because a published record is never written over, and the record is not published.
 */
async function notYetIn(scratch: Scratch, commit: string, files: readonly Stored[]): Promise<Stored[]> {
  const asked = await scratch.git("cat-file", ["cat-file", "--batch-check"], {
    input: lines(files.map(({ path }) => `${commit}:${path}`)),
  });
  // `<hash> <type> <size>` for a path the commit holds, and a line that ends in `missing` for one it lacks.
  const answers = said(asked).split("\n");
  if (answers.length !== files.length) stop(EXIT.git, "git-failed", { step: "cat-file" });
  const missing: Stored[] = [];
  const conflicts: string[] = [];
  const unlike: { readonly path: string; readonly hash: string }[] = [];
  files.forEach((file, at) => {
    const [hash = "", type = ""] = (answers[at] ?? "").split(" ");
    if (answers[at]?.endsWith(" missing")) missing.push(file);
    else if (type !== "blob") conflicts.push(file.path);
    else if (hash !== file.blob) unlike.push({ path: file.path, hash });
  });
  const held = await readBlobs(scratch, [...new Set(unlike.map(({ hash }) => hash))]);
  for (const { path, hash } of unlike) {
    // The file name is the record's ID, so a valid record file at this path is this record.
    const there = await validateRecordFile(path, held.get(hash) ?? new Uint8Array(0));
    if (!there.ok) conflicts.push(path);
  }
  if (conflicts.length > 0) stop(EXIT.git, "record-conflict", { records: conflicts.sort() });
  return missing;
}

/** Whether the remote turned the push down because the branch is not where the push expects it. */
function wasRejected(porcelain: string): boolean {
  return porcelain.split("\n").some((line) => line.startsWith("!\t"));
}

interface Landed {
  /** The commit the team branch points to. */
  readonly head: string | undefined;
  /** The record files this run added to the branch. */
  readonly published: readonly string[];
}

async function push(io: Io, scratch: Scratch, access: Access, records: readonly Checked[]): Promise<Landed> {
  const stored = await storeBlobs(scratch, records);
  for (let attempt = 1; ; attempt++) {
    const head = await fetchHead(scratch, access);
    // A published record is never written again (KTD1), even with other spacing.
    const added = head === undefined ? stored : await notYetIn(scratch, head, stored);
    if (added.length === 0) return { head, published: [] };

    const index = join(scratch.dir, `index-${attempt}`);
    await scratch.git("read-tree", head === undefined ? ["read-tree", "--empty"] : ["read-tree", head], { index });
    await scratch.git("update-index", ["update-index", "--add", "--index-info"], {
      index,
      input: lines(added.map(({ path, blob }) => `${RECORD_MODE} blob ${blob}\t${path}`)),
    });
    const tree = said(await scratch.git("write-tree", ["write-tree"], { index }));
    const parent = head === undefined ? [] : ["-p", head];
    const commit = said(await scratch.git("commit-tree", ["commit-tree", tree, ...parent, "-m", "Publish records"]));

    const pushed = await scratch.git("push", ["push", "--porcelain", access.remote, `${commit}:${BRANCH}`], {
      access,
      mayFail: true,
    });
    if (pushed.code === 0) return { head: commit, published: added.map(({ path }) => path) };
    if (!wasRejected(said(pushed)) || attempt === MAX_TRIES) {
      scratch.report(pushed);
      return stop(EXIT.git, "git-failed", { step: "push" });
    }
    await io.sleep(io.random(RETRY_SPREAD_MS) * attempt);
  }
}

/** Tells the index that the node has news. The same hint the node's own Workflow sends (KTD20). */
async function notify(io: Io, home: Home): Promise<"sent" | "failed" | "none"> {
  const { index, node } = home.config;
  if (index === undefined) return "none";
  const answer = await callIndex(io, index, INDEX_ROUTES.notice, { body: { node } });
  return answer.ok ? "sent" : "failed";
}

/** Publishes the outbox, or the one file of it that `only` names. The rest then stays where it is. */
export async function publish(io: Io, home: Home, only?: string): Promise<Outcome> {
  const check = await checkOutbox(home, only);
  if (check.rejected.length > 0) return verdict(check);
  const records = check.records.length;
  if (records === 0) return done({ records, published: [], notice: "none" });

  const key = adminKey(io);
  const team = await untilReady(io, () => callNode(io, home, NODE_ROUTES.createTeamRepo, { key }));
  if (!team.ok) return nodeFailed(team);
  const access = await repoAccess(io, home, { repo: "team", scope: "write" });
  const landed = await withScratch(io, (scratch) => push(io, scratch, access, check.records));

  const notice = await notify(io, home);
  return done({ records, ...landed, notice }, notice === "failed" ? EXIT.index : EXIT.ok);
}
