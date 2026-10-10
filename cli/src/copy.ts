// The copy a team built of a pinned commit (KTD22): a plain folder, as a checkout is,
// and beside it a file that says what the copy is. The file is the team's own note of
// what it built. Nothing here is published: a lens that publishes recipes does that
// through the outbox and the fork (R25).

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_RECIPE_PATCHES, conforms, field } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import { exportTree, writeWhole } from "./checkout.ts";
import type { Home } from "./config.ts";
import type { Scratch } from "./git.ts";
import { EXIT, stop } from "./outcome.ts";

/** What a built copy is: the pinned commit, the patches in it by ID and in order, its file-tree hash and its commit. */
const COPY = field.shape({
  component: field.gitHash(),
  patches: field.listOf(field.sha256(), MAX_RECIPE_PATCHES),
  tree: field.gitHash(),
  commit: field.gitHash(),
});
export type Copy = Infer<typeof COPY>;

export const copyDir = (home: Home, component: string): string => join(home.copies, component);
const copyFile = (home: Home, component: string): string => join(home.copies, `${component}.json`);

/** Reads what the team built of a pinned commit. Returns nothing when it built no copy. */
export async function readCopy(home: Home, component: string): Promise<Copy | undefined> {
  let text: string;
  try {
    text = await readFile(copyFile(home, component), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return stop(EXIT.failed, "bad-copy", { component });
  }
  let copy: unknown;
  try {
    copy = JSON.parse(text);
  } catch {
    copy = undefined;
  }
  if (conforms(COPY, copy) || (copy as Copy).component !== component) return stop(EXIT.failed, "bad-copy", { component });
  return copy as Copy;
}

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
