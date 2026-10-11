// Puts the demo back to its start (R27), so `npm run demo` plays from a reset state:
// both demo nodes hold no record, and the index holds none.
//
//   npm run demo:reset
//
// A published record is never edited or deleted (KTD1). This script is the one exception,
// and it is for the two demo nodes only: it adds a commit with an empty tree to each
// node's repo of records, so the branch lists no record and its history still holds every
// one. It deletes no repo, because Artifacts accepts a delete before it has completed.
// The forks keep their patch commits and their copies. A replay builds the same commits
// again, so they are as a run leaves them.
//
// The order matters. The index drops no record a node has stopped listing, and a sync
// that began before a reset could store old records after it. So the script empties the
// nodes first, sends a notice for each, and waits until the index reports each emptied
// head as processed. Only then does it have the index drop its records (R12). It ends
// once the index has read both nodes again: a claim the index first sees while it
// rebuilds counts as expired (KTD13), and the demo's claims must not.
//
// It reads the addresses of the two demo nodes and the index from TEAM_A_NODE_URL,
// TEAM_B_NODE_URL and INDEX_URL, each node's admin key from TEAM_A_ADMIN_KEY and
// TEAM_B_ADMIN_KEY, and the index's reset key from CAIRNFIELD_RESET_KEY. It prints no
// key, no token and no Git remote.
//
// It exits with 0 when the demo is at its start, 1 when a step failed and 2 when it cannot start.

import { rm } from "node:fs/promises";
import { INDEX_ROUTES, TEAM_BRANCH } from "@cairnfield/protocol";
import { loadHome } from "../cli/src/config.ts";
import { fetchRef, said, withScratch } from "../cli/src/git.ts";
import { callIndex, repoAccess } from "../cli/src/services.ts";
import { PLUGIN, RESET_KEY, halt, launch, listingOf, notFound, notify, processed, settle, untilView } from "./demo-stage.ts";
import type { Label, Stage, Team } from "./demo-stage.ts";

const BRANCH = `refs/heads/${TEAM_BRANCH}`;
const MESSAGE = "Empty the records for a demo reset";

/** The head of each node's repo of records after the reset. A node that never held a record has none. */
export type Emptied = { readonly [team in Label]?: string };

/**
 * Leaves a node's repo of records with no record on its branch. Returns the head of the
 * branch, or nothing for a node that has no such repo yet. A branch that lists no record
 * already is left as it is.
 */
async function empty(stage: Stage, team: Team): Promise<string | undefined> {
  const held = await listingOf(stage, team);
  if (!held || held.records.length === 0) return held?.head;
  stage.say(`${team.label}: takes ${held.records.length} records off the branch of its repo of records`);
  // The command's calls to a node go through a team's config file. This one names the node and nothing else of the demo.
  await settle(stage, team, { shares: false });
  const access = await repoAccess(team.io, await loadHome(team.io, undefined), { repo: "team", scope: "write" });
  return withScratch(team.io, async (scratch) => {
    const head = await fetchRef(scratch, access, BRANCH);
    // With nothing on its input, `mktree` writes the tree that holds no file.
    const tree = said(await scratch.git("mktree", ["mktree"], { input: new Uint8Array(0) }));
    const emptied = said(await scratch.git("commit-tree", ["commit-tree", tree, "-p", head, "-m", MESSAGE]));
    // The commit sits on the head, so the push moves the branch forward and rewrites nothing.
    await scratch.git("push", ["push", "--porcelain", access.remote, `${emptied}:${BRANCH}`], { access });
    return emptied;
  });
}

/** Whether the index has the demo plugin's first commit registered. A view of it lists the nodes, with the head the index last processed for each. */
async function indexHoldsTheDemo(stage: Stage): Promise<boolean> {
  const answer = await callIndex(stage.io, stage.index, INDEX_ROUTES.view, { params: { component: PLUGIN.first } });
  if (answer.ok) return true;
  return notFound(answer) ? false : halt("the index gave no view");
}

/** Empties both nodes, then the index. Returns each node's head. */
export async function reset(stage: Stage, resetKey: string): Promise<Emptied> {
  const heads: (readonly [Team, string])[] = [];
  for (const team of [stage.a, stage.b]) {
    const head = await empty(stage, team);
    if (head !== undefined) heads.push([team, head]);
  }

  // A node the index does not know is read by no sync, and neither is one with no head. Nothing waits for either.
  const read: (readonly [Team, string])[] = [];
  if (await indexHoldsTheDemo(stage)) {
    for (const [team, head] of heads) if (await notify(stage, team)) read.push([team, head]);
  }
  const untilRead = (awaited: string): Promise<unknown> => untilView(stage, PLUGIN.first, awaited, (view) => processed(view, read));
  if (read.length > 0) await untilRead("the emptied nodes");

  stage.say("The index drops its records and reads every node again.");
  const dropped = await callIndex(stage.io, stage.index, INDEX_ROUTES.reset, { key: resetKey });
  if (!dropped.ok) halt(`the index did not take the reset: ${dropped.error === "refused" ? dropped.reason : dropped.error}`);
  if (read.length > 0) await untilRead("the emptied nodes again, after its reset");
  return Object.fromEntries(heads.map(([team, head]) => [team.label, head]));
}

if (import.meta.main) {
  await launch("reset", RESET_KEY, async (stage, resetKey) => {
    try {
      console.log(JSON.stringify(await reset(stage, resetKey)));
    } finally {
      // The folder of this run held a config file for each node the script emptied, and nothing to keep.
      await rm(stage.work, { recursive: true, force: true });
    }
  });
}
