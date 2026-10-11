// The demo script and the reset script, played on this machine (R27, R20): two fake nodes
// with local repos behind them, an index that applies the protocol's own rules, and the
// saved outboxes and recordings of `fixtures/`. No test reaches a network or calls a model.

import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_KEY_HEADER, TEAM_BRANCH } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
import { ADMIN_KEY, FIXTURES, INDEX, MODEL_API, NODE, OTHER_NODE, REGISTRATION_KEY, bench, demoPlugin, git, published } from "../../cli/test/support.ts";
import type { Bench, Site } from "../../cli/test/support.ts";
import { Stopped, openStage } from "../demo-stage.ts";
import type { Deployment, Stage } from "../demo-stage.ts";
import { EVERY_VARIABLE, demo } from "../demo.ts";
import { reset } from "../reset-demo.ts";
import { testIndex } from "./index.ts";
import type { TestIndex } from "./index.ts";

vi.setConfig({ testTimeout: 600_000 });

// Every key here is invented, and each node has its own.
const TEAM_B_KEY = "the-admin-key-of-team-b";
const RESET_KEY = "the-reset-key";
const OUT_OF_SCOPE_RECORD = "7badde119b758271ae71d03e5cee57e241ec4b2b28f0009018d792ec25ed9df9";

let on: Bench;
let teamB: Site;
let index: TestIndex;
let commits: { readonly first: string; readonly later: string };
/** What the scripts told the person who runs them. */
let said: string[];
/** Called with each line a script says, as it says it. */
let onSaid: (line: string) => void | Promise<void>;
const stages: Stage[] = [];

const DEPLOYMENT: Deployment = {
  index: INDEX,
  nodes: { "team-a": NODE, "team-b": OTHER_NODE },
  adminKeys: { "team-a": ADMIN_KEY, "team-b": TEAM_B_KEY },
  registrationKey: REGISTRATION_KEY,
};

beforeEach(() => {
  on = bench();
  teamB = on.another(OTHER_NODE, "cairnfield-team-b", TEAM_B_KEY);
  // Each node holds its own copy of the plugin, as its import of the public repo gives it.
  commits = demoPlugin(on);
  demoPlugin(teamB);
  git(on.repo(`copy-${commits.first}`), ["push", "--quiet", on.createRepo(`copy-${commits.later}`), TEAM_BRANCH]);
  index = testIndex(on, new Map<string, Site>([[NODE, on], [OTHER_NODE, teamB]]), { registration: REGISTRATION_KEY, reset: RESET_KEY });
  said = [];
  onSaid = () => undefined;
});

afterEach(() => {
  on.dispose();
  for (const opened of stages.splice(0)) rmSync(opened.work, { recursive: true, force: true });
});

/** Sets the stage for one run of a script on the bench. */
async function stage(recordings?: string): Promise<Stage> {
  const say = (line: string): void => {
    said.push(line);
    void onSaid(line);
  };
  const opened = await openStage(on.io, DEPLOYMENT, say, recordings);
  stages.push(opened);
  return opened;
}

/** What the command printed for the last run of one of its commands by a team. */
function printed(team: string, name: string): { readonly [field: string]: unknown } {
  const ran = said.map((line) => line === `${team}$ cairnfield ${name}` || line.startsWith(`${team}$ cairnfield ${name} `)).lastIndexOf(true);
  const output = said.slice(ran).find((line) => line.startsWith(`${team}> `)) ?? "";
  return JSON.parse(output.slice(team.length + 2)) as { readonly [field: string]: unknown };
}

/** One record of a node's repo, as its file holds it. */
const recordAt = (at: Site, path: string): { readonly [field: string]: unknown } => JSON.parse(git(at.repo("team"), ["show", `${TEAM_BRANCH}:${path}`])) as { readonly [field: string]: unknown };

/** The calls the index got from one of them on, each as its method and path, with the body of a POST. */
const indexCalls = (from: number): string[] =>
  index.requests.slice(from).map(({ method, url, body }) => `${method} ${new URL(url).pathname}${method === "POST" && body !== undefined ? ` ${JSON.stringify(body)}` : ""}`);

