// The demo script and the reset script, played on this machine (R27, R20): two fake nodes
// with local repos behind them, an index that applies the protocol's own rules, and the
// saved outboxes and recordings of `fixtures/`. No test reaches a network or calls a model.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_KEY_HEADER, TEAM_BRANCH } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
import { Stop, failure } from "../../cli/src/outcome.ts";
import { ADMIN_KEY, FIXTURES, INDEX, MODEL_API, MODEL_KEY, NODE, REGISTRATION_KEY, TOKEN, bench, demoPlugin, git, published } from "../../cli/test/support.ts";
import type { Bench, Site } from "../../cli/test/support.ts";
import { Stopped, deploymentFrom, launch, openStage } from "../demo-stage.ts";
import type { Deployment, Stage } from "../demo-stage.ts";
import { EVERY_VARIABLE, demo } from "../demo.ts";
import { reset } from "../reset-demo.ts";
import { testIndex } from "./index.ts";
import type { TestIndex } from "./index.ts";

vi.setConfig({ testTimeout: 600_000 });

// Team B's node is not at the address the lens fixtures name for it, so a lens must be rewritten to count its work.
const TEAM_B = "https://team-b.nodes.example";
// Every key here is invented, and each node has its own.
const TEAM_B_KEY = "the-admin-key-of-team-b";
const RESET_KEY = "the-reset-key";
const OUT_OF_SCOPE_RECORD = "7badde119b758271ae71d03e5cee57e241ec4b2b28f0009018d792ec25ed9df9";
const HIDDEN_INSTRUCTION = "981ae3aa8aadd84d9f44c609c4302727d91b4d381b92c124d7216879aa665b08";
/** The names a script or the command reads a key under. */
const KEY_NAMES = ["CAIRNFIELD_ADMIN_KEY", "CAIRNFIELD_REGISTRATION_KEY", "ANTHROPIC_API_KEY", "TEAM_A_ADMIN_KEY", "TEAM_B_ADMIN_KEY", "CAIRNFIELD_RESET_KEY"];

let on: Bench;
let teamB: Site;
let index: TestIndex;
let commits: { readonly first: string; readonly later: string };
/** What the scripts told the person who runs them. */
let said: string[];
/** Called with each line a script says, as it says it. */
let onSaid: (line: string) => void;
const stages: Stage[] = [];

const DEPLOYMENT: Deployment = {
  index: INDEX,
  nodes: { "team-a": NODE, "team-b": TEAM_B },
  adminKeys: { "team-a": ADMIN_KEY, "team-b": TEAM_B_KEY },
  registrationKey: REGISTRATION_KEY,
};

beforeEach(() => {
  on = bench();
  teamB = on.another(TEAM_B, "cairnfield-team-b", TEAM_B_KEY);
  // Each node holds its own copy of the plugin, as its import of the public repo gives it.
  commits = demoPlugin(on);
  demoPlugin(teamB);
  git(on.repo(`copy-${commits.first}`), ["push", "--quiet", on.createRepo(`copy-${commits.later}`), TEAM_BRANCH]);
  // The index reads a node two reads of a view after it is told, so a step that does not wait for it fails.
  index = testIndex(on, new Map<string, Site>([[NODE, on], [TEAM_B, teamB]]), { registration: REGISTRATION_KEY, reset: RESET_KEY }, 2);
  // The shell a script runs in holds every key of the demo.
  Object.assign(on.env, { TEAM_A_ADMIN_KEY: ADMIN_KEY, TEAM_B_ADMIN_KEY: TEAM_B_KEY, CAIRNFIELD_RESET_KEY: RESET_KEY });
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
    onSaid(line);
  };
  const opened = await openStage(on.io, DEPLOYMENT, say, recordings);
  stages.push(opened);
  return opened;
}

/** A copy of the saved recordings that a test may change. */
function recordingsCopy(): string {
  const recordings = mkdtempSync(join(tmpdir(), "cairnfield-recordings-"));
  cpSync(`${FIXTURES}recordings`, recordings, { recursive: true });
  return recordings;
}

/** What a script stopped with. */
const stoppedWith = async (run: Promise<unknown>): Promise<string> => {
  const stopped = await run.catch((error: unknown) => error);
  expect(stopped).toBeInstanceOf(Stopped);
  return (stopped as Stopped).message;
};

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

const headOf = (at: Site): string => git(at.repo("team"), ["rev-parse", TEAM_BRANCH]);

