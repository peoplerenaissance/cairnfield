// File trees, read through the binding. `readTree` returns the children of one tree
// per call, so each walk here reads only the folders it has to.

import type { Repo } from "./artifacts.ts";
import { DELETED_BLOB, DELETED_MODE, RECORDS_FOLDER, TEAM_BRANCH } from "./contract.ts";
import type { FileEntry } from "./contract.ts";

/** Every file under a tree, with its path after `prefix`. */
async function filesUnder(repo: Repo, tree: string, prefix: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  for (const child of (await repo.readTree(tree)) ?? []) {
    const path = `${prefix}${child.name}`;
    if (child.type === "tree") files.push(...(await filesUnder(repo, child.hash, `${path}/`)));
    else files.push({ path, mode: child.mode, blob: child.hash });
  }
  return files;
}

/**
 * The head commit of the team repo with every file under its records folder, or nothing
 * before the first push. The listing and the node's own page both come from this walk.
 */
export async function recordFiles(team: Repo): Promise<{ readonly head: string; readonly files: FileEntry[] } | undefined> {
  // The branch is named, because `log()` reads `HEAD` otherwise (KTD36).
  const [head] = await team.log({ ref: TEAM_BRANCH, limit: 1 });
  if (!head) return undefined;
  const root = (await team.readTree(head.treeHash)) ?? [];
  const folder = root.find((child) => child.name === RECORDS_FOLDER && child.type === "tree");
  return { head: head.hash, files: folder ? await filesUnder(team, folder.hash, `${RECORDS_FOLDER}/`) : [] };
}

async function childrenOf(repo: Repo, tree: string | undefined): Promise<Map<string, ArtifactsTreeEntry>> {
  const children = tree === undefined ? null : await repo.readTree(tree);
  return new Map((children ?? []).map((child) => [child.name, child]));
}

// Walks two trees side by side. A tree that is missing on one side reads as empty, so a
// folder that was added or deleted gives each of its files.
async function compare(
  repo: Repo,
  before: string | undefined,
  after: string | undefined,
  prefix: string,
  changes: FileEntry[],
): Promise<void> {
  const [old, now] = await Promise.all([childrenOf(repo, before), childrenOf(repo, after)]);
  for (const name of new Set([...old.keys(), ...now.keys()])) {
    const was = old.get(name);
    const is = now.get(name);
    // The same hash and mode on both sides is the same content. A folder is opened only when they differ.
    if (was?.hash === is?.hash && was?.mode === is?.mode) continue;
    const path = `${prefix}${name}`;
    const oldFolder = was?.type === "tree" ? was.hash : undefined;
    const newFolder = is?.type === "tree" ? is.hash : undefined;
    if (oldFolder !== undefined || newFolder !== undefined) {
      await compare(repo, oldFolder, newFolder, `${path}/`, changes);
    }
    if (is && newFolder === undefined) changes.push({ path, mode: is.mode, blob: is.hash });
    else if (was && oldFolder === undefined) changes.push({ path, mode: DELETED_MODE, blob: DELETED_BLOB });
  }
}

/**
 * The files that differ between a commit's tree and its parent's tree: each path with
 * its mode and blob in the commit, or with the deletion marker (KTD4, KTD7). A path whose
 * mode alone changed counts.
 */
export async function changedFiles(repo: Repo, parentTree: string, tree: string): Promise<FileEntry[]> {
  const changes: FileEntry[] = [];
  await compare(repo, parentTree, tree, "", changes);
  return changes;
}
