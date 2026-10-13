// The demo's first step with a review agent of the team's own in it, for a recording.
// This script is the operator's half (R21): it holds the keys, and the agent holds none.
//
//   npm run demo:agent
//
// It resets the demo, pins the plugin's first commit for Team A with the index named in
// the config, and puts the skill file where Claude Code reads one. It prints the line that
// starts Claude Code in the operator's folder with every key of the demo unset, and the
// prompt for the agent. Then it waits. It starts no agent and watches none: the person
// starts the agent in another pane, and presses Enter here once the agent has stopped.
//
// At Enter it publishes what the agent left in the outbox. It first holds the config file
// to the bytes it pinned with, because an agent that has read a hostile component could
// have rewritten it to name another node. It then runs `validate`, and waits again when
// the outbox holds no record or a file is refused. After `publish` it checks that the
// node's branch holds each record and that the index lists each finding, and stops at the
// first that is missing or rejected.
//
// The reset empties the public demo page, and this run leaves one team's findings on it.
// So the script ends by naming the two commands that put the four-step demo back. It
// keeps the operator's folder, whose outbox is what the agent wrote.
//
// It reads the addresses and keys `npm run demo` and `npm run demo:reset` read, under the
// same names, and prints no key, no token and no Git remote.
//
// It exits with 0 when the index lists the records, 1 when a step failed and 2 when it cannot start.

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseRecordPath } from "@cairnfield/protocol";
import { REGISTRATION_KEY } from "../cli/src/config.ts";
import { EXIT } from "../cli/src/outcome.ts";
import { KEYS, PLUGIN, RESET_KEY, Stopped, attempt, halt, launch, notify, pin, processed, recordsOf, settle, untilView } from "./demo-stage.ts";
import type { Stage } from "./demo-stage.ts";
import { reset } from "./reset-demo.ts";

const { first } = PLUGIN;

const REPO = new URL("../", import.meta.url);
/** The skill file a team's own review agent follows (R21). */
const SKILL = fileURLToPath(new URL("skills/cairnfield/SKILL.md", REPO));
/** Where Claude Code reads a skill of this name, from the folder it is started in. */
const SKILL_FOLDER = ".claude/skills/cairnfield";
/** The command's launcher. The command's name is linked in this repo only, so an agent in another folder starts it by this path. */
const LAUNCHER = fileURLToPath(new URL("cli/bin/cairnfield.mjs", REPO));
const CONFIG_FILE = "cairnfield.json";

/** A path as one word of a shell line: as it is when every character is plain, and in single quotes otherwise. */
const word = (path: string): string => (/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);

/** Waits until the person at the operator's pane says go. */
export type Pause = () => Promise<void>;

/**
 * The pause of a run from the command line. It ends when the person presses Enter and at
 * no other key, so a keystroke made while finding the pane publishes nothing. Off a
 * terminal no person is there to end it, so the script stops before it has made a call.
 */
export function enterAt(input: NodeJS.ReadableStream & { readonly isTTY?: boolean }): Pause {
  if (input.isTTY !== true) halt("standard input is not a terminal. The pause is a person's to end, so run this script in a terminal");
  return () =>
    new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input });
      lines.once("line", () => {
        resolve();
        lines.close();
      });
      // Closed with no line read: standard input ended, and nobody said go.
      lines.once("close", () => reject(new Stopped("standard input ended before the person said go, so nothing was published")));
    });
}

/**
 * Plays the operator's half of the demo's first step for Team A. `pause` returns when the
 * person says go. The script publishes at no other moment.
 */
