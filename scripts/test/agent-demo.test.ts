// The operator's script of the agent demo, played on this machine: two fake nodes with
// local repos behind them, an index that applies the protocol's own rules, and a pause in
// which the test plays the review agent. No test reaches a network, calls a model or
// starts an agent.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
import { ADMIN_KEY, FIXTURES, INDEX, MODEL_KEY, NODE, REGISTRATION_KEY, TOKEN, bench, demoPlugin, published } from "../../cli/test/support.ts";
import type { Bench, Seen, Site } from "../../cli/test/support.ts";
import { agentDemo, enterAt } from "../agent-demo.ts";
import { PLUGIN, Stopped, launch, openStage } from "../demo-stage.ts";
import type { Deployment, Stage } from "../demo-stage.ts";
import { demo } from "../demo.ts";
import { testIndex } from "./index.ts";
import type { TestIndex } from "./index.ts";

vi.setConfig({ testTimeout: 600_000 });

const TEAM_B = "https://team-b.nodes.example";
// Every key here is invented, and each node has its own.
const TEAM_B_KEY = "the-admin-key-of-team-b";
const RESET_KEY = "the-reset-key";
/** The names a script or the command reads a key under. */
const KEY_NAMES = ["CAIRNFIELD_ADMIN_KEY", "CAIRNFIELD_REGISTRATION_KEY", "ANTHROPIC_API_KEY", "TEAM_A_ADMIN_KEY", "TEAM_B_ADMIN_KEY", "CAIRNFIELD_RESET_KEY"];
const REPO = fileURLToPath(new URL("../../", import.meta.url));
/** The name a record waits under until `validate` has said its ID. */
const PLACEHOLDER = `${"0".repeat(64)}.json`;

let on: Bench;
let teamB: Site;
let index: TestIndex;
let commits: { readonly first: string; readonly later: string };
/** What the script told the person who runs it. */
let said: string[];
/** Team A's saved findings, which the test writes as the agent: each file's path in an outbox, and each record's ID. */
let saved: { readonly paths: readonly string[]; readonly ids: readonly string[] };
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
  commits = demoPlugin(on);
  demoPlugin(teamB);
  // The index reads a node two reads of a view after it is told, so a script that does not wait for it fails.
  index = testIndex(on, new Map<string, Site>([[NODE, on], [TEAM_B, teamB]]), { registration: REGISTRATION_KEY, reset: RESET_KEY }, 2);
  // The shell the script runs in holds every key of the demo.
  Object.assign(on.env, { TEAM_A_ADMIN_KEY: ADMIN_KEY, TEAM_B_ADMIN_KEY: TEAM_B_KEY, CAIRNFIELD_RESET_KEY: RESET_KEY });
  said = [];
  const names = readdirSync(`${FIXTURES}outboxes/team-a/records/${commits.first}/finding`).sort();
  saved = { paths: names.map((name) => `records/${commits.first}/finding/${name}`), ids: names.map((name) => name.replace(/\.json$/, "")) };
});

