// What the demo script and the reset script share (R27): the two demo teams, each with
// a folder and an admin key of its own, the index they share through, and how a script
// runs the `cairnfield` command for a team and waits for the index.
//
// The scripts run the command in this process, through the entry point `main.ts` uses,
// so a team's command sees that team's key and no other. No address and no key is in
// this repo. Both come from the environment, under the names below.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { INDEX_ROUTES, isIndexUrl, isNodeUrl, isToken } from "@cairnfield/protocol";
import type { NodeListing, View } from "@cairnfield/protocol";
import { MODEL_KEY } from "../cli/src/agents/live.ts";
import { ADMIN_KEY, REGISTRATION_KEY } from "../cli/src/config.ts";
import { processIo } from "../cli/src/io.ts";
import type { Io } from "../cli/src/io.ts";
import { EXIT, Stop } from "../cli/src/outcome.ts";
import type { Outcome } from "../cli/src/outcome.ts";
import { run } from "../cli/src/run.ts";
import { callIndex, nodeListing } from "../cli/src/services.ts";
import type { Answer } from "../cli/src/services.ts";

export const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** The demo plugin's public repo and its two frozen commits (KTD25). */
export const PLUGIN = JSON.parse(await readFile(`${FIXTURES}demo-plugin/COMMITS.json`, "utf8")) as {
  readonly url: string;
  readonly branch: string;
  readonly first: string;
  readonly later: string;
};

// The names the scripts read from the environment. The three addresses have the names
// the deploy scripts of `node/` and `index/` take them under.
const TEAM_A_NODE = "TEAM_A_NODE_URL";
const TEAM_B_NODE = "TEAM_B_NODE_URL";
const INDEX = "INDEX_URL";
const TEAM_A_KEY = "TEAM_A_ADMIN_KEY";
const TEAM_B_KEY = "TEAM_B_ADMIN_KEY";
/** The key of the index's reset route. Only the reset script reads it. */
export const RESET_KEY = "CAIRNFIELD_RESET_KEY";

/** Every key a script or the command may find in the environment. A team's command is handed its own two and none of the rest. */
const KEYS = [ADMIN_KEY, REGISTRATION_KEY, MODEL_KEY, TEAM_A_KEY, TEAM_B_KEY, RESET_KEY];

// What a script prints on a terminal (R44, KTD41). The command prints JSON and knows
// nothing of this. Every line a script says passes through the `say` that `launch`
// supplies, and `runs` below is the only writer of command and result lines, so the
// renderer tells a line's kind by the prefix this file writes. A stream that does not
// paint gets the plain `say` and the unwrapped `warn`, so off a terminal nothing changes.

/** A format `util.styleText` takes: one name or several. */
type Format = Parameters<typeof styleText>[0];
/** Puts one format on a text. A test passes one that marks instead of coloring. */
export type Style = (format: Format, text: string) => string;

/** The color of each speaker's label. */
const COLORS: { readonly [who in Label | "engineer"]: Format } = { "team-a": "cyan", "team-b": "magenta", engineer: "yellow" };
/** The colors of a result's JSON, as `jq` colors by default: keys, strings, and the literals. */
const KEY: Format = "blue";
const STRING: Format = "green";
const LITERAL: Format = "yellow";
const SPEAKERS = /^(team-a|team-b|engineer)(\$ |> |: )(.*)$/s;

/** Whether a stream paints: a terminal whose own check, given the environment, says it shows colors. */
export function paints(stream: { readonly isTTY?: boolean; readonly hasColors?: (env: object) => boolean }, env: object): boolean {
  return stream.isTTY === true && typeof stream.hasColors === "function" && stream.hasColors(env);
}

/**
 * Paints one line a script says. A command has its label in the speaker's color and the
 * command in bold. A result has its label colored and its JSON over several lines, each
 * after the first indented by the width of the prefix. A speaker's prose has only its
 * label colored. A step heading is bold. Any other line, and a result that is not JSON,
 * is unchanged.
 */