/** Everything a script told the operator, on either stream, holds no key, no token and no Git remote. */
function expectNothingSecretSaid(): void {
  const told = [...said, ...on.warnings].join("\n");
  for (const secret of [ADMIN_KEY, TEAM_B_KEY, REGISTRATION_KEY, RESET_KEY, MODEL_KEY, TOKEN]) expect(told).not.toContain(secret);
  expect(told).not.toMatch(/art_v[0-9]+_|artifacts\.cloudflare\.net/);
}

describe("the demo script", () => {
  it("plays the four steps from the saved outboxes and recordings, and plays them the same again after a reset", async () => {
    // What the run had left behind when each step began.
    const before: { one?: number; two?: { readonly indexRequests: number; readonly decisions: string }; three?: Promise<View | undefined> } = {};
    onSaid = (line) => {
      if (line.startsWith("Step one.")) before.one = index.requests.length;
      if (line.startsWith("Step two.")) before.two = { indexRequests: index.requests.length, decisions: readFileSync(join(stages[0]?.a.home ?? "", ".cairnfield/decisions.json"), "utf8") };
      if (line.startsWith("Step three.")) before.three = index.view(commits.first);
    };

    const shown = await demo(await stage());
    onSaid = () => undefined;

    const { anyHost, hiddenInstruction, everyVariable } = shown.patches;
    expect(new Set([anyHost, hiddenInstruction, everyVariable]).size).toBe(3);

    // After step one: Team A's table names the tree of its copy, and nothing was sent to the index while the team worked alone.
    expect(before.two?.indexRequests).toBe(before.one);
    const [alone] = (JSON.parse(before.two?.decisions ?? "{}") as { readonly decisions: { readonly [field: string]: unknown }[] }).decisions;
    expect(alone).toMatchObject({ commit: commits.first, verdict: "approved-with-required-mitigations", tree: shown.trees.alone });

    // After step two: one patch from both teams as one entry, two patches side by side on adjoining lines, one rejected.
    const view = await before.three;
    const entries = view?.patches.flatMap((group) => group.patches) ?? [];
    expect(entries.map(({ patchId, nodes, confirmed }) => ({ patchId, nodes, confirmed })).sort((a, b) => (a.patchId < b.patchId ? -1 : 1))).toEqual(
      [
        { patchId: anyHost, nodes: [NODE], confirmed: false },
        { patchId: hiddenInstruction, nodes: [NODE, TEAM_B], confirmed: true },
        { patchId: everyVariable, nodes: [TEAM_B], confirmed: false },
      ].sort((a, b) => (a.patchId < b.patchId ? -1 : 1)),
    );
    expect(view?.patches.map((group) => group.patches.map(({ patchId }) => patchId).sort()).sort((a, b) => b.length - a.length)).toEqual([[anyHost, everyVariable].sort(), [hiddenInstruction]]);
    expect(view?.rejected).toEqual([{ node: TEAM_B, hash: OUT_OF_SCOPE_RECORD, type: "patch", reason: "patch-out-of-scope" }]);
    expect(view?.pending).toEqual([]);
    // Each claim was published before its patch, and its patch closed it.
    expect(view?.claims.map(({ node, state }) => `${node} ${state}`).sort()).toEqual([`${NODE} closed`, `${NODE} closed`, `${TEAM_B} closed`, `${TEAM_B} closed`]);
    // The script held the three claims on the page before the patches closed them.
    expect(on.sleeps).toContain(10_000);

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
    expect(keysSent(TEAM_B)).toEqual([TEAM_B_KEY]);
    expectNothingSecretSaid();

    // From here the demo does not start again: the nodes hold its records, and a run would pass on them.
    const calls = on.requests.length;
    expect(await stoppedWith(demo(await stage()))).toBe("team-a: the node holds records already. Run npm run demo:reset first");
    expect(on.requests.slice(calls).map(({ method }) => method)).toEqual(["GET"]);

    // The reset: no record on either branch, none in the index, and every repo still there with its history.
    const from = index.requests.length;
    const heads = await reset(await stage(), RESET_KEY);

    // The index dropped its records only after it had read both emptied nodes.
    const dropped = indexCalls(from).indexOf("POST /reset");
    expect(indexCalls(from).slice(0, 3)).toEqual([`GET /components/${commits.first}/view`, `POST /notices {"node":"${NODE}"}`, `POST /notices {"node":"${TEAM_B}"}`]);
    expect(dropped).toBeGreaterThan(3);
    expect(new Set(indexCalls(from).slice(3, dropped))).toEqual(new Set([`GET /components/${commits.first}/view`]));
    expect(published(on)).toEqual([]);
    expect(published(teamB)).toEqual([]);
    expect(heads).toEqual({ "team-a": headOf(on), "team-b": headOf(teamB) });
    expect(index.held()).toBe(0);
    expect((await index.view(commits.first))?.nodes).toEqual([
      { node: NODE, processed: heads["team-a"], simulated: false, historyRewritten: false },
      { node: TEAM_B, processed: heads["team-b"], simulated: false, historyRewritten: false },
    ]);
    expect(git(on.repo("team"), ["ls-tree", "-r", "--name-only", `${TEAM_BRANCH}~1`]).split("\n")).toEqual(shown.records["team-a"]);
    expect(patchRefs(teamB, commits.first)).toHaveLength(3);
    expectNothingSecretSaid();

    // From the reset state the demo gives the same record IDs, patch IDs and file-tree hashes.
    const again = await demo(await stage());

    expect(again).toEqual(shown);
    expect(on.requests.filter(({ url }) => url.startsWith(MODEL_API))).toEqual([]);
  });

  it("stops before it makes any call when a recording is missing", async () => {
    const recordings = recordingsCopy();
    try {
      rmSync(join(recordings, "team-b", commits.first, `${EVERY_VARIABLE}.json`));

      expect(await stoppedWith(demo(await stage(recordings)))).toContain(`no recording for team-b and finding ${EVERY_VARIABLE}`);

      expect(on.requests).toEqual([]);
      expect(on.gitCalls).toEqual([]);
    } finally {
      rmSync(recordings, { recursive: true, force: true });
    }
  });

  it("stops when the two teams' recordings do not remove the hidden instruction the same way", async () => {
    const recordings = recordingsCopy();
    try {
      // Team B's recording now writes another line where Team A's takes the line out.
      const file = join(recordings, "team-b", commits.first, `${HIDDEN_INSTRUCTION}.json`);
      const recording = JSON.parse(readFileSync(file, "utf8")) as { edits: { lines: string[] }[] };
      for (const edit of recording.edits) edit.lines = ["<!-- taken out -->"];
      writeFileSync(file, JSON.stringify(recording));

      expect(await stoppedWith(demo(await stage(recordings)))).toBe("the demo needs both teams' recordings to remove the hidden instruction the same way, and this run did not give it");

      // The script stopped there: Team B published nothing by hand, and Team A's lens still names no team.
      expect(said.some((line) => line.startsWith("Step three."))).toBe(false);
      expect(published(teamB).filter((path) => path.includes("/patch/"))).toHaveLength(2);
    } finally {
      rmSync(recordings, { recursive: true, force: true });
    }
  });

  it("stops at the first command that fails, and runs none after it", async () => {
    // Team B's node refuses its key from step two on.
    const answered = on.respond;
    on.respond = (seen) => (seen.url.startsWith(`${TEAM_B}/admin/`) ? Response.json({ error: "unauthorized" }, { status: 401 }) : answered?.(seen));

    expect(await stoppedWith(demo(await stage()))).toBe("team-b: cairnfield pin ended with exit code 4");

    expect(said.at(-1)).toBe('team-b> {"error":"node-refused","reason":"unauthorized"}');
    expect(said.filter((line) => line.startsWith("team-b$ "))).toHaveLength(1);
  });

  it("hands each team's command that team's admin key and the registration key, and no other key of the shell", async () => {
    const opened = await stage();

    const keysIn = (env: { readonly [name: string]: string | undefined }): { [name: string]: string | undefined } => Object.fromEntries(KEY_NAMES.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
    // The bench's shell holds all six, with Team A's key under the command's own name too.
    expect(Object.keys(keysIn(on.env)).sort()).toEqual([...KEY_NAMES].sort());
    expect(keysIn(opened.io.env)).toEqual({});
    expect(keysIn(opened.a.io.env)).toEqual({ CAIRNFIELD_ADMIN_KEY: ADMIN_KEY, CAIRNFIELD_REGISTRATION_KEY: REGISTRATION_KEY });
    expect(keysIn(opened.b.io.env)).toEqual({ CAIRNFIELD_ADMIN_KEY: TEAM_B_KEY, CAIRNFIELD_REGISTRATION_KEY: REGISTRATION_KEY });
    expect(opened.a.io.env["PATH"]).toBe(on.env["PATH"]);
  });
});

describe("the reset script", () => {
  it("empties the index of a deployment that has published nothing, and touches no node", async () => {
    const heads = await reset(await stage(), RESET_KEY);

    expect(heads).toEqual({});
    expect(indexCalls(0)).toEqual([`GET /components/${commits.first}/view`, "POST /reset"]);
    expect(on.requests.filter(({ url }) => url.includes("/admin/"))).toEqual([]);
  });

  it("stops while the index has not read the emptied nodes, stops at a refused reset key, and finishes when it is run again", async () => {
    await demo(await stage());
    const held = index.held();

    // The index takes the notices and never reads the nodes.
    index.lag = Infinity;
    const from = index.requests.length;
    expect(await stoppedWith(reset(await stage(), RESET_KEY))).toBe("the index did not show the emptied nodes within five minutes");
    expect(indexCalls(from)).not.toContain("POST /reset");
    expect(published(on)).toEqual([]);
    expect(index.held()).toBe(held);

    // Run again with another key: the branches are empty already and stay as they are, and the index keeps its records.
    index.lag = 2;
    const emptied = [headOf(on), headOf(teamB)];
    expect(await stoppedWith(reset(await stage(), "another-key"))).toBe("the index did not take the reset: unauthorized");
    expect(index.held()).toBe(held);

    // Run again with the reset key: the demo is at its start.
    const heads = await reset(await stage(), RESET_KEY);

    expect(heads).toEqual({ "team-a": emptied[0], "team-b": emptied[1] });
    expect([headOf(on), headOf(teamB)]).toEqual(emptied);
    expect(index.held()).toBe(0);
  });
});

describe("a script's start from the command line", () => {
  const SHELL = {
    TEAM_A_NODE_URL: NODE,
    TEAM_B_NODE_URL: TEAM_B,
    INDEX_URL: INDEX,
    TEAM_A_ADMIN_KEY: ADMIN_KEY,
    TEAM_B_ADMIN_KEY: TEAM_B_KEY,
    CAIRNFIELD_REGISTRATION_KEY: REGISTRATION_KEY,
    CAIRNFIELD_RESET_KEY: RESET_KEY,
  };

  it("reads each team's node and key from that team's own names, with the one key of the index the script asks for", () => {
    expect(deploymentFrom(SHELL, "CAIRNFIELD_REGISTRATION_KEY")).toEqual({ deployment: DEPLOYMENT, key: REGISTRATION_KEY });
    const { registrationKey: _none, ...withoutRegistration } = DEPLOYMENT;
    expect(deploymentFrom(SHELL, "CAIRNFIELD_RESET_KEY")).toEqual({ deployment: withoutRegistration, key: RESET_KEY });
  });

  it("names what is missing or in a form no node or index has, and gives back no value", () => {
    const shell = { ...SHELL, TEAM_A_NODE_URL: "http://node.team-a.example", INDEX_URL: `${INDEX}/`, TEAM_B_ADMIN_KEY: "a key\nwith a line break", CAIRNFIELD_REGISTRATION_KEY: undefined };

    const found = deploymentFrom(shell, "CAIRNFIELD_REGISTRATION_KEY");

    expect(found).toEqual({ missing: ["TEAM_A_NODE_URL", "INDEX_URL", "TEAM_B_ADMIN_KEY", "CAIRNFIELD_REGISTRATION_KEY"] });
  });

  describe("launch", () => {
    let errors: string[];
    beforeEach(() => {
      errors = [];
      vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });
      for (const [name, value] of Object.entries(SHELL)) vi.stubEnv(name, value);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      process.exitCode = undefined;
    });

    it("ends with 2 and the missing names when it cannot start, before it plays anything", async () => {
      vi.stubEnv("TEAM_B_ADMIN_KEY", "");
      vi.stubEnv("CAIRNFIELD_RESET_KEY", "");
      let played = false;

      await expect(launch("reset", "CAIRNFIELD_RESET_KEY", async () => void (played = true))).rejects.toThrow("exit 2");

      expect(errors).toEqual(["The reset cannot start. Set these in the environment: TEAM_B_ADMIN_KEY, CAIRNFIELD_RESET_KEY"]);
      expect(played).toBe(false);
    });

    it("plays with the key it asked for, and ends with 1 and the reason when the script stops", async () => {
      const keys: string[] = [];
      const play = (stop: unknown) => async (opened: Stage, key: string) => {
        stages.push(opened);
        keys.push(key);
        throw stop;
      };

      await launch("demo", "CAIRNFIELD_REGISTRATION_KEY", play(new Stopped("the index did not show Team A's records within five minutes")));
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      await launch("reset", "CAIRNFIELD_RESET_KEY", play(new Stop(failure(4, "node-refused", { reason: "unauthorized" }))));

      expect(process.exitCode).toBe(1);
      expect(keys).toEqual([REGISTRATION_KEY, RESET_KEY]);
      expect(errors).toEqual(["The demo stopped: the index did not show Team A's records within five minutes", 'The reset stopped: {"error":"node-refused","reason":"unauthorized"}']);
    });
  });
});
