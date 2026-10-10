// The file-tree hash of a folder, worked out the way Git does (R36).
//
// No Git runs here. So no configuration, hook, filter, line-ending rule or attribute
// file, of the folder or of the machine, has a say in the result (KTD33): a file is its
// bytes and whether it may be run, a link is where it points, and a folder is its
// entries. An engineer who checks a copy needs Node and nothing else.

import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { FILE_MODES, LINK_MODE, TREE_MODE, gitBlobHash, gitTreeHash } from "@cairnfield/protocol";
import type { FolderEntry } from "@cairnfield/protocol";
import { MAX_FILE_BYTES } from "./checkout.ts";

const SEPARATOR = Buffer.from("/");
/** Where a clone keeps Git's own files. They are not part of the tree. */
const GIT_FOLDER = Buffer.from(".git");
/** The bit that says the owner of a file may run it, which is the one Git reads. */
const OWNER_MAY_RUN = 0o100;
const [PLAIN, RUNNABLE] = FILE_MODES;

/**
 * The entries of the tree Git would write for a folder. Paths are bytes, because a tree
 * may hold any name. Returns nothing for a folder that holds what no tree can: a socket,
 * a device, a pipe. It also returns nothing for a file larger than a checkout may hold.
 * A file is hashed whole in memory, and no copy the command built holds one that large,
 * so it is not read.
 */
async function entriesOf(dir: Buffer, top: boolean): Promise<FolderEntry[] | undefined> {
  const entries: FolderEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, encoding: "buffer" })) {
    const name = entry.name;
    if (top && name.equals(GIT_FOLDER)) continue;
    const path = Buffer.concat([dir, SEPARATOR, name]);
    if (entry.isDirectory()) {
      const inner = await entriesOf(path, false);
      if (!inner) return undefined;
      // Git holds no empty folder, so one adds nothing to a tree.
      if (inner.length > 0) entries.push({ name, mode: TREE_MODE, hash: await gitTreeHash(inner) });
    } else if (entry.isSymbolicLink()) {
      entries.push({ name, mode: LINK_MODE, hash: await gitBlobHash(await readlink(path, { encoding: "buffer" })) });
    } else if (entry.isFile()) {
      const { mode, size } = await lstat(path);
      if (size > MAX_FILE_BYTES) return undefined;
      entries.push({ name, mode: (mode & OWNER_MAY_RUN) === 0 ? PLAIN : RUNNABLE, hash: await gitBlobHash(await readFile(path)) });
    } else {
      return undefined;
    }
  }
  return entries;
}

/** The file-tree hash of a folder, or nothing when the folder holds what no tree can. */
export async function folderTree(folder: string): Promise<string | undefined> {
  const entries = await entriesOf(Buffer.from(folder), true);
  return entries && gitTreeHash(entries);
}