export function paintSaid(line: string, style: Style): string {
  if (line.startsWith("Step ")) return style("bold", line);
  const shape = SPEAKERS.exec(line);
  if (!shape) return line;
  const who = shape[1] as keyof typeof COLORS;
  const [, , separator, rest = ""] = shape;
  const label = style(COLORS[who], who);
  if (separator === "$ ") return `${label}$ ${style("bold", rest)}`;
  if (separator === ": ") return `${label}: ${rest}`;
  let value: unknown;
  try {
    value = JSON.parse(rest);
  } catch {
    return line;
  }
  return `${label}> ${paintJson(value, style, " ".repeat(who.length + 2), 0)}`;
}

/**
 * The value as `JSON.stringify` writes it with two spaces, colored by kind. The value is
 * walked and each leaf is written by `JSON.stringify`, so a string is shown escaped and
 * never interpreted (KTD16, KTD33). `pad` is what each line after the first starts with.
 */
function paintJson(value: unknown, style: Style, pad: string, depth: number): string {
  const inner = `${pad}${"  ".repeat(depth + 1)}`;
  const close = `${pad}${"  ".repeat(depth)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${inner}${paintJson(item, style, pad, depth + 1)}`).join(",\n")}\n${close}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([key, item]) => `${inner}${style(KEY, JSON.stringify(key))}: ${paintJson(item, style, pad, depth + 1)}`).join(",\n")}\n${close}}`;
  }
  return style(typeof value === "string" ? STRING : LITERAL, JSON.stringify(value));
}

/**
 * Paints what the command writes to standard error, which is the diff `assemble` prints
 * (R25), one line at a time. The headers `renderDiff` writes and a hunk line are bold, a
 * removed line red, an added line green. Anything else, Git's own messages among it, is
 * unchanged.
 */
export function paintWarn(text: string, style: Style): string {
  return text.split("\n").map((line) => paintDiffLine(line, style)).join("\n");
}

function paintDiffLine(line: string, style: Style): string {
  if (line.startsWith("--- a/") || line.startsWith("+++ b/") || line === "+++ /dev/null" || line.startsWith("@@ ")) return style("bold", line);
  if (line.startsWith("+")) return style("green", line);
  if (line.startsWith("-")) return style("red", line);
  return line;
}

/** The node the lens fixtures name where a deployment has Team B's own. */
const TEAM_B_STAND_IN = "https://node.team-b.example";

export type Label = "team-a" | "team-b";

/** Where a demo runs: the addresses and keys of one deployment. */
export interface Deployment {
  readonly index: string;
  readonly nodes: { readonly [team in Label]: string };
  readonly adminKeys: { readonly [team in Label]: string };
  /** The index's registration key. The reset script registers nothing and needs none. */
  readonly registrationKey?: string;
}

export interface Team {
  /** The label the team's recordings and its saved outbox are kept under (KTD18). */
  readonly label: Label;
  /** The base URL of the team's node, which is its identity (KTD8). */
  readonly node: string;
  /** The folder that holds the team's config file. */
  readonly home: string;
  /** The command's surroundings for this team: its folder, its admin key and no other team's. */
  readonly io: Io;
}

export interface Stage {
  /** The script's own surroundings, with no key in the environment. */
  readonly io: Io;
  readonly index: string;
  readonly a: Team;
  readonly b: Team;
  /** A folder of this run, for the teams' folders and the copies an engineer installs. It holds no key. */
  readonly work: string;
  /** The folder that holds the recordings of the teams' patch runs (KTD18). */
  readonly recordings: string;
  /** Tells the person who runs the script what it does. */
  readonly say: (line: string) => void;
}

/** A script stops with this when a step did not give what the demo needs. Its message is for the person who runs it. */
export class Stopped extends Error {}

/** Stops the script. */
export function halt(why: string): never {
  throw new Stopped(why);
}

/**
 * Reads a deployment from the environment, with the one key of the index the script
 * needs: `key` names the registration key or the reset key. Returns the names that are
 * missing or in no form the protocol accepts, and never a value: a name tells the
 * operator what to set.
 */
export function deploymentFrom(env: Io["env"], key: string): { readonly deployment: Deployment; readonly key: string } | { readonly missing: readonly string[] } {
  const wanted: (readonly [name: string, accepts: (value: unknown) => value is string])[] = [
    [TEAM_A_NODE, isNodeUrl],
    [TEAM_B_NODE, isNodeUrl],
    [INDEX, isIndexUrl],
    [TEAM_A_KEY, isToken],
    [TEAM_B_KEY, isToken],
    [key, isToken],
  ];
  const missing = wanted.filter(([name, accepts]) => !accepts(env[name])).map(([name]) => name);
  if (missing.length > 0) return { missing };
  const value = (name: string): string => env[name] ?? "";
  const deployment: Deployment = {
    index: value(INDEX),
    nodes: { "team-a": value(TEAM_A_NODE), "team-b": value(TEAM_B_NODE) },
    adminKeys: { "team-a": value(TEAM_A_KEY), "team-b": value(TEAM_B_KEY) },
    ...(key === REGISTRATION_KEY ? { registrationKey: value(key) } : {}),
  };
  return { deployment, key: value(key) };
}

/**
 * Sets the stage for one run, in a new folder under the machine's temporary folder. A
 * team's command is handed that team's admin key and the registration key, and no other
 * key. It is handed no model key, so a run cannot call a model (R20).
 */
export async function openStage(io: Io, deployment: Deployment, say: Stage["say"], recordings = `${FIXTURES}recordings`): Promise<Stage> {
  const work = await mkdtemp(join(tmpdir(), "cairnfield-demo-"));
  const keyless = Object.fromEntries(Object.entries(io.env).filter(([name]) => !KEYS.includes(name)));
  const team = async (label: Label): Promise<Team> => {
    const home = join(work, label);
    await mkdir(home);
    const env = { ...keyless, [ADMIN_KEY]: deployment.adminKeys[label], ...(deployment.registrationKey === undefined ? {} : { [REGISTRATION_KEY]: deployment.registrationKey }) };
    return { label, node: deployment.nodes[label], home, io: { ...io, cwd: home, env } };
  };
  return { io: { ...io, cwd: work, env: keyless }, index: deployment.index, a: await team("team-a"), b: await team("team-b"), work, recordings, say };
}

/**
 * Writes a team's config file, and its lens when the team has one. `lens` names a file
 * of `fixtures/lenses/`. Where that file names the stand-in for Team B's node, the lens
 * names the node of this deployment. A config with no index is a team that works alone
 * (KTD40).
 */
export async function settle(stage: Stage, team: Team, as: { readonly shares: boolean; readonly lens?: string }): Promise<void> {
  if (as.lens !== undefined) {
    const fixture = JSON.parse(await readFile(`${FIXTURES}lenses/${as.lens}`, "utf8")) as { readonly teams: readonly string[] };
    const teams = fixture.teams.map((named) => (named === TEAM_B_STAND_IN ? stage.b.node : named));
    await writeFile(join(team.home, "lens.json"), `${JSON.stringify({ ...fixture, teams }, null, 2)}\n`);
  }
  const config = {
    node: team.node,
    ...(as.shares ? { index: stage.index } : {}),
    ...(as.lens === undefined ? {} : { lens: "lens.json" }),
    team: team.label,
    recordings: stage.recordings,
  };
  await writeFile(join(team.home, "cairnfield.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** Runs the command and says what it ran and what it printed. Any exit code but 0 stops the script. Returns what the command printed. */
async function runs(stage: Stage, who: string, io: Io, argv: readonly string[]): Promise<Outcome["output"]> {
  stage.say(`${who}$ cairnfield ${argv.join(" ")}`);
  const outcome = await run(io, argv);
  stage.say(`${who}> ${JSON.stringify(outcome.output)}`);
  if (outcome.code !== EXIT.ok) halt(`${who}: cairnfield ${argv[0] ?? ""} ended with exit code ${outcome.code}`);
  return outcome.output;
}

/** Runs the command for a team. */
export const command = (stage: Stage, team: Team, ...argv: string[]): Promise<Outcome["output"]> => runs(stage, team.label, team.io, argv);

/** Runs the command as an engineer on another machine does: in the run's folder, with no config file and no key. */
export const engineer = (stage: Stage, ...argv: string[]): Promise<Outcome["output"]> => runs(stage, "engineer", stage.io, argv);

/** Whether a service refused a call because it holds no such thing. */
export const notFound = (answer: Answer<unknown>): boolean => !answer.ok && answer.error === "refused" && answer.reason === "not-found";

/** What a team's node lists: the head of its repo of records and the record files. Nothing for a node that holds no record yet. */
export async function listingOf(stage: Stage, team: Team): Promise<NodeListing | undefined> {
  const held = await nodeListing(stage.io, team.node);
  if (held.ok) return held.body;
  return notFound(held) ? undefined : halt(`${team.label}: the node did not list its records`);
}

/** The head of a team's repo of records. A node that holds no record stops the script. */
export async function headOf(stage: Stage, team: Team): Promise<string> {
  return (await listingOf(stage, team))?.head ?? halt(`${team.label}: the node holds no record`);
}

/** Sends the index the hint that a node has news (KTD11). Returns whether the index knows the node. */
export async function notify(stage: Stage, team: Team): Promise<boolean> {
  const answer = await callIndex(stage.io, stage.index, INDEX_ROUTES.notice, { body: { node: team.node } });
  if (answer.ok) return true;
  return notFound(answer) ? false : halt(`the index did not take a notice for ${team.label}`);
}

/** The index is given this long to show what a script waits for. */
const INDEX_DEADLINE_MS = 5 * 60_000;
/** How often the view is read while a script waits. The page reads it as often. */
const POLL_MS = 2_000;

const readView = (stage: Stage, component: string): Promise<Answer<View>> => callIndex(stage.io, stage.index, INDEX_ROUTES.view, { params: { component } });

/** The view of one component commit as the index holds it now, or nothing for a commit the index does not know. A read that fails stops the script. */
export async function viewNow(stage: Stage, component: string): Promise<View | undefined> {
  const answer = await readView(stage, component);
  if (answer.ok) return answer.body;
  return notFound(answer) ? undefined : halt("the index gave no view");
}

/**
 * Reads a view until it holds what the script waits for, and stops the script when the
 * index does not get there in time. A read that fails is tried again, because a commit
 * that was just registered has no view yet. When the last read failed too, the message
 * says how.
 */
export async function untilView(stage: Stage, component: string, awaited: string, holds: (view: View) => boolean): Promise<View> {
  const deadline = stage.io.now() + INDEX_DEADLINE_MS;
  for (;;) {
    const answer = await readView(stage, component);
    if (answer.ok && answer.body.component === component && holds(answer.body)) return answer.body;
    if (stage.io.now() >= deadline) {
      const failed = answer.ok ? "" : `. Its last answer was ${answer.error === "refused" ? answer.reason : answer.error}`;
      return halt(`the index did not show ${awaited} within five minutes${failed}`);
    }
    await stage.io.sleep(POLL_MS);
  }
}

/** Whether a view says the index has processed each of these heads (R12). */
export function processed(view: View, heads: readonly (readonly [team: Team, head: string])[]): boolean {
  return heads.every(([team, head]) => view.nodes.some((node) => node.node === team.node && node.processed === head));
}

/**
 * Runs a script from the command line: reads the deployment from the environment, with
 * the one key of the index that `key` names, sets the stage and plays. The process ends
 * with 2 when the script cannot start and with 1 when it stopped.
 */
export async function launch(script: "demo" | "reset", key: string, play: (stage: Stage, key: string) => Promise<void>): Promise<void> {
  const io = processIo();
  const found = deploymentFrom(io.env, key);
  if ("missing" in found) {
    console.error(`The ${script} cannot start. Set these in the environment: ${found.missing.join(", ")}`);
    process.exit(2);
  }
  // The decision is made once for each stream. Only a stream that paints reaches a painter.
  const style: Style = (format, text) => styleText(format, text, { validateStream: false });
  const say: Stage["say"] = paints(process.stdout, process.env) ? (line) => console.log(paintSaid(line, style)) : (line) => console.log(line);
  const warn: Io["warn"] = paints(process.stderr, process.env) ? (text) => io.warn(paintWarn(text, style)) : io.warn;
  const stage = await openStage({ ...io, warn }, found.deployment, say);
  try {
    await play(stage, found.key);
  } catch (error) {
    if (error instanceof Stopped) console.error(`The ${script} stopped: ${error.message}`);
    else if (error instanceof Stop) console.error(`The ${script} stopped: ${JSON.stringify(error.outcome.output)}`);
    else throw error;
    process.exitCode = 1;
  }
}
