// The commit that carries a patch (KTD4): one commit whose parent is the pinned commit,
// on the ref `patch/<component-commit>/<patch-id>` of the team's fork.
//
// The message, the author, the committer and both dates are fixed (KTD17). The same
// edits on the same pinned commit then give the same commit hash on every machine, so a
// repeat push changes nothing and a replay names the same commit as the live run did.

import { join } from "node:path";
import { inputLines, said, writeBlobs } from "../git.ts";
import type { Access, Scratch } from "../git.ts";
import { EXIT, stop } from "../outcome.ts";
import type { Draft } from "./edits.ts";

const MESSAGE = "Cairnfield patch";
/** The author and committer date of every patch commit, in Git's own form: seconds since 1970 and a time zone. */
const DATE = "1760000000 +0000";

/** The branch of a fork that holds one patch. */
export const patchRef = (component: string, patchId: string): string => `refs/heads/patch/${component}/${patchId}`;

/**
 * Builds the commit of a draft in a scratch repo that holds the pinned commit. Returns
 * its hash. The tree is the pinned tree with the draft's new blobs at the paths it changes.
 */
export async function commitPatch(scratch: Scratch, component: string, draft: Draft): Promise<string> {
  const contents = [...draft.blobs];
  const written = await writeBlobs(scratch, contents.map(([, content]) => content));
  // Git and the protocol must agree on every blob, or the commit is not the patch that was checked.
  if (written.some((blob, at) => blob !== contents[at]?.[0])) stop(EXIT.git, "git-failed", { step: "hash-object" });

  const index = join(scratch.dir, "patch-index");
  await scratch.git("read-tree", ["read-tree", component], { index });
  await scratch.git("update-index", ["update-index", "--index-info"], {
    index,
    input: inputLines(draft.changes.map(({ path, mode, blob }) => `${mode} blob ${blob}\t${path}`)),
  });
  const tree = said(await scratch.git("write-tree", ["write-tree"], { index }));
  return said(await scratch.git("commit-tree", ["commit-tree", tree, "-p", component, "-m", MESSAGE], { date: DATE }));
}

/** Pushes a patch commit to its ref in the fork. A ref that holds the commit already stays as it is. */
export async function pushPatch(scratch: Scratch, access: Access, component: string, patchId: string, commit: string): Promise<void> {
  await scratch.git("push", ["push", "--porcelain", access.remote, `${commit}:${patchRef(component, patchId)}`], { access });
}
