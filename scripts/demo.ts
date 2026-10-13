// The demo, played from one script (R27): two teams, four steps, from the saved outboxes
// and the recordings under `fixtures/`. It calls no model (R20). Every patch is a replay,
// so a run from a reset state gives the record IDs, patch IDs and file-tree hashes of
// every other.
//
//   1. Team A works alone, with no index: pin, publish its saved findings, patch the
//      any-host rule, build its copy, record a verdict, check a clone of the copy.
//   2. Team A adds the index. Team B pins and publishes. Both teams claim and patch at
//      the same moment: both remove the hidden instruction, and Team B narrows the
//      variables the plugin may read. Team B also publishes a patch made by hand that
//      changes a line its finding does not cite (KTD26).
//   3. Team A names Team B in its lens and builds its copy again, with Team B's patch.
//   4. Team A carries its own work to the plugin's later commit and builds its copy there.
//
// Run it from the repo root, after `npm run demo:reset`:
//
//   npm run demo
//
// It starts only from the reset state: two nodes that list no record and an index that
// holds none of the demo. A deployment that has published nothing is in that state.
//
// It reads the addresses of the two demo nodes and the index from TEAM_A_NODE_URL,
// TEAM_B_NODE_URL and INDEX_URL, each node's admin key from TEAM_A_ADMIN_KEY and
// TEAM_B_ADMIN_KEY, and the index's registration key from CAIRNFIELD_REGISTRATION_KEY.
// It prints no key, no token and no Git remote. A verdict is a person's to give: the one
// this script records is the demo operator's, written down here ahead of time.
//
// It checks what each step must leave behind and stops at the first thing that is not
// there. It exits with 0 when every step did, 1 when one did not and 2 when it cannot start.

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readRecording } from "../cli/src/agents/replay.ts";
import { copyRef } from "../cli/src/commands/assemble.ts";
import { REGISTRATION_KEY, loadHome } from "../cli/src/config.ts";
import type { Verdict } from "../cli/src/decisions.ts";
import { fetchCommit, fetchRef, said, withScratch } from "../cli/src/git.ts";
import type { Outcome } from "../cli/src/outcome.ts";
import { pushPatch } from "../cli/src/patch/commit.ts";
import { adminKey, forkAccess, writableFork } from "../cli/src/services.ts";
import { FIXTURES, PLUGIN, command, engineer, halt, headOf, launch, listingOf, notify, processed, settle, untilView, viewNow } from "./demo-stage.ts";
import type { Stage, Team } from "./demo-stage.ts";

const { first, later } = PLUGIN;

// The findings the patch agents worked on, by ID. Each is in a team's saved outbox.
/** `plugin.json` lets the plugin reach any host. Team A found it. */
const ANY_HOST = "72b5c551a1e4d6e2a878068dfd3dc3eceac11ed32d56e0110d54dcc67fd83ba9";
/** The instruction hidden in the skill file, which sends data to a host. Both teams found it. */
const HIDDEN_INSTRUCTION = "981ae3aa8aadd84d9f44c609c4302727d91b4d381b92c124d7216879aa665b08";
/** `plugin.json` lets the plugin read every environment variable. Team B found it, on the line after the any-host rule. */
export const EVERY_VARIABLE = "f8f4d273cee270d729eaa06f6868645a6e88335ce4953b8840f4bd55e8279614";

/**
 * The patch runs the demo replays (KTD18). A run with no recording for one of them does
 * not start. The two recordings for the hidden instruction are written by hand, with the
 * model `none`: in four live runs on that line the bundled agent wrote no patch. The other
 * two hold what a model wrote.
 */
const RUNS = [
  ["team-a", ANY_HOST],
  ["team-a", HIDDEN_INSTRUCTION],
  ["team-b", HIDDEN_INSTRUCTION],
  ["team-b", EVERY_VARIABLE],
] as const;

