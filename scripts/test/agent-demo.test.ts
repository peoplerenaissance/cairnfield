// The operator's script of the agent demo, played on this machine: two fake nodes with
// local repos behind them, an index that applies the protocol's own rules, and a pause in
// which the test plays the review agent. No test reaches a network, calls a model or
// starts an agent.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, TEAM_BRANCH } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
import { ADMIN_KEY, FIXTURES, INDEX, NODE, OUTBOX, REGISTRATION_KEY, git, published } from "../../cli/test/support.ts";
import type { Bench, Seen, Site } from "../../cli/test/support.ts";
import { agentDemo, enterAt } from "../agent-demo.ts";
import { PLUGIN, Stopped, openStage } from "../demo-stage.ts";
import type { Stage } from "../demo-stage.ts";
import { demo } from "../demo.ts";
import { DEPLOYMENT, KEY_NAMES, RESET_KEY, TEAM_B, TEAM_B_KEY, demoBench, expectNothingSecretIn, stoppedWith } from "./demo-bench.ts";
import { isNotice } from "./index.ts";
import type { TestIndex } from "./index.ts";

vi.setConfig({ testTimeout: 600_000 });

const REPO = fileURLToPath(new URL("../../", import.meta.url));
/** The name a record waits under until `validate` has said its ID. */
const PLACEHOLDER = `${"0".repeat(64)}.json`;
/** What the script says last, whether it finished or stopped: the commands that put the four-step demo back. */
const RESTORE = ["These two commands put the four-step demo back on the public demo page:", "npm run demo:reset", "npm run demo"];

let on: Bench;
let teamB: Site;
let index: TestIndex;
let commits: { readonly first: string; readonly later: string };
/** What the script told the person who runs it. */
let said: string[];
/** Called with each line the script says, as it says it. */
let onSaid: (line: string) => void;
/** Team A's saved findings, which the test writes as the agent: each file's path in an outbox, and each record's ID. */
let saved: { readonly paths: readonly string[]; readonly ids: readonly string[] };
const stages: Stage[] = [];

