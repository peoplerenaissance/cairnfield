// The copy a team built of a pinned commit (KTD22): a plain folder, as a checkout is,
// and beside it a file that says what the copy is. The file is the team's own note of
// what it built. Nothing here is published: a lens that publishes recipes does that
// through the outbox and the fork (R25).

import { rename, rm } from "node:fs/promises";
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
/** Where a copy is exported before it counts as built. */
const stagedDir = (home: Home, component: string): string => `${copyDir(home, component)}.staged`;

/**
 * Takes away the copy of a pinned commit, kept, staged or cut short while it was being
 * exported, so a run that builds none leaves none behind.
 */
export async function dropCopy(home: Home, component: string): Promise<void> {
  await rm(copyFile(home, component), { force: true });
  for (const dir of [copyDir(home, component), stagedDir(home, component), `${stagedDir(home, component)}.partial`]) {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Exports a copy that the scratch repo holds, beside where it will be kept. This runs
 * before anything is published, so a copy that cannot be exported publishes nothing.
 */
export async function stageCopy(home: Home, scratch: Scratch, copy: Copy): Promise<void> {
  await exportTree(scratch, copy.commit, stagedDir(home, copy.component));
}

/** Puts a staged copy in its place and writes its file. The file is written last, so a copy that was cut short does not count as built. */
export async function keepCopy(home: Home, copy: Copy): Promise<void> {
  await rename(stagedDir(home, copy.component), copyDir(home, copy.component));
  await writeWhole(copyFile(home, copy.component), copy);
}