/** The patch made by hand that an index rejects (KTD26): its commit and the patch ID that commit amounts to. */
const OUT_OF_SCOPE = JSON.parse(await readFile(`${FIXTURES}out-of-scope/COMMIT.json`, "utf8")) as {
  readonly commit: string;
  readonly patchId: string;
};

/** The verdict the demo's operator gives each copy: the patches in it are the mitigations the team requires (R32). */
const VERDICT: Verdict = "approved-with-required-mitigations";

/** How long the page shows the three claims as live before the patches arrive (R15). */
const CLAIMS_SHOWN_MS = 10_000;

/** What a run made. Two runs from a reset state give the same (R20). */
export interface Shown {
  /** The record files each team's node holds, by their path, which ends in the record's ID (KTD1). */
  readonly records: { readonly "team-a": readonly string[]; readonly "team-b": readonly string[] };
  /** The ID of each patch the teams' agents wrote, by the finding it is for. */
  readonly patches: { readonly anyHost: string; readonly hiddenInstruction: string; readonly everyVariable: string };
  /** The file-tree hash of each copy Team A built: alone, with Team B's patch, and of the later commit. */
  readonly trees: { readonly alone: string; readonly withTeamB: string; readonly later: string };
}

interface PatchInCopy {
  readonly patchId: string;
  readonly node: string;
}

interface Built {
  readonly tree: string;
  readonly patches: readonly PatchInCopy[];
}

/** Stops the script unless a step left behind what the demo needs. */
function must(held: boolean, what: string): void {
  if (!held) halt(`the demo needs ${what}, and this run did not give it`);
}

const sameIds = (found: readonly string[], wanted: readonly string[]): boolean => JSON.stringify([...found].sort()) === JSON.stringify([...wanted].sort());

/** A list the command printed under one field. Anything else there stops the script, because a check would then read nothing. */
function listUnder(output: Outcome["output"], field: string): readonly { readonly [field: string]: unknown }[] {
  const value = output[field];
  return Array.isArray(value) ? (value as { readonly [field: string]: unknown }[]) : halt(`the command printed no list under ${field}`);
}

/** The patches `assemble` says went into a copy, each with its patch ID and the node it came from. */
function patchesIn(built: Outcome["output"]): PatchInCopy[] {
  return listUnder(built, "patches").map(({ patchId, node }) =>
    typeof patchId === "string" && typeof node === "string" ? { patchId, node } : halt("assemble printed a patch with no patch ID or no node"),
  );
}

/**
 * Stops the script unless the demo is at its start: neither node lists a record, and the
 * index holds none for the plugin's two commits. From any other state the steps would
 * pass on records that were there already, and no claim would be seen as live.
 */
async function mustBeAtTheStart(stage: Stage): Promise<void> {
  for (const team of [stage.a, stage.b]) {
    if (((await listingOf(stage, team))?.records.length ?? 0) > 0) halt(`${team.label}: the node holds records already. Run npm run demo:reset first`);
  }
  for (const component of [first, later]) {
    const view = await viewNow(stage, component);
    if (view && [view.claims, view.findings, view.patches, view.recipes, view.pending, view.rejected].some((held) => held.length > 0)) {
      halt("the index holds records of the demo already. Run npm run demo:reset first");
    }
  }
}

/**
 * The number of the claim each recording was made under (Appendix H). A missing recording
 * stops the script here, before it has made a call.
 */
async function recordedClaims(stage: Stage): Promise<(team: Team, finding: string) => string> {
  const numbers = new Map<string, number>();
  for (const [label, finding] of RUNS) {
    const recording = await readRecording(join(stage.recordings, label, first, `${finding}.json`), first, finding);
    if (!recording) halt(`no recording for ${label} and finding ${finding}. A replay calls no model, so the demo cannot go on without it`);
    numbers.set(`${label} ${finding}`, recording.claim);
  }
  return (team, finding) => String(numbers.get(`${team.label} ${finding}`));
}

