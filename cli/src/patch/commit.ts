// The commit that carries a patch (KTD4): one commit whose parent is the pinned commit,
// on the ref `patch/<component-commit>/<patch-id>` of the team's fork.
//
// The message, the author, the committer and both dates are fixed (KTD17). The same
// edits on the same pinned commit then give the same commit hash on every machine, so a
// repeat push changes nothing and a replay names the same commit as the live run did.

import { isSha256 } from "@cairnfield/protocol";
import { commitChanges, listRefs } from "../git.ts";
import type { Access, Scratch } from "../git.ts";
import type { Draft } from "./edits.ts";

const MESSAGE = "Cairnfield patch";

/** What the name of every patch branch of a fork starts with. */
const patchRefs = (component: string): string => `refs/heads/patch/${component}/`;

/** The branch of a fork that holds one patch. */
export const patchRef = (component: string, patchId: string): string => `${patchRefs(component)}${patchId}`;

/**
 * Builds the commit of a patch in a scratch repo that holds the pinned commit. Returns
 * its hash. The tree is the pinned tree with the patch's new blobs at the paths it changes.
 */
export function commitPatch(scratch: Scratch, component: string, patch: Pick<Draft, "changes" | "blobs">): Promise<string> {
  return commitChanges(scratch, component, patch.changes, patch.blobs, MESSAGE);
}

/** Pushes a patch commit to its ref in the fork. A ref that holds the commit already stays as it is. */
export async function pushPatch(scratch: Scratch, access: Access, component: string, patchId: string, commit: string): Promise<void> {
  await scratch.git("push", ["push", "--porcelain", access.remote, `${commit}:${patchRef(component, patchId)}`], { access });
}

/**
 * The IDs of the patches a fork holds a branch for, by the names of its refs. A name comes
 * from the fork, so it counts only when it is exactly the branch of one patch ID (KTD33).
 * A fork holds other refs too, such as the branch of a copy, and none of them counts.
 */
export async function pushedPatches(scratch: Scratch, access: Access, component: string): Promise<Set<string>> {
  const prefix = patchRefs(component);
  const refs = await listRefs(scratch, access, prefix);
  return new Set(refs.map((ref) => ref.slice(prefix.length)).filter((patchId) => isSha256(patchId)));
}
