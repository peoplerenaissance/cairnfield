// The note `patch` attaches to its patch commit (R46, KTD44): a blob of canonical JSON
// at `refs/notes/cairnfield` of the team's fork, in a flat tree entry named by the
// commit. Each test works out the bytes, the tree and the notes commit it expects by
// hand, with Git's own plumbing, and takes none of them from the command.
//
// A local repo takes a push to any ref, and the fake node gives one token for every
// scope. So no test here shows what Artifacts does with a notes ref or with a read token.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_KEY_HEADER } from "@cairnfield/protocol";
import { said, withScratch } from "../../src/git.ts";
import { EXIT } from "../../src/outcome.ts";
import { forkAccess } from "../../src/services.ts";
import { FIXTURES, NODE, answers, bench, calls, git, pinned, published, saveOutbox } from "../support.ts";
import type { Bench } from "../support.ts";

// Two of Team A's saved findings: the any-host rule on line 12 of `plugin.json`, and the
// hidden instruction on line 41 of the skill file.
const ANY_HOST = "72b5c551a1e4d6e2a878068dfd3dc3eceac11ed32d56e0110d54dcc67fd83ba9";
const HIDDEN = "981ae3aa8aadd84d9f44c609c4302727d91b4d381b92c124d7216879aa665b08";

interface Edit {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

const NAME_THE_HOST: readonly Edit[] = [{ path: "plugin.json", start: 12, end: 12, lines: ['    "network": { "hosts": ["api.fellbeck-notes.example"] },'] }];
const DROP_THE_LINE: readonly Edit[] = [{ path: "skills/sync/SKILL.md", start: 41, end: 41, lines: [] }];

const NOTES_REF = "refs/notes/cairnfield";
const MODEL = "claude-sonnet-5-5";
/** A commit no patch of a test has: the name of a note that someone else wrote. */
const ANOTHER_COMMIT = "ab".repeat(20);

const sha256 = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

/** The SHA-256 of the patch prompt's file, as `shasum -a 256` gives it. */
const PROMPT = sha256(readFileSync(new URL("../../src/agents/prompts/patch.md", import.meta.url)));

// A test here runs several commands against real Git, and some run them on two deployments.
vi.setConfig({ testTimeout: 30_000 });

let on: Bench;
const others: Bench[] = [];
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
  for (const other of others.splice(0)) other.dispose();
});

/** A team with a label, the demo plugin pinned and its saved findings published. Returns the pinned commit. */
async function team(at: Bench = on): Promise<string> {
  at.configure({ node: NODE, team: "team-a", recordings: "recordings" });
  const { first } = await pinned(at);
  saveOutbox(at, "team-a");
  const outcome = await at.run("publish");
  if (outcome.code !== EXIT.ok) throw new Error(`the publish failed: ${JSON.stringify(outcome.output)}`);
  return first;
}

/** Another deployment of the same team, with the recordings of the first. */
async function reader(): Promise<Bench> {
  const other = bench();
  others.push(other);
  await team(other);
  cpSync(join(on.home, "recordings"), join(other.home, "recordings"), { recursive: true });
  return other;
}

/** The model asks for its target and reads the file, then gives its edits. */
function modelWrites(edits: readonly Edit[]): void {
  on.model.answers.push(calls(["get_target", {}]), calls(["read_file", { path: "plugin.json", from: 1 }]), answers({ edits }));
}

const fork = (at: Bench, component: string): string => at.repo(`fork-${component}`);
const recording = (component: string, id: string): string => `recordings/team-a/${component}/${id}.json`;

/** What a recording holds, beside the schema version. */
interface Recorded {
  readonly component: string;
  readonly finding: string;
  readonly claim: number;
  readonly model: string;
  readonly prompt?: string;
  readonly edits: readonly Edit[];
}

