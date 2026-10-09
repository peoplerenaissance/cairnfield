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
import { INDEX_ROUTES, NODE_ROUTES, TEAM_BRANCH } from "@cairnfield/protocol";
import type { Home } from "../config.ts";
import { said, withScratch } from "../git.ts";
import type { Access, Scratch } from "../git.ts";
import type { Io } from "../io.ts";
import { checkOutbox } from "../outbox.ts";
import type { Checked } from "../outbox.ts";
import { EXIT, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { adminKey, callIndex, callNode, nodeFailed, repoAccess, untilReady } from "../services.ts";
import { verdict } from "./validate.ts";

const BRANCH = `refs/heads/${TEAM_BRANCH}`;
/** Three runs at once all landed within three tries on Artifacts, so this leaves room. */
const MAX_TRIES = 6;
/** A try waits up to this long, times its number, so runs that collide spread out. */
const RETRY_SPREAD_MS = 400;

/** Stores each record's validated bytes as a blob, with no filter. Returns the blob hashes, in order. */
async function storeBlobs(scratch: Scratch, records: readonly Checked[]): Promise<string[]> {
  const dir = join(scratch.dir, "records");
  await mkdir(dir);
  const files = records.map((_, at) => join(dir, String(at)));
  await Promise.all(records.map((record, at) => writeFile(files[at] ?? "", record.content)));
  const hashed = await scratch.git("hash-object", ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
    input: new TextEncoder().encode(files.map((file) => `${file}\n`).join("")),
  });
  const blobs = said(hashed).split("\n");
  if (blobs.length !== records.length) stop(EXIT.git, "git-failed", { step: "hash-object" });
  return blobs;
}

/** The commit the team branch points to, fetched at depth 1. Nothing for a repo with no push yet. */
async function fetchHead(scratch: Scratch, access: Access): Promise<string | undefined> {
  const listed = await scratch.git("ls-remote", ["ls-remote", access.remote, BRANCH], { access });
  if (said(listed) === "") return undefined;
  await scratch.git(
    "fetch",
    ["fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", access.remote, BRANCH],
    { access },
  );
  return said(await scratch.git("fetch", ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]));
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
  const blobs = await storeBlobs(scratch, records);
  for (let attempt = 1; ; attempt++) {
    const head = await fetchHead(scratch, access);
    const index = join(scratch.dir, `index-${attempt}`);
    await scratch.git("read-tree", head === undefined ? ["read-tree", "--empty"] : ["read-tree", head], { index });
    const listed = head === undefined ? "" : said(await scratch.git("ls-tree", ["ls-tree", "-r", "--name-only", head]));
    const held = new Set(listed.split("\n"));
    // A published record is never written again (KTD1), even with other spacing.
    const added = records.flatMap((record, at) => (held.has(record.path) ? [] : [{ path: record.path, blob: blobs[at] ?? "" }]));
    if (added.length === 0) return { head, published: [] };

    await scratch.git("update-index", ["update-index", "--add", "--index-info"], {
      index,
      input: new TextEncoder().encode(added.map(({ path, blob }) => `100644 blob ${blob}\t${path}\n`).join("")),
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

export async function publish(io: Io, home: Home): Promise<Outcome> {
  const check = await checkOutbox(home);
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
