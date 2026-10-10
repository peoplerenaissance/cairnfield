// `verify`: checks an installed copy of a component against the team's approved entry (R36).
//
// It works out the file-tree hash of a folder and compares it with the entry for the
// component in the approvals file it is given. It passes only when the two are equal.
// The approvals file is a copy of a team's decisions file, or the output of `approvals`
// saved to a file, which holds the same value. The team shares it by its own means.
// Nothing else is read: no config file, no node, no index and no published recipe, so
// this runs on any machine that holds the folder and the file.

import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { amongComponentFiles } from "../config.ts";
import { readDecisions } from "../decisions.ts";
import type { Io } from "../io.ts";
import { EXIT, Stop, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { folderTree } from "../tree.ts";

export interface VerifyRequest {
  /** The Git URL the component is pinned from, which names its entry. */
  readonly url: string;
  /** The folder that holds the installed copy. */
  readonly folder: string;
  /** The approvals file. There is no other source for the hash the copy must have. */
  readonly approvals: string | undefined;
}

export async function verify(io: Io, request: VerifyRequest): Promise<Outcome> {
  const { url } = request;
  if (request.approvals === undefined) return stop(EXIT.usage, "no-approvals");
  let folder: string;
  try {
    folder = await realpath(resolve(io.cwd, request.folder));
    if (!(await stat(folder)).isDirectory()) return stop(EXIT.usage, "no-folder");
  } catch (error) {
    if (error instanceof Stop) throw error;
    return stop(EXIT.usage, "no-folder");
  }
  const file = resolve(io.cwd, request.approvals);
  // A file that lies in the copy, or among any component's files, is the component's own say on what is approved.
  const inside = await realpath(file).then((real) => real.startsWith(`${folder}${sep}`), () => false);
  if (inside || (await amongComponentFiles(file))) return stop(EXIT.usage, "bad-approvals");
  const decisions = await readDecisions(file);
  if (!decisions) return stop(EXIT.usage, "no-approvals");

  // Only an approval of a copy the team built says what the folder must hold.
  const entry = decisions.find((decision) => decision.url === url);
  if (!entry || entry.verdict === "not-approved" || entry.tree === undefined) return stop(EXIT.notApproved, "not-approved", { url });
  const tree = await folderTree(folder);
  if (tree !== entry.tree) {
    return stop(EXIT.differs, "copy-differs", { url, commit: entry.commit, approved: entry.tree, ...(tree === undefined ? {} : { found: tree }) });
  }
  return done({ url, commit: entry.commit, verdict: entry.verdict, tree });
}
