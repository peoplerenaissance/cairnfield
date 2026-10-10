// The copy a team built of a pinned commit (KTD22): a plain folder, as a checkout is,
// and beside it a file that says what the copy is. The file is the team's own note of
// what it built. Nothing here is published: a lens that publishes recipes does that
// through the outbox and the fork (R25).

import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_RECIPE_PATCHES, field } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import { exportTree, readWhole, writeWhole } from "./checkout.ts";
import type { Home } from "./config.ts";
import type { Scratch } from "./git.ts";
import { EXIT, stop } from "./outcome.ts";

const COPY = field.shape({
  component: field.gitHash(),
  patches: field.listOf(field.sha256(), MAX_RECIPE_PATCHES),
  tree: field.gitHash(),
  commit: field.gitHash(),
});
/** What a built copy is: the pinned commit, the patches in it by ID and in order, its file-tree hash and its commit. */
export type Copy = Infer<typeof COPY>;

export const copyDir = (home: Home, component: string): string => join(home.copies, component);
const copyFile = (home: Home, component: string): string => join(home.copies, `${component}.json`);
/** Where a copy is exported before it counts as built. */
const stagedDir = (home: Home, component: string): string => `${copyDir(home, component)}.staged`;

/** Reads what the team built of a pinned commit. Returns nothing when it built no copy. */
export async function readCopy(home: Home, component: string): Promise<Copy | undefined> {
  const bad = (): never => stop(EXIT.failed, "bad-copy", { component });
  const copy = await readWhole(copyFile(home, component), COPY, bad);
  return copy && copy.component !== component ? bad() : copy;
}

/** Takes away the copy of a pinned commit, staged or kept, so a run that builds none leaves none behind. */
export async function dropCopy(home: Home, component: string): Promise<void> {
  await rm(copyFile(home, component), { force: true });
  await rm(copyDir(home, component), { recursive: true, force: true });
  await rm(stagedDir(home, component), { recursive: true, force: true });
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