/** Saves a recording by hand, on one line and with its keys in another order than a live run writes them. */
function record(recorded: Recorded): void {
  const file = join(on.home, recording(recorded.component, recorded.finding));
  mkdirSync(dirname(file), { recursive: true });
  const { edits, ...rest } = recorded;
  writeFileSync(file, JSON.stringify({ edits, ...rest, version: "1" }));
}

/** A recording as canonical JSON, written out key by key: sorted keys, no white space. Its file holds other bytes. */
function recordedJson(recorded: Recorded): string {
  const edits = recorded.edits.map(({ path, start, end, lines }) => `{"end":${end},"lines":[${lines.map((line) => JSON.stringify(line)).join(",")}],"path":"${path}","start":${start}}`);
  const prompt = recorded.prompt === undefined ? "" : `"prompt":"${recorded.prompt}",`;
  return `{"claim":${recorded.claim},"component":"${recorded.component}","edits":[${edits.join(",")}],"finding":"${recorded.finding}","model":"${recorded.model}",${prompt}"version":"1"}`;
}

/** The note of a patch commit as canonical JSON, written out key by key. */
function noteJson(commit: string, recorded: Recorded): string {
  const prompt = recorded.prompt === undefined ? "" : `"prompt":"${recorded.prompt}",`;
  return `{"commit":"${commit}","findings":["${recorded.finding}"],"model":"${recorded.model}",${prompt}"recording":"${sha256(recordedJson(recorded))}","version":"1"}`;
}

/** The refs a fork holds under a prefix. */
function refsUnder(at: Bench, component: string, prefix: string): string[] {
  const listed = git(fork(at, component), ["for-each-ref", "--format=%(refname)", prefix]);
  return listed === "" ? [] : listed.split("\n");
}

const notesRefs = (at: Bench, component: string): string[] => refsUnder(at, component, "refs/notes/");

/** The commit a fork's notes ref points to. */
const notesHead = (at: Bench, component: string): string => git(fork(at, component), ["rev-parse", "--verify", NOTES_REF]);

/** The entries of a fork's notes tree, top level only, each as `ls-tree` prints it. */
const notesTree = (at: Bench, component: string): string[] => git(fork(at, component), ["ls-tree", NOTES_REF]).split("\n");

/** The bytes of the note a fork holds for a commit, as Git stores them. */
function noteOf(at: Bench, component: string, commit: string): string {
  return execFileSync("git", ["-C", fork(at, component), "cat-file", "blob", `${NOTES_REF}:${commit}`]).toString("utf8");
}

/** A commit of a fork with the commits it names as its parents, as `rev-list` prints them. */
const withParents = (at: Bench, component: string, commit: string): string => git(fork(at, component), ["rev-list", "--parents", "-n", "1", commit]);

// The author, the committer and the dates of every commit the command builds on a component.
const COMMAND = {
  PATH: process.env["PATH"] ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Cairnfield command",
  GIT_AUTHOR_EMAIL: "command@cairnfield.example",
  GIT_COMMITTER_NAME: "Cairnfield command",
  GIT_COMMITTER_EMAIL: "command@cairnfield.example",
  GIT_AUTHOR_DATE: "1760000000 +0000",
  GIT_COMMITTER_DATE: "1760000000 +0000",
};

/**
 * The notes commit as Git's plumbing builds it by hand: a flat tree with one plain file
 * for each note, named by its commit, under the command's fixed author, dates and
 * message, on a parent or on none. It is built in the fork, which holds the parent, and
 * no ref points to it.
 */
function notesCommit(at: Bench, component: string, notes: readonly (readonly [commit: string, bytes: string])[], parent?: string): string {
  const plumb = (args: readonly string[], input?: string): string =>
    execFileSync("git", ["-C", fork(at, component), ...args], { env: COMMAND, encoding: "utf8", ...(input === undefined ? {} : { input }) }).trim();
  const entries = notes.map(([commit, bytes]) => `100644 blob ${plumb(["hash-object", "-w", "--stdin"], bytes)}\t${commit}\n`);
  const tree = plumb(["mktree"], entries.join(""));
  return plumb(["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", "Cairnfield note"]);
}