afterEach(() => {
  for (const opened of stages.splice(0)) rmSync(opened.work, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** Sets the stage for one run of the script on the bench. */
async function stage(): Promise<Stage> {
  const say = (line: string): void => {
    said.push(line);
    onSaid(line);
  };
  const opened = await openStage(on.io, DEPLOYMENT, say);
  stages.push(opened);
  return opened;
}

const outboxOf = (opened: Stage): string => join(opened.a.home, OUTBOX);

/** The agent's part, played by the test: Team A's saved findings, each written where it belongs in the outbox. */
const writesSaved = (opened: Stage): void => cpSync(`${FIXTURES}outboxes/team-a/records`, join(outboxOf(opened), "records"), { recursive: true });

/** What the command printed for the last run of one of its commands by Team A. */
function printed(name: string): { readonly [field: string]: unknown } {
  const ran = said.lastIndexOf(`team-a$ cairnfield ${name}`);
  const output = said.slice(ran).find((line) => line.startsWith("team-a> ")) ?? "";
  return JSON.parse(output.slice("team-a> ".length)) as { readonly [field: string]: unknown };
}

/** How many times Team A ran one of the command's commands. */
const timesRun = (name: string): number => said.filter((line) => line === `team-a$ cairnfield ${name}` || line.startsWith(`team-a$ cairnfield ${name} `)).length;

/** The requests the fake nodes got on their admin routes, from one request on. */
const adminCalls = (from: number): string[] => on.requests.slice(from).flatMap(({ url }) => (url.includes("/admin/") ? [url] : []));

/** The IDs of the findings the index lists for the plugin's first commit. */
async function listed(): Promise<string[]> {
  const view = await index.view(commits.first);
  return (view?.findings.flatMap((group) => group.findings.map(({ id }) => id)) ?? []).sort();
}

/** The line the script says once the index lists the records. A run that stopped does not say it. */
const success = (): string => `The index lists what team-a published: ${INDEX}/components/${commits.first}`;

/** Everything the script told the operator, on either stream, holds no key, no token and no Git remote. */
const expectNothingSecretSaid = (): void => expectNothingSecretIn([...said, ...on.warnings].join("\n"));

/** One word of a line the script printed for a shell, as a shell reads it. */
const asShellReads = (word: string): string => execFileSync("sh", ["-c", `printf %s ${word}`], { encoding: "utf8" });

/** The folder the printed line changes to, as the script wrote it for a shell: the text between `cd` and `&& env`. */
function folderWord(lines: readonly string[]): string {
  const starts = lines.filter((line) => line.endsWith(" claude"));
  expect(starts).toHaveLength(1);
  return /^cd (.+) && env /.exec(starts[0] ?? "")?.[1] ?? "";
}

type Respond = NonNullable<Bench["respond"]>;

/** Has a test answer a request in its own way. `answered` gives what the bench's index answers, and nothing for a request to a node. */
function instead(respond: (seen: Seen, answered: () => ReturnType<Respond>) => ReturnType<Respond>): void {
  const answered = on.respond;
  on.respond = (seen) => respond(seen, () => answered?.(seen));
}

/** Has the index serve each view as a test rewrites it. */
function viewAs(rewrite: (view: View) => View): void {
  instead((seen, answered) => {
    const given = answered();
    if (!given || seen.method !== "GET" || !seen.url.endsWith("/view")) return given;
    return Promise.resolve(given).then(async (response) => (response.status === 200 ? Response.json(rewrite((await response.json()) as View)) : response));
  });
}

/** A view without one finding. */
const without = (view: View, id: string): View => ({
  ...view,
  findings: view.findings.map((group) => ({ ...group, findings: group.findings.filter((finding) => finding.id !== id) })).filter((group) => group.findings.length > 0),
});

describe("the agent demo's operator script", () => {
  beforeEach(() => {
    ({ on, teamB, index, commits } = demoBench());
    said = [];
    onSaid = () => undefined;
    const names = readdirSync(`${FIXTURES}outboxes/team-a/records/${commits.first}/finding`).sort();
    saved = { paths: names.map((name) => `records/${commits.first}/finding/${name}`), ids: names.map((name) => name.replace(/\.json$/, "")) };
  });

  afterEach(() => {
    on.dispose();
  });

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
    // It says so, and ends by naming the two commands that put the public page back, each on a line of its own.
    expect(said).toContain(success());
    expect(said.slice(-3)).toEqual(RESTORE);
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

      // The skill is the repo's file, byte for byte, as a file of its own in the operator's folder, and nowhere under the user's home.
      const repoSkill = readFileSync(join(REPO, "skills/cairnfield/SKILL.md"));
      expect(placed?.equals(repoSkill)).toBe(true);
      expect(readFileSync(skill).equals(repoSkill)).toBe(true);
      expect(lstatSync(skill).isFile()).toBe(true);
      expect(lstatSync(dirname(skill)).isDirectory()).toBe(true);
      expect(readdirSync(home)).toEqual([]);

      // One line starts Claude Code in the operator's folder with every key name unset.
      expect(asShellReads(folderWord(before))).toBe(opened.a.home);
      const [start = ""] = before.filter((line) => line.endsWith(" claude"));
      for (const name of KEY_NAMES) expect(start).toContain(` -u ${name} `);
      expect(start.match(/ -u /g)).toHaveLength(KEY_NAMES.length);
      // The pane needs the Node the repo names.
      expect(before.some((line) => line.includes(`Node ${readFileSync(join(REPO, ".nvmrc"), "utf8").trim()}`))).toBe(true);
      // The prompt names the pinned commit and the launcher by its path on this machine.
      const prompt = /^Use the cairnfield skill to review the checkout of ([0-9a-f]{40})\. Start `cairnfield` as `node (.+)`\. Stop when validate accepts your files\.$/;
      const [, commit, launcher = ""] = before.map((line) => prompt.exec(line)).find((found) => found !== null) ?? [];
      expect(commit).toBe(commits.first);
      expect(asShellReads(launcher)).toBe(join(REPO, "cli/bin/cairnfield.mjs"));
      expect(before).toContain(`The operator's folder: ${opened.a.home}`);
      // The person pastes from these lines into a shell that runs a comment line as a command.
      expect(said.filter((line) => line.trimStart().startsWith("#"))).toEqual([]);
      expectNothingSecretSaid();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("quotes the operator's folder for the shell when its path holds a space or a quote", async () => {
    const odd = mkdtempSync(join(tmpdir(), "cairnfield it's odd-"));
    try {
      vi.stubEnv("TMPDIR", odd);
      const opened = await stage();
      expect(opened.a.home.startsWith(odd)).toBe(true);

      await agentDemo(opened, RESET_KEY, async () => writesSaved(opened));

      const word = folderWord(said);
      expect(word).not.toBe(opened.a.home);
      expect(asShellReads(word)).toBe(opened.a.home);
      expect(published(on)).toEqual(saved.paths);
    } finally {
      rmSync(odd, { recursive: true, force: true });
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
    expect(timesRun("validate") + timesRun("publish")).toBe(0);

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
    expect(timesRun("validate") + timesRun("publish")).toBe(0);
    expect(existsSync(on.repo("team"))).toBe(false);
    expect(existsSync(teamB.repo("team"))).toBe(false);
    // A run that stopped still names the commands that put the public page back.
    expect(said).not.toContain(success());
    expect(said.slice(-3)).toEqual(RESTORE);
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
    expect(timesRun("validate") + timesRun("publish")).toBe(0);
  });

  it("sends the admin key to the node it pinned with, when the config file is rewritten after it was checked", async () => {
    const opened = await stage();
    // Something the agent left running rewrites the config once the script has compared it: `validate` is said after the comparison.
    onSaid = (line) => {
      if (line === "team-a$ cairnfield validate") writeFileSync(join(opened.a.home, "cairnfield.json"), `${JSON.stringify({ node: TEAM_B, index: INDEX, team: "team-a" }, null, 2)}\n`);
    };

    await agentDemo(opened, RESET_KEY, async () => writesSaved(opened));

    expect(JSON.parse(readFileSync(join(opened.a.home, "cairnfield.json"), "utf8"))).toMatchObject({ node: TEAM_B });
    // Team B's node got no call that carries a key, and Team A's node holds the records.
    expect(on.requests.filter(({ url }) => url.startsWith(`${TEAM_B}/admin/`))).toEqual([]);
    expect(existsSync(teamB.repo("team"))).toBe(false);
    expect(published(on)).toEqual(saved.paths);
    expect(await listed()).toEqual(saved.ids);
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
      // The second pause: the script has said why it did not publish and how to go on, and it made no call to a node.
      expect(said).toContain("The outbox holds no record, so nothing was published.");
      expect(said).toContain("The line above starts the agent again, in the same folder.");
      expect(adminCalls(calls)).toEqual([]);
      expect(timesRun("publish")).toBe(0);
      writesSaved(opened);
    });

    expect(pauses).toBe(2);
    expect(timesRun("publish")).toBe(1);
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
      expect(timesRun("publish")).toBe(0);
      renameSync(join(folder, PLACEHOLDER), join(outboxOf(opened), record));
    });

    expect(pauses).toBe(2);
    expect(published(on)).toEqual([record]);
    expect(await listed()).toEqual([saved.ids[0]]);
  });

  it("sends the notice itself when publish pushed the records and could not tell the index", async () => {
    const opened = await stage();
    let notices = 0;
    // The index does not take the first notice.
    instead((seen, answered) => (isNotice(seen) && notices++ === 0 ? new Response("", { status: 500 }) : answered()));

    await agentDemo(opened, RESET_KEY, async () => writesSaved(opened));

    expect(printed("publish")).toMatchObject({ published: saved.paths, notice: "failed" });
    expect(notices).toBe(2);
    expect(index.requests.filter(isNotice).map(({ body }) => body)).toEqual([{ node: NODE }]);
    expect(await listed()).toEqual(saved.ids);
    expect(said).toContain(success());
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
    expect(printed("publish")).toEqual({ error: "node-refused", reason: "unauthorized" });
  });

  it("stops when the node's branch does not hold a record publish pushed", async () => {
    const opened = await stage();
    const [missing = ""] = saved.paths;
    // Once Team A's node holds records, it lists every one but the first.
    instead((seen, answered) => {
      if (seen.method !== "GET" || seen.url !== `${NODE}/records` || !existsSync(on.repo("team"))) return answered();
      const head = git(on.repo("team"), ["rev-parse", TEAM_BRANCH]);
      const records = git(on.repo("team"), ["ls-tree", "-r", head, "records/"])
        .split("\n")
        .map((line) => ({ path: line.split("\t")[1] ?? "", blob: line.split(/[ \t]/)[2] ?? "" }))
        .filter(({ path }) => path !== missing);
      return Response.json({ head, records });
    });

    const stopped = await stoppedWith(agentDemo(opened, RESET_KEY, async () => writesSaved(opened)));

    expect(stopped).toBe(`team-a: the branch of the node's repo of records does not hold ${missing}`);
    // It stopped there, and did not wait for the index.
    expect(on.sleeps).toEqual([]);
    expect(said).not.toContain(success());
  });

  it("stops when the index has read the node and does not list a finding", async () => {
    const opened = await stage();
    const [missing = ""] = saved.ids;
    // The index neither lists the finding nor rejects it.
    viewAs((view) => without(view, missing));

    const stopped = await stoppedWith(agentDemo(opened, RESET_KEY, async () => writesSaved(opened)));

    expect(stopped).toBe(`the index does not list the finding ${missing}`);
    expect(said).not.toContain(success());
  });

  it("stops and names the record and the reason when the index rejects one", async () => {
    const opened = await stage();
    const [rejected = ""] = saved.ids;
    // The index of the bench rejects no record that passed `validate`. This one's view has one of the findings among its rejected work.
    viewAs((view) => ({
      ...without(view, rejected),
      rejected: view.findings.some((group) => group.findings.some(({ id }) => id === rejected)) ? [{ node: NODE, hash: rejected, type: "finding", reason: "lines-out-of-range" }] : [],
    }));

    const stopped = await stoppedWith(agentDemo(opened, RESET_KEY, async () => writesSaved(opened)));

    expect(stopped).toBe(`the index rejected the finding ${rejected}: lines-out-of-range`);
    expect(said).not.toContain(success());
    expect(said.slice(-3)).toEqual(RESTORE);
  });
});