/** Copies record files that are laid out as an outbox into a team's outbox, as a person or the team's own agent writes them there (R21). */
async function toOutbox(team: Team, folder: string): Promise<void> {
  const { outbox } = await loadHome(team.io, undefined);
  await cp(`${FIXTURES}${folder}/records`, join(outbox, "records"), { recursive: true });
}

const pin = (stage: Stage, team: Team, commit: string): Promise<Outcome["output"]> =>
  command(stage, team, "pin", PLUGIN.url, "--branch", PLUGIN.branch, "--commit", commit);

/** Replays the recording of one patch run. Returns the patch ID. */
async function replay(stage: Stage, team: Team, finding: string): Promise<string> {
  return String((await command(stage, team, "patch", first, "--finding", finding, "--replay"))["patchId"]);
}

/**
 * Puts the copy a team published where an engineer would install it: the branch
 * `copy/<commit>` of the team's fork, fetched with the read token the node gives anyone
 * (KTD7), and checked out by Git into a folder of the run.
 */
async function install(stage: Stage, team: Team, component: string, name: string): Promise<string> {
  stage.say(`engineer: fetches the copy ${team.label} published, with the read token its node gives anyone, into ${name}/`);
  const fork = await forkAccess(stage.io, team.node, component);
  if (!fork.ok) return halt(`${team.label}: the node gave no read token for its fork`);
  const folder = join(stage.work, name);
  await mkdir(folder);
  await withScratch(stage.io, async (scratch) => {
    const commit = await fetchRef(scratch, fork.body, copyRef(component));
    await scratch.git("checkout", [`--work-tree=${folder}`, "checkout", "--quiet", commit, "--", "."]);
  });
  return folder;
}

/**
 * Builds a team's copy of a commit, records the verdict for the tree `assemble` printed,
 * and checks the published copy against the team's table as an engineer on another
 * machine does (R25, R32, R36).
 */
async function approve(stage: Stage, team: Team, component: string, name: string): Promise<Built> {
  const built = await command(stage, team, "assemble", component);
  const tree = built["tree"];
  if (typeof tree !== "string") return halt(`${team.label}: no patch went into the copy`);
  await command(stage, team, "decide", component, "--verdict", VERDICT, "--tree", tree);
  const folder = await install(stage, team, component, name);
  // The team shares its table by its own means. Here the engineer is handed what `approvals` prints, saved as a file.
  const approvals = join(stage.work, `${name}.approvals.json`);
  await writeFile(approvals, `${JSON.stringify(await command(stage, team, "approvals"))}\n`);
  await engineer(stage, "verify", PLUGIN.url, folder, "--approvals", approvals);
  return { tree, patches: patchesIn(built) };
}

/** Step one: Team A alone, with no index in its config (R38). */
async function alone(stage: Stage): Promise<{ readonly anyHost: string; readonly copy: Built }> {
  const { a } = stage;
  stage.say("Step one. Team A works alone. Its config names no index.");
  await settle(stage, a, { lens: "team-a-alone.json", shares: false });
  await pin(stage, a, first);
  await toOutbox(a, "outboxes/team-a");
  await command(stage, a, "publish");
  const anyHost = await replay(stage, a, ANY_HOST);
  const copy = await approve(stage, a, first, "alone");
  must(sameIds(copy.patches.map(({ patchId }) => patchId), [anyHost]), "a first copy that holds Team A's any-host patch and no other");
  return { anyHost, copy };
}

/**
 * Team B's work by hand (KTD26): a finding that cites one line, and a commit that also
 * changes a line the finding does not cite. The command's own checks would refuse the
 * commit, so it is built by the fixture's script and pushed to the team's fork by Git.
 * The records go out through the outbox, as any record a person writes (R21).
 */
