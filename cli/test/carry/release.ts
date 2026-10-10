// What the carry tests share: a newer commit of the small component of the assembly
// tests, as a release of it, a patch whose findings a test writes itself, and what the
// command says of each finding and patch.

import { SCHEMA_VERSION, TEAM_BRANCH } from "@cairnfield/protocol";
import type { Outcome } from "../../src/outcome.ts";
import { TREE, refsOf } from "../assemble/team.ts";
import { commitEntries, forkCommit, git, holdRecords, patchIdOf, published } from "../support.ts";
import type { Bench, Change, Entry } from "../support.ts";

/** The small component with some paths given new content, added, or taken out when the content is nothing. */
export function tree(changes: { readonly [path: string]: string | undefined }): Entry[] {
  const kept = TREE.filter((entry) => !Object.hasOwn(changes, entry.path));
  const put = Object.entries(changes).flatMap(([path, content]) =>
    content === undefined ? [] : [{ ...TREE.find((entry) => entry.path === path), path, content }],
  );
  return [...kept, ...put];
}

/**
 * Makes a newer commit of the component that `pinTree` pinned, on the older one, and has
 * the node hold a copy of it, as an import of the branch would. Returns the commit.
 */
export function release(on: Bench, older: string, entries: readonly Entry[]): string {
  const source = on.repo("source");
  const newer = commitEntries(source, entries, older);
  git(source, ["push", "--quiet", on.createRepo(`copy-${newer}`), TEAM_BRANCH]);
  return newer;
}

/**
 * Makes a newer commit that holds the older one's tree and as many more paths as asked
 * for, each with the content and mode of one file of it, and has the node hold a copy of
 * it. No blob is new, and the paths go to Git in one call: a call for each, as
 * `commitEntries` makes, takes minutes for thousands of paths. Returns the commit.
 */
export function releaseWithCopies(on: Bench, older: string, of: string, copies: number): string {
  const source = on.repo("source");
  git(source, ["read-tree", older]);
  // `<mode> blob <hash>`, a tab, the path.
  const [mode = "", , blob = ""] = git(source, ["ls-tree", older, "--", of]).split(/[ \t]/);
  git(source, ["update-index", "--index-info"], Array.from({ length: copies }, (_, at) => `${mode} ${blob}\tcopies/${at}.txt\n`).join(""));
  const newer = git(source, ["commit-tree", git(source, ["write-tree"]), "-p", older, "-m", "a test commit"]);
  git(source, ["update-ref", `refs/heads/${TEAM_BRANCH}`, newer]);
  git(source, ["push", "--quiet", on.createRepo(`copy-${newer}`), TEAM_BRANCH]);
  return newer;
}

export const carry = (on: Bench, older: string, newer: string): Promise<Outcome> => on.run("carry", older, newer, "--branch", TEAM_BRANCH);

/** A patch of the team's own for findings the test wrote: where it is, and the patch ID its commit amounts to. */
export interface Patched {
  /** The ID of the patch record. */
  readonly id: string;
  readonly commit: string;
  readonly patchId: string;
  /** The IDs of the findings, in the order they were given. */
  readonly findings: readonly string[];
}

/** Has the team publish findings and a patch that cites them all: the records go to its team repo, and the commit to its fork. */
export async function patchCiting(on: Bench, component: string, findings: readonly object[], changes: readonly Change[]): Promise<Patched> {
  const cited = await holdRecords(on, findings);
  const commit = forkCommit(on, on.repo(`copy-${component}`), component, changes);
  const record = { version: SCHEMA_VERSION, type: "patch", component, commit, findings: [...cited].sort(), model: "none" };
  const [id = ""] = await holdRecords(on, [record]);
  return { id, commit, patchId: await patchIdOf(on.repo(`fork-${component}`), component, commit), findings: cited };
}

/** What the command says of one finding or one patch. */
export interface Said {
  readonly finding?: string;
  readonly patch?: string;
  readonly patchId?: string;
  readonly carried: boolean;
  readonly reason: string;
  readonly as?: string;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly commit?: string;
  readonly check?: string;
}

export const findingsSaid = (outcome: Outcome): Said[] => outcome.output["findings"] as Said[];
export const patchesSaid = (outcome: Outcome): Said[] => outcome.output["patches"] as Said[];

/** The record files the team repo holds for one commit, by their path there. */
export const recordsAt = (on: Bench, component: string): string[] => published(on).filter((path) => path.startsWith(`records/${component}/`));

/** One record of the team repo, as its file holds it. */
export function recordOf(on: Bench, component: string, type: string, id: string): unknown {
  return JSON.parse(git(on.repo("team"), ["show", `${TEAM_BRANCH}:records/${component}/${type}/${id}.json`]));
}

/** Each patch ref of a fork with the commit it points to. */
export const patchRefs = (on: Bench, component: string): string[] => refsOf(on.repo(`fork-${component}`)).filter((ref) => ref.startsWith("refs/heads/patch/"));

/**
 * Puts a patch the team made by hand on the ref of its patch ID in the team's fork, where
 * `patch` and `carry` leave one (KTD4). The bench's hand-made commit sits on a ref named
 * by its commit.
 */
export function onPatchRef(on: Bench, component: string, made: { readonly patchId: string; readonly commit: string }): void {
  git(on.repo(`fork-${component}`), ["update-ref", `refs/heads/patch/${component}/${made.patchId}`, made.commit]);
}