describe("the pause", () => {
  /** Standard input of a terminal, as far as the pause can tell. */
  const terminal = (): PassThrough => Object.assign(new PassThrough(), { isTTY: true });
  /** One turn of the event loop, in which a line that was written reaches the pause. */
  const aTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("ends at Enter and at no other key", async () => {
    const keys = terminal();
    let ended = false;

    const paused = enterAt(keys)().then(() => void (ended = true));
    keys.write("y");
    await aTurn();
    expect(ended).toBe(false);
    keys.write("\n");
    await paused;

    expect(ended).toBe(true);
  });

  it("waits again for each pause", async () => {
    const keys = terminal();
    const pause = enterAt(keys);

    keys.write("\n");
    await pause();
    let ended = false;
    const second = pause().then(() => void (ended = true));
    await aTurn();
    expect(ended).toBe(false);
    keys.write("\n");
    await second;
  });

  it("stops the script when standard input ends, because no person said go", async () => {
    const keys = terminal();

    const paused = enterAt(keys)();
    keys.end();

    expect(await stoppedWith(paused)).toContain("standard input ended");
  });

  it("stops the script when standard input ends after a key that was not Enter", async () => {
    const keys = terminal();

    const paused = enterAt(keys)();
    keys.write("y");
    keys.end();

    expect(await stoppedWith(paused)).toContain("standard input ended");
  });

  it("is refused off a terminal, where no person is there to end it", () => {
    // Standard input is a pipe here, as it is when the script is started by another program.
    let stopped: unknown;
    try {
      enterAt(new PassThrough());
    } catch (error) {
      stopped = error;
    }

    expect(stopped).toBeInstanceOf(Stopped);
    expect((stopped as Stopped).message).toBe("standard input is not a terminal. The pause is a person's to end, so run this script in a terminal");
  });
});