async function publishByHand(stage: Stage, team: Team): Promise<void> {
  stage.say(`${team.label}: builds a patch commit by hand and pushes it to its fork`);
  const access = await writableFork(team.io, await loadHome(team.io, undefined), adminKey(team.io), first);
  await withScratch(team.io, async (scratch) => {
    await fetchCommit(scratch, access, first);
    const repo = said(await scratch.git("rev-parse", ["rev-parse", "--absolute-git-dir"]));
    // The script builds the commit with its own fixed author and date, and fails unless it is the commit in COMMIT.json.
    await promisify(execFile)("sh", [`${FIXTURES}out-of-scope/build-commit.sh`, repo], { env: { PATH: stage.io.env["PATH"] ?? "" } });
    await pushPatch(scratch, access, first, OUT_OF_SCOPE.patchId, OUT_OF_SCOPE.commit);
  });
  await toOutbox(team, "out-of-scope");
  await command(stage, team, "publish");
}

/** Step two: both teams share through the index, and their patch agents run at the same moment (R15, R16). */
async function together(stage: Stage, anyHost: string, claimOf: (team: Team, finding: string) => string): Promise<Pick<Shown["patches"], "hiddenInstruction" | "everyVariable">> {
  const { a, b } = stage;
  stage.say("Step two. Team A adds the index to its config, and Team B joins.");
  await settle(stage, a, { lens: "team-a-alone.json", shares: true });
  // With an index in the config, `pin` registers the node and the commit (KTD12). The checkout stays as it is.
  await pin(stage, a, first);
  // Team A published before it had an index, so nothing has told the index yet. One notice does.
  const published = await headOf(stage, a);
  if (!(await notify(stage, a))) halt("the index does not know Team A's node");
  await untilView(stage, first, "Team A's records", (view) => view.state === "ready" && processed(view, [[a, published]]));

  await settle(stage, b, { lens: "team-b.json", shares: true });
  await pin(stage, b, first);
  await toOutbox(b, "outboxes/team-b");
  await command(stage, b, "publish");

  stage.say("Both teams' patch agents start. Each claims its finding first, so the other sees the work has begun.");
  const claim = async (team: Team, finding: string): Promise<string> => {
    const number = claimOf(team, finding);
    return String((await command(stage, team, "claim", first, "--kind", "patch", "--findings", finding, "--intent", "new", "--number", number))["claim"]);
  };
  // Team B's agent works on one finding and then on the other.
  const inTurn = async <T>(one: () => Promise<T>, other: () => Promise<T>): Promise<[T, T]> => [await one(), await other()];
  const claims = (
    await Promise.all([claim(a, HIDDEN_INSTRUCTION), inTurn(() => claim(b, HIDDEN_INSTRUCTION), () => claim(b, EVERY_VARIABLE))])
  ).flat();
  await untilView(stage, first, "the three patch claims as live", (view) => claims.every((id) => view.claims.some((shown) => shown.id === id && shown.state === "live")));
  // The patches would close the claims before a person saw them on the page.
  await stage.io.sleep(CLAIMS_SHOWN_MS);

  const [hiddenInstruction, [sameAsTeamA, everyVariable]] = await Promise.all([
    replay(stage, a, HIDDEN_INSTRUCTION),
    inTurn(() => replay(stage, b, HIDDEN_INSTRUCTION), () => replay(stage, b, EVERY_VARIABLE)),
  ]);
  must(sameAsTeamA === hiddenInstruction, "both teams' recordings to remove the hidden instruction the same way");
  await publishByHand(stage, b);

  const heads: (readonly [Team, string])[] = [];
  for (const team of [a, b]) heads.push([team, await headOf(stage, team)]);
  const view = await untilView(stage, first, "both teams' work, with no patch still waiting", (seen) => processed(seen, heads) && seen.pending.length === 0);

  const both = view.patches.flatMap((group) => group.patches).filter((patch) => patch.nodes.length > 1);
  must(
    both.length === 1 && both[0]?.patchId === hiddenInstruction && sameIds(both[0].nodes, [a.node, b.node]),
    "one patch that both teams wrote, shown as one entry with two organizations",
  );
  const sideBySide = view.patches.filter((group) => group.patches.length > 1);
  must(
    sideBySide.length === 1 && sameIds(sideBySide[0]?.patches.map(({ patchId }) => patchId) ?? [], [anyHost, everyVariable]),
    "one group of two patches on adjoining lines, one from each team",
  );
  const rejected = view.rejected.filter(({ type }) => type === "patch");
  must(rejected.length === 1 && rejected[0]?.node === b.node && rejected[0].reason === "patch-out-of-scope", "one patch rejected as out of scope");
  return { hiddenInstruction, everyVariable };
}