export async function agentDemo(stage: Stage, resetKey: string, pause: Pause): Promise<void> {
  const { a, say } = stage;
  await reset(stage, resetKey);

  // With an index in the config, `pin` registers the node and the commit (KTD12), and `publish` tells the index (KTD11).
  await settle(stage, a, { shares: true });
  await pin(stage, a, first);
  const config = join(a.home, CONFIG_FILE);
  const pinnedWith = await readFile(config);

  // A copy and no link, so an agent that writes outside the outbox cannot change the repo's file.
  const skill = join(a.home, SKILL_FOLDER, "SKILL.md");
  await mkdir(dirname(skill), { recursive: true });
  await copyFile(SKILL, skill);

  const nodeVersion = (await readFile(new URL(".nvmrc", REPO), "utf8")).trim();
  say(`The operator's folder: ${a.home}`);
  say(`The skill file is at ${SKILL_FOLDER}/SKILL.md there, where Claude Code reads a skill.`);
  say(`Start the agent in another pane, on Node ${nodeVersion} or later. This line starts Claude Code in that folder with every key of the demo unset:`);
  say(`cd ${word(a.home)} && env ${KEYS.map((name) => `-u ${name}`).join(" ")} claude`);
  say("Then give the agent this prompt:");
  say(`Use the cairnfield skill to review the checkout of ${first}. Start \`cairnfield\` as \`node ${word(LAUNCHER)} <command>\`. Stop when validate accepts your files.`);

  for (;;) {
    // An agent that has quit has no shell left that could write between the checks below and the push.
    say("When the agent has stopped, quit it. Then press Enter here to publish what it wrote.");
    await pause();
    // The config comes first. `validate` reads it, and a config the agent rewrote could name another node.
    const now = await readFile(config).catch(() => undefined);
    if (!now?.equals(pinnedWith)) halt(`${CONFIG_FILE} is not the file this script pinned with, so nothing was published`);
    const checked = await attempt(stage, a, "validate");
    if (checked.code === EXIT.ok) {
      if (checked.output["records"] !== 0) break;
      say("The outbox holds no record, so nothing was published.");
    } else if (checked.code === EXIT.invalid) say("validate refused a file in the outbox, so nothing was published.");
    else halt(`${a.label}: cairnfield validate ended with exit code ${checked.code}`);
  }

  const pushed = await attempt(stage, a, "publish");
  if (pushed.code === EXIT.index) {
    // The records are on the branch, and the index was not told. A notice is a hint (KTD11), so one more is sent.
    say("publish pushed the records and could not tell the index. Sending the notice again.");
    if (!(await notify(stage, a))) halt("the index does not know Team A's node");
  } else if (pushed.code !== EXIT.ok) halt(`${a.label}: cairnfield publish ended with exit code ${pushed.code}`);
  const { head, published } = pushed.output;
  if (typeof head !== "string" || !Array.isArray(published)) return halt("publish printed no head, or no list of the records it pushed");

  const records = published.map((path: unknown) => ({ path: String(path), ...(parseRecordPath(path) ?? halt("publish printed a path that names no record")) }));
  const held = new Set(await recordsOf(stage, a));
  for (const { path } of records) if (!held.has(path)) halt(`${a.label}: the branch of the node's repo of records does not hold ${path}`);

  const view = await untilView(stage, first, "Team A's records", (seen) => seen.state === "ready" && processed(seen, [[a, head]]));
  const listed = new Set(view.findings.flatMap((group) => group.findings.flatMap(({ node, id }) => (node === a.node ? [id] : []))));
  for (const { type, id } of records) {
    const rejected = view.rejected.find((entry) => entry.node === a.node && entry.hash === id);
    if (rejected) halt(`the index rejected the ${type} ${id}: ${rejected.reason}`);
    if (type === "finding" && !listed.has(id)) halt(`the index does not list the finding ${id}`);
  }

  say(`The index lists what ${a.label} published: ${stage.index}/components/${first}`);
  say(`The operator's folder is kept, with the outbox as the agent left it: ${a.home}`);
  say("The public demo page now shows this run alone. These two commands put the four-step demo back:");
  say("npm run demo:reset");
  say("npm run demo");
}

if (import.meta.main) {
  // The registration key is not read here. Naming it has `launch` hold the run to it and hand it to Team A's command, for `pin`.
  await launch("agent demo", [RESET_KEY, REGISTRATION_KEY], (stage, resetKey) => agentDemo(stage, resetKey, enterAt(process.stdin)));
}