describe("the script's start from the command line", () => {
  /** A folder for the run's own temporary folder, so a start that gets as far as setting its stage leaves nothing behind. */
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "cairnfield-start-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Starts the script as `npm run demo:agent` does, with standard input as a pipe. Every address and key is invented, and no start here gets as far as a call. */
  const start = (shell: { readonly [name: string]: string }): { readonly status: number | null; readonly stdout: string; readonly stderr: string } =>
    spawnSync(process.execPath, [join(REPO, "scripts/agent-demo.ts")], { cwd: REPO, env: { PATH: process.env["PATH"] ?? "", TMPDIR: scratch, ...shell }, input: "", encoding: "utf8" });

  it("ends with 2 and names every address and both keys of the index when none is set", () => {
    const ran = start({});

    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain(
      "The agent demo cannot start. Set these in the environment: TEAM_A_NODE_URL, TEAM_B_NODE_URL, INDEX_URL, TEAM_A_ADMIN_KEY, TEAM_B_ADMIN_KEY, CAIRNFIELD_RESET_KEY, CAIRNFIELD_REGISTRATION_KEY",
    );
    expect(ran.stdout).toBe("");
  });

  it("ends with 1 before the reset when standard input is no terminal, with a message that names the terminal", () => {
    const ran = start({
      TEAM_A_NODE_URL: NODE,
      TEAM_B_NODE_URL: TEAM_B,
      INDEX_URL: INDEX,
      TEAM_A_ADMIN_KEY: ADMIN_KEY,
      TEAM_B_ADMIN_KEY: TEAM_B_KEY,
      CAIRNFIELD_REGISTRATION_KEY: REGISTRATION_KEY,
      CAIRNFIELD_RESET_KEY: RESET_KEY,
    });

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("The agent demo stopped: standard input is not a terminal. The pause is a person's to end, so run this script in a terminal");
    // It said nothing: the reset says what it is about to reset before it makes a call.
    expect(ran.stdout).toBe("");
  });
});