/** Step three: Team A names Team B in its lens and takes its patch (R23, KTD38). */
async function takingTeamB(stage: Stage, built: Built, everyVariable: string): Promise<Built> {
  const { a, b } = stage;
  stage.say("Step three. Team A names Team B in its lens, and builds its copy again.");
  await settle(stage, a, { lens: "team-a-names-b.json", shares: true });
  const copy = await approve(stage, a, first, "with-team-b");
  must(copy.tree !== built.tree, "a copy with another file-tree hash than the one Team A built alone");
  must(copy.patches.some((patch) => patch.node === b.node && patch.patchId === everyVariable), "Team B's patch in Team A's copy");
  return copy;
}

/** Step four: the plugin releases again, and Team A carries its own work to the later commit (R37, KTD39). */
async function carrying(stage: Stage, own: readonly string[], everyVariable: string): Promise<Built> {
  const { a } = stage;
  stage.say("Step four. The plugin has a later commit. Team A carries its own findings and patches to it.");
  const carried = await command(stage, a, "carry", first, later, "--branch", PLUGIN.branch);
  const patches = listUnder(carried, "patches");
  must(
    patches.every((patch) => patch["carried"] === true) && sameIds(patches.map((patch) => String(patch["patchId"])), own),
    "Team A's two patches at the later commit, each with the patch ID it had",
  );
  const leftBehind = carried["leftBehind"];
  must(Array.isArray(leftBehind) && sameIds(leftBehind.map(String), [everyVariable]), "Team B's patch named as left behind");
  const copy = await approve(stage, a, later, "later");
  must(copy.patches.every((patch) => patch.node === a.node) && sameIds(copy.patches.map(({ patchId }) => patchId), own), "a later copy that holds Team A's own patches and no other");
  return copy;
}

/** The record files a team's node holds, by their path. */
async function recordsOf(stage: Stage, team: Team): Promise<string[]> {
  const held = (await listingOf(stage, team)) ?? halt(`${team.label}: the node did not list its records`);
  return held.records.map(({ path }) => path).sort();
}

/** Plays the four steps. Returns what the run made. */
export async function demo(stage: Stage): Promise<Shown> {
  const { a, b } = stage;
  const claimOf = await recordedClaims(stage);
  await mustBeAtTheStart(stage);
  const one = await alone(stage);
  const two = await together(stage, one.anyHost, claimOf);
  const three = await takingTeamB(stage, one.copy, two.everyVariable);
  const four = await carrying(stage, [one.anyHost, two.hiddenInstruction], two.everyVariable);

  // The script ends once the index has read and checked everything, so both pages are whole when it does.
  const last = await headOf(stage, a);
  await untilView(stage, later, "Team A's work at the later commit", (view) => view.state === "ready" && processed(view, [[a, last]]) && view.pending.length === 0);
  return {
    records: { "team-a": await recordsOf(stage, a), "team-b": await recordsOf(stage, b) },
    patches: { anyHost: one.anyHost, ...two },
    trees: { alone: one.copy.tree, withTeamB: three.tree, later: four.tree },
  };
}

if (import.meta.main) {
  await launch("demo", [REGISTRATION_KEY], async (stage) => {
    const shown = await demo(stage);
    console.log(`The demo is on the page: ${stage.index}/components/${first}`);
    console.log(`The later commit: ${stage.index}/components/${later}`);
    console.log(`The teams' folders and the installed copies: ${stage.work}`);
    console.log(JSON.stringify(shown));
  });
}