/** One file of a notes tree that a test writes by hand. */
interface Held {
  readonly path: string;
  readonly content: string;
}

/**
 * Puts a notes tree of these files alone in a fork, as someone other than the command
 * would, in a commit on top of the notes the fork holds. Returns the notes commit.
 */
function writeNotes(at: Bench, component: string, files: readonly Held[]): string {
  const repo = fork(at, component);
  const parent = notesRefs(at, component).includes(NOTES_REF) ? ["-p", notesHead(at, component)] : [];
  git(repo, ["read-tree", "--empty"]);
  for (const { path, content } of files) {
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${git(repo, ["hash-object", "-w", "--stdin"], content)},${path}`]);
  }
  const commit = git(repo, ["commit-tree", git(repo, ["write-tree"]), ...parent, "-m", "notes by hand"]);
  git(repo, ["update-ref", NOTES_REF, commit]);
  return commit;
}

/** The pushes of the notes ref among the Git calls the command made. */
const notesPushes = (gitCalls: readonly (readonly string[])[]): (readonly string[])[] =>
  gitCalls.filter((args) => args[0] === "push" && args.some((arg) => arg.endsWith(`:${NOTES_REF}`)));

describe("the note on a patch commit (R46, KTD44)", () => {
  it("writes the same note bytes and the same notes commit in a live run and in its replay on another deployment", async () => {
    const first = await team();
    on.nextRandom = 31;
    modelWrites(NAME_THE_HOST);
    const live = await on.run("patch", first, "--finding", ANY_HOST);
    expect(live).toMatchObject({ code: EXIT.ok, output: { note: "written" } });
    const commit = String(live.output["commit"]);

    // The live run saved the hash of the prompt its agent ran under.
    const saved = JSON.parse(readFileSync(join(on.home, recording(first, ANY_HOST)), "utf8")) as { readonly [field: string]: unknown };
    expect(saved["prompt"]).toBe(PROMPT);

    const other = await reader();
    // A replay calls no model, so it runs with no model key.
    delete other.env["ANTHROPIC_API_KEY"];
    const replayed = await other.run("patch", first, "--finding", ANY_HOST, "--replay");
    expect(replayed).toMatchObject({ code: EXIT.ok, output: { note: "written", commit } });

    // The recording's file holds line breaks and indents. The note names the hash of its canonical JSON.
    const bytes = noteJson(commit, { component: first, finding: ANY_HOST, claim: 31, model: MODEL, prompt: PROMPT, edits: NAME_THE_HOST });
    expect(noteOf(on, first, commit)).toBe(bytes);
    expect(noteOf(other, first, commit)).toBe(bytes);
    expect(notesHead(on, first)).toBe(notesCommit(on, first, [[commit, bytes]]));
    expect(notesHead(other, first)).toBe(notesHead(on, first));
  });

  it("leaves one entry in the notes tree after a replay, named by the patch commit, that holds the canonical JSON of the note's six fields", async () => {
    const first = await team();
    // The recording names a prompt of its own, and no file has that hash: a replay copies it and hashes no prompt.
    const recorded: Recorded = { component: first, finding: ANY_HOST, claim: 31, model: MODEL, prompt: "5a".repeat(32), edits: NAME_THE_HOST };
    record(recorded);

    const outcome = await on.run("patch", first, "--finding", ANY_HOST, "--replay");

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { note: "written" } });
    const commit = String(outcome.output["commit"]);
    const bytes = noteJson(commit, recorded);
    expect(notesRefs(on, first)).toEqual([NOTES_REF]);
    expect(notesTree(on, first)).toEqual([`100644 blob ${git(fork(on, first), ["hash-object", "--stdin"], bytes)}\t${commit}`]);
    expect(noteOf(on, first, commit)).toBe(bytes);
    expect(JSON.parse(noteOf(on, first, commit))).toEqual({
      version: "1",
      commit,
      findings: [ANY_HOST],
      model: MODEL,
      recording: sha256(recordedJson(recorded)),
      prompt: "5a".repeat(32),
    });
    // The first notes commit of a fork has no parent, and the command's fixed author, dates and message.
    expect(notesHead(on, first)).toBe(notesCommit(on, first, [[commit, bytes]]));
  });

  it("gives the note to a fetch of the notes ref from the fork, with the read token the node gives anyone", async () => {
    const first = await team();
    modelWrites(NAME_THE_HOST);
    on.nextRandom = 31;
    const outcome = await on.run("patch", first, "--finding", ANY_HOST);
    const commit = String(outcome.output["commit"]);
    const requests = on.requests.length;

    // A reader holds the node's address and the component, and no key.
    const access = await forkAccess({ ...on.io, env: {} }, NODE, first);
    if (!access.ok) throw new Error("the node gave no read token");
    const read = await withScratch(on.io, async (scratch) => {
      await scratch.git("fetch", ["fetch", "--quiet", access.body.remote, `${NOTES_REF}:${NOTES_REF}`], { access: access.body });
      return {
        names: said(await scratch.git("ls-tree", ["ls-tree", "--name-only", NOTES_REF])),
        // Git's own reader of notes finds the note under the commit, with no object of the commit at hand.
        shown: said(await scratch.git("notes", ["notes", "--ref=cairnfield", "show", commit])),
      };
    });

    expect(on.requests.slice(requests).map(({ method, url, headers }) => [method, url, headers.get(ADMIN_KEY_HEADER)])).toEqual([["GET", `${NODE}/read-token?component=${first}`, null]]);
    expect(read.names).toBe(commit);
    expect(read.shown).toBe(noteJson(commit, { component: first, finding: ANY_HOST, claim: 31, model: MODEL, prompt: PROMPT, edits: NAME_THE_HOST }));
  });

  it.each([
    ["names a model and no prompt", MODEL],
    ["has the model `none`", "none"],
  ])("writes a note with no prompt for a recording that %s", async (_what, model) => {
    const first = await team();
    const recorded: Recorded = { component: first, finding: ANY_HOST, claim: 31, model, edits: NAME_THE_HOST };
    record(recorded);

    const outcome = await on.run("patch", first, "--finding", ANY_HOST, "--replay");

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { note: "written" } });
    const commit = String(outcome.output["commit"]);
    expect(noteOf(on, first, commit)).toBe(`{"commit":"${commit}","findings":["${ANY_HOST}"],"model":"${model}","recording":"${sha256(recordedJson(recorded))}","version":"1"}`);
  });

  it("moves the notes ref once when the same patch runs twice: the second run finds its note there and pushes nothing for it", async () => {
    const first = await team();
    modelWrites(NAME_THE_HOST);
    const live = await on.run("patch", first, "--finding", ANY_HOST);
    const head = notesHead(on, first);
    const gitCalls = on.gitCalls.length;
    expect(notesPushes(on.gitCalls)).toHaveLength(1);

    const again = await on.run("patch", first, "--finding", ANY_HOST, "--replay");

    expect(again).toMatchObject({ code: EXIT.ok, output: { note: "already-there", commit: live.output["commit"] } });
    expect(notesHead(on, first)).toBe(head);
    expect(git(fork(on, first), ["rev-list", "--count", NOTES_REF])).toBe("1");
    // A push of the ref would start the node's Workflow, which sends the index a notice.
    expect(notesPushes(on.gitCalls.slice(gitCalls))).toEqual([]);
  });

  it("leaves two entries for two patches of one commit, and the second notes commit names the first as its parent", async () => {
    const first = await team();
    on.nextRandom = 1;
    modelWrites(NAME_THE_HOST);
    const one = String((await on.run("patch", first, "--finding", ANY_HOST)).output["commit"]);
    const earlier = notesHead(on, first);
    on.nextRandom = 2;
    on.model.answers.push(answers({ edits: DROP_THE_LINE }));

    const outcome = await on.run("patch", first, "--finding", HIDDEN);

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { note: "written" } });
    const two = String(outcome.output["commit"]);
    const notes: [string, string][] = [
      [one, noteJson(one, { component: first, finding: ANY_HOST, claim: 1, model: MODEL, prompt: PROMPT, edits: NAME_THE_HOST })],
      [two, noteJson(two, { component: first, finding: HIDDEN, claim: 2, model: MODEL, prompt: PROMPT, edits: DROP_THE_LINE })],
    ];
    expect(git(fork(on, first), ["ls-tree", "--name-only", NOTES_REF]).split("\n")).toEqual([one, two].sort());
    for (const [commit, bytes] of notes) expect(noteOf(on, first, commit)).toBe(bytes);
    expect(withParents(on, first, notesHead(on, first))).toBe(`${notesHead(on, first)} ${earlier}`);
    expect(earlier).toBe(notesCommit(on, first, notes.slice(0, 1)));
    expect(notesHead(on, first)).toBe(notesCommit(on, first, notes, earlier));
  });

  it.each<[string, (commit: string) => Held]>([
    ["a file with other bytes", (commit) => ({ path: commit, content: '{"commit":"another"}' })],
    ["a folder", (commit) => ({ path: `${commit}/inner`, content: "other bytes" })],
  ])("replaces %s under the commit's name, in a notes commit on top of the old one, and keeps the other entries", async (_what, there) => {
    const first = await team();
    on.nextRandom = 31;
    modelWrites(NAME_THE_HOST);
    const commit = String((await on.run("patch", first, "--finding", ANY_HOST)).output["commit"]);
    // Someone writes over the note, and adds one for another commit.
    const overwritten = writeNotes(on, first, [there(commit), { path: ANOTHER_COMMIT, content: "another note" }]);

    const again = await on.run("patch", first, "--finding", ANY_HOST, "--replay");

    expect(again).toMatchObject({ code: EXIT.ok, output: { note: "replaced", commit } });
    const bytes = noteJson(commit, { component: first, finding: ANY_HOST, claim: 31, model: MODEL, prompt: PROMPT, edits: NAME_THE_HOST });
    expect(noteOf(on, first, commit)).toBe(bytes);
    expect(withParents(on, first, notesHead(on, first))).toBe(`${notesHead(on, first)} ${overwritten}`);
    expect(notesHead(on, first)).toBe(notesCommit(on, first, [[commit, bytes], [ANOTHER_COMMIT, "another note"]], overwritten));
  });

  it("builds its notes commit again when the notes ref moved between its fetch and its push, and keeps both entries", async () => {
    const first = await team();
    on.nextRandom = 31;
    modelWrites(NAME_THE_HOST);
    // Another run of the team lands a note of its own, once, just before this run's push of the ref.
    let landed: string | undefined;
    on.beforeGit = (args) => {
      if (landed === undefined && notesPushes([args]).length > 0) landed = writeNotes(on, first, [{ path: ANOTHER_COMMIT, content: "another note" }]);
    };

    const outcome = await on.run("patch", first, "--finding", ANY_HOST);

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { note: "written" } });
    const commit = String(outcome.output["commit"]);
    const bytes = noteJson(commit, { component: first, finding: ANY_HOST, claim: 31, model: MODEL, prompt: PROMPT, edits: NAME_THE_HOST });
    expect(notesPushes(on.gitCalls)).toHaveLength(2);
    expect(noteOf(on, first, commit)).toBe(bytes);
    expect(noteOf(on, first, ANOTHER_COMMIT)).toBe("another note");
    expect(notesHead(on, first)).toBe(notesCommit(on, first, [[commit, bytes], [ANOTHER_COMMIT, "another note"]], landed));
  });

  it("publishes no patch record when the fork refuses the notes ref, keeps the recording, and a replay finishes the run once the fork takes the ref (AE21)", async () => {
    const first = await team();
    on.nextRandom = 9;
    modelWrites(NAME_THE_HOST);
    // The fork takes the patch branch, and from then on turns down every push to a notes ref.
    on.beforeGit = (args) => {
      if (args[0] === "push" && args.some((arg) => arg.includes(":refs/heads/patch/"))) git(fork(on, first), ["config", "receive.hideRefs", "refs/notes"]);
    };

    const stopped = await on.run("patch", first, "--finding", ANY_HOST);

    expect(stopped).toMatchObject({ code: EXIT.git, output: { error: "git-failed", step: "push", number: 9 } });
    // The patch branch landed and the note did not, so no record announces the commit.
    expect(refsUnder(on, first, "refs/heads/patch/")).toHaveLength(1);
    expect(notesRefs(on, first)).toEqual([]);
    expect(published(on).filter((path) => path.includes("/patch/"))).toEqual([]);
    // The outbox holds the four findings and the claim, and no patch record waits there.
    expect((await on.run("validate")).output).toEqual({ records: 5, rejected: [] });
    const kept = readFileSync(join(on.home, recording(first, ANY_HOST)), "utf8");
    expect(JSON.parse(kept)).toMatchObject({ claim: 9, edits: NAME_THE_HOST });

    on.beforeGit = undefined;
    git(fork(on, first), ["config", "--unset", "receive.hideRefs"]);
    on.nextRandom = 10;
    const finished = await on.run("patch", first, "--finding", ANY_HOST, "--replay");

    expect(finished).toMatchObject({ code: EXIT.ok, output: { claim: stopped.output["claim"], number: 9, note: "written" } });
    const commit = String(finished.output["commit"]);
    expect(noteOf(on, first, commit)).toBe(noteJson(commit, { component: first, finding: ANY_HOST, claim: 9, model: MODEL, prompt: PROMPT, edits: NAME_THE_HOST }));
    expect(published(on).filter((path) => path.includes("/claim/"))).toHaveLength(1);
    expect(published(on).filter((path) => path.includes("/patch/"))).toEqual([`records/${first}/patch/${String(finished.output["patch"])}.json`]);
    expect(readFileSync(join(on.home, recording(first, ANY_HOST)), "utf8")).toBe(kept);
  });

  it("leaves no notes ref in the fork of the newer commit when `carry` builds the patch again there", async () => {
    on.configure({ node: NODE, team: "team-a", recordings: `${FIXTURES}recordings` });
    const { first, later, branch } = await pinned(on);
    // The node's copy of the later commit, as an import of the plugin's branch gives it.
    git(on.repo(`copy-${first}`), ["push", "--quiet", on.createRepo(`copy-${later}`), branch]);
    saveOutbox(on, "team-a");
    expect((await on.run("publish")).code).toBe(EXIT.ok);
    expect(await on.run("patch", first, "--finding", ANY_HOST, "--replay")).toMatchObject({ code: EXIT.ok, output: { note: "written" } });

    const carried = await on.run("carry", first, later, "--branch", branch);

    expect(carried.code).toBe(EXIT.ok);
    const patches = carried.output["patches"] as { readonly carried: boolean; readonly commit: string }[];
    expect(patches.map((patch) => patch.carried)).toEqual([true]);
    // The carried commit is in the fork of the later commit, and only the fork of the first one holds a notes ref.
    expect(git(fork(on, later), ["cat-file", "-t", patches[0]?.commit ?? ""])).toBe("commit");
    expect(notesRefs(on, first)).toEqual([NOTES_REF]);
    expect(notesRefs(on, later)).toEqual([]);
  });
});
