// The copy a team built of a pinned commit (KTD22): a plain folder, as a checkout is,
// and beside it a file that says what the copy is. The file is the team's own note of
// what it built. Nothing here is published: a lens that publishes recipes does that
// through the outbox and the fork (R25).

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { exportTree, writeWhole } from "./checkout.ts";
import type { Home } from "./config.ts";
import type { Scratch } from "./git.ts";

/** What a built copy is: the pinned commit, the patches in it by ID and in order, its file-tree hash and its commit. */
export interface Copy {
  readonly component: string;
  readonly patches: readonly string[];
  readonly tree: string;
  readonly commit: string;
}

export const copyDir = (home: Home, component: string): string => join(home.copies, component);
const copyFile = (home: Home, component: string): string => join(home.copies, `${component}.json`);

/** Takes away the copy of a pinned commit, so a run that builds none leaves none behind. */
export async function dropCopy(home: Home, component: string): Promise<void> {
  await rm(copyFile(home, component), { force: true });
  await rm(copyDir(home, component), { recursive: true, force: true });
}

/**
 * Exports a copy that the scratch repo holds, and writes its file. The file is written
 * last, so a copy that was cut short does not count as built.
 */
export async function saveCopy(home: Home, scratch: Scratch, copy: Copy): Promise<void> {
  await exportTree(scratch, copy.commit, copyDir(home, copy.component));
  await writeWhole(copyFile(home, copy.component), copy);
}