const patchRefs = (at: Site, component: string): string[] =>
  git(at.repo(`fork-${component}`), ["for-each-ref", "--format=%(refname)", "refs/heads/patch/"]).split("\n").filter((ref) => ref !== "");

describe("the demo script", () => {
  it("plays the four steps from the saved outboxes and recordings, and plays them the same again after a reset", async () => {
    // What the run had left behind when each later step began.
    const before: { two?: { readonly indexRequests: number; readonly decisions: string }; three?: View | undefined } = {};
    onSaid = async (line) => {
      if (line.startsWith("Step two.")) before.two = { indexRequests: index.requests.length, decisions: readFileSync(join(stages[0]?.a.home ?? "", ".cairnfield/decisions.json"), "utf8") };
      if (line.startsWith("Step three.")) before.three = await index.view(commits.first);
    };

    const shown = await demo(await stage());
    onSaid = () => undefined;

    const { anyHost, hiddenInstruction, everyVariable } = shown.patches;
    expect(new Set([anyHost, hiddenInstruction, everyVariable]).size).toBe(3);

    // After step one: Team A's table names the tree of its copy, and the command sent the index nothing.
    expect(before.two?.indexRequests).toBe(0);
    const [alone] = (JSON.parse(before.two?.decisions ?? "{}") as { readonly decisions: { readonly [field: string]: unknown }[] }).decisions;
    expect(alone).toMatchObject({ commit: commits.first, verdict: "approved-with-required-mitigations", tree: shown.trees.alone });

    // After step two: one patch from both teams as one entry, two patches side by side on adjoining lines, one rejected.
    const view = before.three;
    const entries = view?.patches.flatMap((group) => group.patches) ?? [];
    expect(entries.map(({ patchId, nodes, confirmed }) => ({ patchId, nodes, confirmed })).sort((a, b) => (a.patchId < b.patchId ? -1 : 1))).toEqual(
      [
        { patchId: anyHost, nodes: [NODE], confirmed: false },
        { patchId: hiddenInstruction, nodes: [NODE, OTHER_NODE], confirmed: true },
        { patchId: everyVariable, nodes: [OTHER_NODE], confirmed: false },
      ].sort((a, b) => (a.patchId < b.patchId ? -1 : 1)),
    );
    expect(view?.patches.map((group) => group.patches.map(({ patchId }) => patchId).sort()).sort((a, b) => b.length - a.length)).toEqual([[anyHost, everyVariable].sort(), [hiddenInstruction]]);
    expect(view?.rejected).toEqual([{ node: OTHER_NODE, hash: OUT_OF_SCOPE_RECORD, type: "patch", reason: "patch-out-of-scope" }]);
    expect(view?.pending).toEqual([]);
    // Each claim was published before its patch, and its patch closed it.
    expect(view?.claims.map(({ node, state }) => `${node} ${state}`).sort()).toEqual([`${NODE} closed`, `${NODE} closed`, `${OTHER_NODE} closed`, `${OTHER_NODE} closed`]);

    // After step three: another tree, and a recipe of Team A's that lists Team B's patch.
    expect(shown.trees.withTeamB).not.toBe(shown.trees.alone);
    const recipes = published(on).filter((path) => path.startsWith(`records/${commits.first}/recipe/`)).map((path) => recordAt(on, path));
    expect(recipes.find(({ tree }) => tree === shown.trees.withTeamB)?.["patches"]).toEqual([anyHost, hiddenInstruction, everyVariable].sort());
    expect(recipes.find(({ tree }) => tree === shown.trees.alone)?.["patches"]).toEqual([anyHost]);

    // After step four: Team A's patches at the later commit have the patch IDs they had, and `carry` names Team B's.
    expect(patchRefs(on, commits.later).sort()).toEqual([anyHost, hiddenInstruction].map((id) => `refs/heads/patch/${commits.later}/${id}`).sort());
    expect(printed("team-a", "carry")["leftBehind"]).toEqual([everyVariable]);
    expect(recordAt(on, published(on).find((path) => path.startsWith(`records/${commits.later}/recipe/`)) ?? "")).toMatchObject({ tree: shown.trees.later, patches: [anyHost, hiddenInstruction].sort() });
    expect(new Set(Object.values(shown.trees)).size).toBe(3);

    // No model was called, and each node was asked for a token with its own key and no other.
    expect(on.requests.filter(({ url }) => url.startsWith(MODEL_API))).toEqual([]);
    const keysSent = (node: string): string[] => [...new Set(on.requests.filter(({ url }) => url.startsWith(`${node}/admin/`)).map(({ headers }) => headers.get(ADMIN_KEY_HEADER) ?? ""))];
    expect(keysSent(NODE)).toEqual([ADMIN_KEY]);
    expect(keysSent(OTHER_NODE)).toEqual([TEAM_B_KEY]);
    // What the script said holds no key.
    for (const key of [ADMIN_KEY, TEAM_B_KEY, REGISTRATION_KEY, RESET_KEY]) expect(said.join("\n")).not.toContain(key);

    // The reset: no record on either branch, none in the index, and every repo still there with its history.
    const from = index.requests.length;
    const heads = await reset(await stage(), RESET_KEY);

    // The index dropped its records only after it had read both emptied nodes.
    const read = `GET /components/${commits.first}/view`;
    expect(indexCalls(from)).toEqual([read, `POST /notices {"node":"${NODE}"}`, `POST /notices {"node":"${OTHER_NODE}"}`, read, "POST /reset", read]);
    expect(published(on)).toEqual([]);
    expect(published(teamB)).toEqual([]);
    expect(heads).toEqual({ "team-a": git(on.repo("team"), ["rev-parse", TEAM_BRANCH]), "team-b": git(teamB.repo("team"), ["rev-parse", TEAM_BRANCH]) });
    expect(index.held()).toBe(0);
    expect((await index.view(commits.first))?.nodes).toEqual([
      { node: NODE, processed: heads["team-a"], simulated: false, historyRewritten: false },
      { node: OTHER_NODE, processed: heads["team-b"], simulated: false, historyRewritten: false },
    ]);
    expect(git(on.repo("team"), ["ls-tree", "-r", "--name-only", `${TEAM_BRANCH}~1`]).split("\n")).toEqual(shown.records["team-a"]);
    expect(patchRefs(teamB, commits.first)).toHaveLength(3);

    // From the reset state the demo gives the same record IDs, patch IDs and file-tree hashes.
    const again = await demo(await stage());

    expect(again).toEqual(shown);
    expect(on.requests.filter(({ url }) => url.startsWith(MODEL_API))).toEqual([]);
  });

  it("stops before it makes any call when a recording is missing", async () => {
    const recordings = mkdtempSync(join(tmpdir(), "cairnfield-recordings-"));
    try {
      cpSync(`${FIXTURES}recordings`, recordings, { recursive: true });
      rmSync(join(recordings, "team-b", commits.first, `${EVERY_VARIABLE}.json`));

      const stopped = await demo(await stage(recordings)).catch((error: unknown) => error);

      expect(stopped).toBeInstanceOf(Stopped);
      expect((stopped as Stopped).message).toContain(`no recording for team-b and finding ${EVERY_VARIABLE}`);
      expect(on.requests).toEqual([]);
      expect(on.gitCalls).toEqual([]);
    } finally {
      rmSync(recordings, { recursive: true, force: true });
    }
  });
});

describe("the reset script", () => {
  it("empties the index of a deployment that has published nothing, and touches no node", async () => {
    const heads = await reset(await stage(), RESET_KEY);

    expect(heads).toEqual({});
    expect(indexCalls(0)).toEqual([`GET /components/${commits.first}/view`, "POST /reset"]);
    expect(on.requests.filter(({ url }) => url.includes("/admin/"))).toEqual([]);
  });

  it("stops when the index refuses the reset key, with both nodes emptied and the index's records kept", async () => {
    await demo(await stage());
    const held = index.held();

    const stopped = await reset(await stage(), "another-key").catch((error: unknown) => error);

    expect(stopped).toBeInstanceOf(Stopped);
    expect((stopped as Stopped).message).toBe("the index did not take the reset: unauthorized");
    expect(index.held()).toBe(held);
    expect(published(on)).toEqual([]);
  });
});