afterEach(() => {
  on.dispose();
  for (const opened of stages.splice(0)) rmSync(opened.work, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** Sets the stage for one run of the script on the bench. */
async function stage(): Promise<Stage> {
  const opened = await openStage(on.io, DEPLOYMENT, (line) => void said.push(line));
  stages.push(opened);
  return opened;
}

const outboxOf = (opened: Stage): string => join(opened.a.home, ".cairnfield/outbox");

/** The agent's part, played by the test: Team A's saved findings, each written where it belongs in the outbox. */
const writesSaved = (opened: Stage): void => cpSync(`${FIXTURES}outboxes/team-a/records`, join(outboxOf(opened), "records"), { recursive: true });

/** What the script stopped with. */
const stoppedWith = async (run: Promise<unknown>): Promise<string> => {
  const stopped = await run.catch((error: unknown) => error);
  expect(stopped).toBeInstanceOf(Stopped);
  return (stopped as Stopped).message;
};

/** What the command printed for the last run of one of its commands by Team A. */
function printed(name: string): { readonly [field: string]: unknown } {
  const ran = said.lastIndexOf(`team-a$ cairnfield ${name}`);
  const output = said.slice(ran).find((line) => line.startsWith("team-a> ")) ?? "";
  return JSON.parse(output.slice("team-a> ".length)) as { readonly [field: string]: unknown };
}

const ran = (name: string): number => said.filter((line) => line === `team-a$ cairnfield ${name}` || line.startsWith(`team-a$ cairnfield ${name} `)).length;

/** The requests the fake nodes got on their admin routes, from one request on. */
const adminCalls = (from: number): string[] => on.requests.slice(from).flatMap(({ url }) => (url.includes("/admin/") ? [url] : []));

/** The IDs of the findings the index lists for the plugin's first commit. */
async function listed(): Promise<string[]> {
  const view = await index.view(commits.first);
  return (view?.findings.flatMap((group) => group.findings.map(({ id }) => id)) ?? []).sort();
}

/** Everything the script told the operator, on either stream, holds no key, no token and no Git remote. */
function expectNothingSecretSaid(): void {
  const told = [...said, ...on.warnings].join("\n");
  for (const secret of [ADMIN_KEY, TEAM_B_KEY, REGISTRATION_KEY, RESET_KEY, MODEL_KEY, TOKEN]) expect(told).not.toContain(secret);
  expect(told).not.toMatch(/art_v[0-9]+_|artifacts\.cloudflare\.net/);
}

type Respond = NonNullable<Bench["respond"]>;

/** Has a test answer a request in its own way. `answered` gives what the bench's node or index answers. */
function instead(respond: (seen: Seen, answered: () => ReturnType<Respond>) => ReturnType<Respond>): void {
  const answered = on.respond;
  on.respond = (seen) => respond(seen, () => answered?.(seen));
}

const isNotice = (seen: Seen): boolean => seen.method === "POST" && seen.url === `${INDEX}/notices`;

describe("the agent demo's operator script", () => {
  it("resets, pins with the index, waits for the person, publishes what the agent wrote and ends once the index lists it", async () => {
    const opened = await stage();
    let pauses = 0;
    /** How many lines had been said, and how many notices the index had got, when the script paused. */
    let atPause = { said: 0, notices: 0 };

    await agentDemo(opened, RESET_KEY, async () => {
      pauses += 1;
      atPause = { said: said.length, notices: index.requests.filter(isNotice).length };
      writesSaved(opened);
    });

    expect(pauses).toBe(1);
    expect(saved.paths.length).toBeGreaterThan(0);
    // Before the pause: the reset, then one pin, with the index named in the config.
    const before = said.slice(0, atPause.said);
    expect(before[0]).toBe(`Resetting the demo: the nodes ${NODE} and ${TEAM_B}, and the index ${INDEX}`);
    expect(before.filter((line) => line.startsWith("team-a$ "))).toEqual([`team-a$ cairnfield pin ${PLUGIN.url} --branch ${PLUGIN.branch} --commit ${commits.first}`]);
    expect(JSON.parse(readFileSync(join(opened.a.home, "cairnfield.json"), "utf8"))).toMatchObject({ node: NODE, index: INDEX });
    expect(atPause.notices).toBe(0);
    // After it: the node's branch holds each record the agent wrote, and the index lists each as a finding.
    expect(said.slice(atPause.said).filter((line) => line.startsWith("team-a$ "))).toEqual(["team-a$ cairnfield validate", "team-a$ cairnfield publish"]);
    expect(published(on)).toEqual(saved.paths);
    expect(printed("publish")).toMatchObject({ records: saved.paths.length, published: saved.paths, notice: "sent" });
    expect(await listed()).toEqual(saved.ids);
    // The script ended only once the index had read the node: it waited on the view.
    expect(on.sleeps.length).toBeGreaterThan(0);
    // It ends by naming the two commands that put the public page back, each on a line of its own.
    expect(said.slice(-2)).toEqual(["npm run demo:reset", "npm run demo"]);
    // The operator's folder is kept, with the outbox as the agent left it.
    expect(readdirSync(join(outboxOf(opened), "records", commits.first, "finding")).sort()).toEqual(saved.ids.map((id) => `${id}.json`));
    expectNothingSecretSaid();

    // From here the four-step demo does not start: the node holds this run's records.
    expect(await stoppedWith(demo(await stage()))).toBe("team-a: the node holds records already. Run npm run demo:reset first");
  });

  it("places the skill file where Claude Code reads it, and prints the keyless launch command and the prompt before it pauses", async () => {
    const home = mkdtempSync(join(tmpdir(), "cairnfield-home-"));
    try {
      vi.stubEnv("HOME", home);
      const opened = await stage();
      let before: string[] = [];
      let placed: Buffer | undefined;
      const skill = join(opened.a.home, ".claude/skills/cairnfield/SKILL.md");

      await agentDemo(opened, RESET_KEY, async () => {
        before = [...said];
        placed = readFileSync(skill);
        writesSaved(opened);
      });

      // The skill is the repo's file, byte for byte, in the operator's folder and nowhere under the user's home.
      const repoSkill = readFileSync(join(REPO, "skills/cairnfield/SKILL.md"));
      expect(placed?.equals(repoSkill)).toBe(true);
      expect(readFileSync(skill).equals(repoSkill)).toBe(true);
      expect(readdirSync(home)).toEqual([]);

      // One line starts Claude Code in the operator's folder with every key name unset.
      const starts = before.filter((line) => line.endsWith(" claude"));
      expect(starts).toHaveLength(1);
      const [start = ""] = starts;
      expect(start.startsWith(`cd ${opened.a.home} && env `)).toBe(true);
      for (const name of KEY_NAMES) expect(start).toContain(` -u ${name} `);
      expect(start.match(/ -u /g)).toHaveLength(KEY_NAMES.length);
      // The pane needs the Node the repo names.
      expect(before.some((line) => line.includes(`Node ${readFileSync(join(REPO, ".nvmrc"), "utf8").trim()}`))).toBe(true);
      // The prompt names the pinned commit and the launcher by its path on this machine.
      expect(before).toContain(
        `Use the cairnfield skill to review the checkout of ${commits.first}. Start \`cairnfield\` as \`node ${join(REPO, "cli/bin/cairnfield.mjs")} <command>\`. Stop when validate accepts your files.`,
      );
      expect(before).toContain(`The operator's folder: ${opened.a.home}`);
      // The person pastes from these lines into a shell that runs a comment line as a command.
      expect(said.filter((line) => line.trimStart().startsWith("#"))).toEqual([]);
      expectNothingSecretSaid();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("publishes nothing while the person has not said go", async () => {
    const opened = await stage();
    let paused = (): void => undefined;
    let go = (): void => undefined;
    const atPause = new Promise<void>((resolve) => (paused = resolve));

    const run = agentDemo(opened, RESET_KEY, () => {
      writesSaved(opened);
      paused();
      return new Promise<void>((resolve) => (go = resolve));
    });
    await atPause;
    const calls = on.requests.length;
    // Whatever the script would do without waiting for the person has time to happen.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(on.requests.slice(calls)).toEqual([]);
    expect(ran("validate") + ran("publish")).toBe(0);

    go();
    await run;
    expect(published(on)).toEqual(saved.paths);
  });

  it("refuses to publish when the config file is not the one it pinned with", async () => {
    const opened = await stage();
    let calls = 0;

    const stopped = await stoppedWith(
      agentDemo(opened, RESET_KEY, async () => {
        calls = on.requests.length;
        writesSaved(opened);
        // The agent has rewritten the config to name another team's node.
        writeFileSync(join(opened.a.home, "cairnfield.json"), `${JSON.stringify({ node: TEAM_B, index: INDEX, team: "team-a" }, null, 2)}\n`);
      }),
    );

    expect(stopped).toContain("cairnfield.json");
    expect(adminCalls(calls)).toEqual([]);
    expect(ran("validate") + ran("publish")).toBe(0);
    expect(existsSync(on.repo("team"))).toBe(false);
    expect(existsSync(teamB.repo("team"))).toBe(false);
  });

  it("refuses to publish when the config file is gone", async () => {
    const opened = await stage();

    const stopped = await stoppedWith(
      agentDemo(opened, RESET_KEY, async () => {
        writesSaved(opened);
        rmSync(join(opened.a.home, "cairnfield.json"));
      }),
    );

    expect(stopped).toContain("cairnfield.json");
    expect(ran("validate") + ran("publish")).toBe(0);
  });

  it("says the outbox holds no record and pauses again, and publishes nothing until it holds one", async () => {
    const opened = await stage();
    let pauses = 0;
    let calls = 0;

    await agentDemo(opened, RESET_KEY, async () => {
      pauses += 1;
      if (pauses === 1) {
        calls = on.requests.length;
        return;
      }
      // The second pause: the script has said why it did not publish, and it made no call to a node.
      expect(said).toContain("The outbox holds no record, so nothing was published.");
      expect(adminCalls(calls)).toEqual([]);
      expect(ran("publish")).toBe(0);
      writesSaved(opened);
    });

    expect(pauses).toBe(2);
    expect(ran("publish")).toBe(1);
    expect(published(on)).toEqual(saved.paths);
  });

  it("prints the refusal validate gives for a file under the placeholder name, pauses again, and publishes once the file is moved", async () => {
    const opened = await stage();
    const folder = join(outboxOf(opened), "records", commits.first, "finding");
    const [record = ""] = saved.paths;
    let pauses = 0;
    let calls = 0;

    await agentDemo(opened, RESET_KEY, async () => {
      pauses += 1;
      if (pauses === 1) {
        calls = on.requests.length;
        mkdirSync(folder, { recursive: true });
        cpSync(`${FIXTURES}outboxes/team-a/${record}`, join(folder, PLACEHOLDER));
        return;
      }
      // The second pause: the script printed the verdict `validate` gave, and published nothing.
      expect(printed("validate")).toEqual({
        records: 0,
        rejected: [{ record: `${dirname(record)}/${PLACEHOLDER}`, reason: "hash-mismatch", expected: record }],
      });
      expect(said).toContain("validate refused a file in the outbox, so nothing was published.");
      expect(adminCalls(calls)).toEqual([]);
      expect(ran("publish")).toBe(0);
      renameSync(join(folder, PLACEHOLDER), join(outboxOf(opened), record));
    });

    expect(pauses).toBe(2);
    expect(published(on)).toEqual([record]);
    expect(await listed()).toEqual([saved.ids[0]]);
  });

  it("sends the notice itself when publish pushed the records and could not tell the index", async () => {
    const opened = await stage();
    let failed = 0;
    // The index does not take the first notice.
    instead((seen, answered) => (isNotice(seen) && failed++ === 0 ? new Response("", { status: 500 }) : answered()));

    await agentDemo(opened, RESET_KEY, async () => writesSaved(opened));

    expect(printed("publish")).toMatchObject({ published: saved.paths, notice: "failed" });
    expect(failed).toBe(2);
    expect(index.requests.filter(isNotice).map(({ body }) => body)).toEqual([{ node: NODE }]);
    expect(await listed()).toEqual(saved.ids);
    expect(said.slice(-2)).toEqual(["npm run demo:reset", "npm run demo"]);
  });

  it("stops at once when the index does not know the node the notice names", async () => {
    const opened = await stage();
    instead((seen, answered) => (isNotice(seen) ? Response.json({ version: SCHEMA_VERSION, error: "not-found" }, { status: 404 }) : answered()));

    const stopped = await stoppedWith(agentDemo(opened, RESET_KEY, async () => writesSaved(opened)));

    expect(stopped).toBe("the index does not know Team A's node");
    // The records are on the branch, and the script did not wait for a view that would never show them.
    expect(published(on)).toEqual(saved.paths);
    expect(on.sleeps).toEqual([]);
  });

  it("stops at any other failure of publish", async () => {
    const opened = await stage();
    let pinned = false;
    // Team A's node refuses its key once the pin is done.
    instead((seen, answered) => (pinned && seen.url.startsWith(`${NODE}/admin/`) ? Response.json({ error: "unauthorized" }, { status: 401 }) : answered()));

    const stopped = await stoppedWith(
      agentDemo(opened, RESET_KEY, async () => {
        pinned = true;
        writesSaved(opened);
      }),
    );

    expect(stopped).toBe("team-a: cairnfield publish ended with exit code 4");
    expect(said.at(-1)).toBe('team-a> {"error":"node-refused","reason":"unauthorized"}');
  });

  it("stops and names the record and the reason when the index rejects one", async () => {
    const opened = await stage();
    const [rejected = ""] = saved.ids;
    // The index of the bench rejects no record that passed `validate`. This one's view has one of the findings among its rejected work.
    instead((seen, answered) => {
      const given = answered();
      if (!given || seen.method !== "GET" || !seen.url.endsWith("/view")) return given;
      return Promise.resolve(given).then(async (response) => {
        if (response.status !== 200) return response;
        const view = (await response.json()) as View;
        return Response.json({
          ...view,
          findings: view.findings.map((group) => ({ ...group, findings: group.findings.filter(({ id }) => id !== rejected) })).filter((group) => group.findings.length > 0),
          rejected: view.findings.some((group) => group.findings.some(({ id }) => id === rejected)) ? [{ node: NODE, hash: rejected, type: "finding", reason: "lines-out-of-range" }] : [],
        });
      });
    });

    const stopped = await stoppedWith(agentDemo(opened, RESET_KEY, async () => writesSaved(opened)));

    expect(stopped).toBe(`the index rejected the finding ${rejected}: lines-out-of-range`);
    expect(said.slice(-2)).not.toEqual(["npm run demo:reset", "npm run demo"]);
  });
});

describe("the pause", () => {
  it("ends at Enter and at no other key", async () => {
    const keys = Object.assign(new PassThrough(), { isTTY: true });
    let ended = false;

    const paused = enterAt(keys)().then(() => void (ended = true));
    keys.write("y");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ended).toBe(false);
    keys.write("\n");
    await paused;

    expect(ended).toBe(true);
  });

  it("waits again for each pause", async () => {
    const keys = Object.assign(new PassThrough(), { isTTY: true });
    const pause = enterAt(keys);

    keys.write("\n");
    await pause();
    let ended = false;
    const second = pause().then(() => void (ended = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ended).toBe(false);
    keys.write("\n");
    await second;
  });

  it("stops the script when standard input ends, because no person said go", async () => {
    const keys = Object.assign(new PassThrough(), { isTTY: true });

    const paused = enterAt(keys)();
    keys.end();

    expect(await stoppedWith(paused)).toContain("standard input ended");
  });

  describe("off a terminal", () => {
    let errors: string[];
    let logged: string[];
    beforeEach(() => {
      errors = [];
      logged = [];
      vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
      vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
      const shell = { TEAM_A_NODE_URL: NODE, TEAM_B_NODE_URL: TEAM_B, INDEX_URL: INDEX, TEAM_A_ADMIN_KEY: ADMIN_KEY, TEAM_B_ADMIN_KEY: TEAM_B_KEY, CAIRNFIELD_REGISTRATION_KEY: REGISTRATION_KEY, CAIRNFIELD_RESET_KEY: RESET_KEY };
      for (const [name, value] of Object.entries(shell)) vi.stubEnv(name, value);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it("stops the script before the reset, with a message that names the terminal", async () => {
      // Standard input is a pipe here, as it is when the script is started by another program.
      const piped = new PassThrough();

      await launch("agent demo", ["CAIRNFIELD_RESET_KEY", "CAIRNFIELD_REGISTRATION_KEY"], (opened, resetKey) => {
        stages.push(opened);
        return agentDemo(opened, resetKey, enterAt(piped));
      });

      expect(process.exitCode).toBe(1);
      expect(errors).toEqual(["The agent demo stopped: standard input is not a terminal. The pause is a person's to end, so run this script in a terminal"]);
      expect(logged).toEqual([]);
    });
  });
});
