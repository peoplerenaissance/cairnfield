// What the carry tests share: a newer commit of the small component of the assembly
// tests, as a release of it, a patch whose findings a test writes itself, and what the
// command says of each finding and patch.

import { SCHEMA_VERSION, TEAM_BRANCH } from "@cairnfield/protocol";
import type { Outcome } from "../../src/outcome.ts";
import { TREE } from "../assemble/team.ts";
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
export function patchRefs(on: Bench, component: string): string[] {
  const listed = git(on.repo(`fork-${component}`), ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/patch/"]);
  return listed === "" ? [] : listed.split("\n");
}
