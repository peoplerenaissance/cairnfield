// The commit that carries a patch (KTD4): one commit whose parent is the pinned commit,
// on the ref `patch/<component-commit>/<patch-id>` of the team's fork.
//
// The message, the author, the committer and both dates are fixed (KTD17). The same
// edits on the same pinned commit then give the same commit hash on every machine, so a
// repeat push changes nothing and a replay names the same commit as the live run did.

import { commitChanges } from "../git.ts";
import type { Access, Scratch } from "../git.ts";
import type { Draft } from "./edits.ts";

const MESSAGE = "Cairnfield patch";

/** The branch of a fork that holds one patch. */
export const patchRef = (component: string, patchId: string): string => `refs/heads/patch/${component}/${patchId}`;

/**
 * Builds the commit of a draft in a scratch repo that holds the pinned commit. Returns
 * its hash. The tree is the pinned tree with the draft's new blobs at the paths it changes.
 */
export function commitPatch(scratch: Scratch, component: string, draft: Draft): Promise<string> {
  return commitChanges(scratch, component, draft.changes, draft.blobs, MESSAGE);
}

/** Pushes a patch commit to its ref in the fork. A ref that holds the commit already stays as it is. */
export async function pushPatch(scratch: Scratch, access: Access, component: string, patchId: string, commit: string): Promise<void> {
  await scratch.git("push", ["push", "--porcelain", access.remote, `${commit}:${patchRef(component, patchId)}`], { access });
}
