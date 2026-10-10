// Which of a team's own patches move to a newer commit of a component (R37, KTD39).
//
// A patch is a set of content replacements (KTD4). It names no commit and no path, so it
// carries when the newer commit still holds every content it replaces, with the mode it
// replaces, and every finding it cites carried. Its replacements then go to every path
// of the newer commit that holds them, and the patch checks run on the result against
// the carried findings. The patch ID covers the replacements and nothing else, so it
// comes out the same.
//
// A patch is placed by content, so it may change other paths than it did. It moved when
// it no longer changes a path it changed at the older commit. One more copy to rewrite
// is one more path, and no move.
//
// A patch is read as assembly reads one (see `assemble/verify.ts`): its record from the
// team's own repo and its commit from the team's own fork, checked again as a patch on
// the older commit. So what is carried is what the commit does, not what a record says.
//
// Every patch here is the team's own, so a read of the team's node that fails is no
// refusal. It ends the command with the failure's own outcome, and is never an entry. A
// patch is `refused` for what a check found in it, or for what the node answered: a
// record it lists and does not serve, or a fork it does not have. A fetch of its commit
// from the fork that fails is `refused` too, with `git-failed`. That is how a fetch
// failure is reported today.

import { applyChanges, checkPatch, citedRanges, compare } from "@cairnfield/protocol";
import type { FileEntry, Patch } from "@cairnfield/protocol";
import type { Candidate } from "../assemble/select.ts";
import { verify } from "../assemble/verify.ts";
import type { Assembly } from "../assemble/verify.ts";
import type { Listing } from "../checkout.ts";
import { EXIT, stop } from "../outcome.ts";
import type { Carried } from "./findings.ts";

/** What the output says of a patch that does not carry. */
type NotCarried =
  /** The newer commit lacks a content the patch replaces, or a finding the patch cites did not carry. */
  | { readonly patchId: string; readonly carried: false; readonly reason: "content-changed" | "finding-not-carried" }
  /** A check refused the patch, at the older commit or on the newer one. `check` is that check's code. A patch refused at the older commit has no patch ID. A read of the node that failed is never this: it ends the command. */
  | { readonly patchId?: string; readonly carried: false; readonly reason: "refused"; readonly check: string };

/** Why a patch carried: it still changes every path it changed at the older commit, or it no longer changes one of them. */
type CarriedReason = "content-unchanged" | "content-moved";

/** What became of one patch record of the team's at the older commit. A reason is a code from a closed list. */
export type PatchEntry = { readonly patch: string } & (
  /** Built again on the newer commit as `commit`, and announced there by the record `as`. `paths` holds every path that commit changes, sorted. */
  | { readonly patchId: string; readonly carried: true; readonly reason: CarriedReason; readonly as: string; readonly commit: string; readonly paths: readonly string[] }
  | NotCarried
);

/** A patch that carries, before it is a commit on the newer commit. */
export interface Carrying {
  readonly patchId: string;
  readonly reason: CarriedReason;
  /** Every path of the newer commit that the patch changes, sorted. */
  readonly paths: readonly string[];
  /** Each of those paths with its new mode and blob, or the deletion marker. */
  readonly changes: readonly FileEntry[];
  /** The content of each new blob, by its hash. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  /** The patch record for the newer commit, short of the commit, which is not built yet. */
  readonly record: Omit<Patch, "commit">;
}

export type Decided = ({ readonly carried: true } & Carrying) | NotCarried;

/**
 * Decides one patch record of the team's own. `run` is the older commit as assembly
 * works with one, and `findings` holds what each finding that carried became, by the ID
 * it had at the older commit. Nothing is written here: the caller builds the commit. The
 * caller sets `failedReadEnds` on `run`, so a read of the node that fails ends the command here.
 */
export async function carryPatch(run: Assembly, newer: Listing, findings: ReadonlyMap<string, Carried>, candidate: Candidate): Promise<Decided> {
  const verdict = await verify(run, candidate);
  if (!verdict.ok) return { carried: false, reason: "refused", check: verdict.reason };
  const { facts, before, after } = verdict;
  const { patchId, replacements } = facts;

  const held = new Set(newer.files.map((file) => `${file.blob} ${file.mode}`));
  if (!replacements.every(({ oldBlob, oldMode }) => held.has(`${oldBlob} ${oldMode}`))) return { patchId, carried: false, reason: "content-changed" };
  // A carried patch cites no claim of the older commit, and each finding by its ID at the newer
  // one. What else its record says stays: its model, and the sources of a merged patch, which are patch IDs.
  const { claim, commit, ...announced } = verdict.record;
  const cited = announced.findings.flatMap((id) => findings.get(id) ?? []);
  if (cited.length < announced.findings.length) return { patchId, carried: false, reason: "finding-not-carried" };

  // Every path that holds a replaced content with the replaced mode gets the new ones.
  const replacing = new Map(replacements.map((replacement) => [`${replacement.oldBlob} ${replacement.oldMode}`, replacement]));
  const changes = newer.files.flatMap(({ path, mode, blob }): FileEntry[] => {
    const replacement = replacing.get(`${blob} ${mode}`);
    return replacement ? [{ path, mode: replacement.newMode, blob: replacement.newBlob }] : [];
  });
  // The newer commit may hold a copy the older one did not, so the patch is checked again
  // where it lands. A copy with a mode the patch does not replace leaves it incomplete.
  const checked = await checkPatch({
    base: { files: newer.files, content: before },
    patched: { files: applyChanges(newer.files, changes), content: after },
    cited: citedRanges(cited.map(({ record }) => record), newer.files),
  });
  if (!checked.ok) return { patchId, carried: false, reason: "refused", check: checked.reason };
  // The same replacements give the same patch ID (KTD4). Any other ID is not this patch.
  if (checked.patchId !== patchId) return stop(EXIT.failed, "carry-failed");

  // The patch moved when it no longer changes a path it changed at the older commit.
  const lands = new Set(checked.paths);
  const reason = facts.paths.every((path) => lands.has(path)) ? "content-unchanged" : "content-moved";
  const record = { ...announced, component: newer.component, findings: [...new Set(cited.map(({ id }) => id))].sort(compare) };
  return { carried: true, patchId, reason, paths: checked.paths, changes, blobs: after, record };
}
