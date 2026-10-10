// `assemble`: how the selected patches become one copy (R25, KTD22). Each patch is
// applied as line edits against the old content, so the copy does not depend on the
// order of the patches, and the operator is shown every line the copy changes.

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, TEAM_BRANCH, recordId } from "@cairnfield/protocol";
import { EXIT } from "../../src/outcome.ts";
import { run } from "../../src/run.ts";
import { FIXTURES, INDEX, NODE, OTHER_NODE, bench, commitEntries, git, pinned, published, saveOutbox } from "../support.ts";
import type { Bench, Entry } from "../support.ts";
import { COPIES, NARROWED, RULES, TREE, bothRules, copied, otherTeam, ownPatch, patchBy, pinnedWith, printed, refsOf, rules, serveView, text, useLens } from "./team.ts";

vi.setConfig({ testTimeout: 60_000 });

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

/** The hash of the tree that holds these entries, worked out by Git in a repo of the test's own. */
function treeOf(entries: readonly Entry[]): string {
  return git(on.createRepo("expected"), ["rev-parse", `${commitEntries(on.createRepo("expected"), entries)}^{tree}`]);
}

/** The small component with other rules at both paths. */
const withRules = (content: string): Entry[] => TREE.map((entry) => (entry.path.endsWith("rules.txt") ? { ...entry, content } : entry));

describe("the copy assemble builds", () => {
  it("holds two patches on adjoining lines of one content", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const third = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const fourth = await ownPatch(on, component, { cites: [[4, 4]], changes: bothRules(rules({ 4: ["allow run sync --dry", "allow run sync --once"] })) });

    const outcome = await on.run("assemble", component);

    const both = rules({ 3: "allow fetch notes.fellbeck.example", 4: ["allow run sync --dry", "allow run sync --once"] });
    expect(outcome.code).toBe(EXIT.ok);
    expect((outcome.output["patches"] as { patchId: string }[]).map(({ patchId }) => patchId)).toEqual([third.patchId, fourth.patchId].sort());
    expect(copied(on, component, "config/rules.txt")).toBe(both);
    expect(outcome.output["tree"]).toBe(treeOf(withRules(both)));
  });

  it("changes every path that holds the content a patch replaces", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });

    const outcome = await on.run("assemble", component);

    expect(outcome.output["paths"]).toEqual(["config/rules.txt", "docs/rules.txt"]);
    expect(copied(on, component, "config/rules.txt")).toBe(rules({ 5: undefined }));
    expect(copied(on, component, "docs/rules.txt")).toBe(rules({ 5: undefined }));
    expect(copied(on, component, "notes.md")).toBe("# Notes\n\nNothing here.\n");
    // A file keeps its mode: the script may still be run.
    expect(statSync(join(on.home, COPIES, component, "run.sh")).mode & 0o111).not.toBe(0);
  });

  it("is refused when two patches change the same line, and the output names both", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const one = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const two = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(rules({ 3: undefined })) });

    const outcome = await on.run("assemble", component);

    expect(outcome).toEqual({
      code: EXIT.invalid,
      output: { error: "patches-conflict", patches: [one.patchId, two.patchId].sort(), refused: [], skipped: [] },
    });
  });

  it("is refused when two patches add lines at the same place", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const one = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(rules({ 3: ["allow fetch docs.fellbeck.example", RULES[2] ?? ""] })) });
    const two = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(rules({ 3: ["allow fetch notes.fellbeck.example", RULES[2] ?? ""] })) });

    const outcome = await on.run("assemble", component);

    expect(outcome.code).toBe(EXIT.invalid);
    expect(outcome.output).toMatchObject({ error: "patches-conflict", patches: [one.patchId, two.patchId].sort() });
  });

  it("is refused when one patch adds lines in the middle of the lines another replaces, and holds both when it adds after them", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const replaces = await ownPatch(on, component, { cites: [[3, 4]], changes: bothRules(rules({ 3: "allow fetch notes.fellbeck.example", 4: "allow run sync --once" })) });
    const after = await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: ["allow read env HOME", RULES[4] ?? ""] })) });

    const composed = await on.run("assemble", component);

    expect(composed.code).toBe(EXIT.ok);
    expect(copied(on, component, "config/rules.txt")).toBe(
      rules({ 3: "allow fetch notes.fellbeck.example", 4: "allow run sync --once", 5: ["allow read env HOME", RULES[4] ?? ""] }),
    );

    const inside = await ownPatch(on, component, { cites: [[4, 4]], changes: bothRules(rules({ 4: ["allow run check", RULES[3] ?? ""] })) });
    const refused = await on.run("assemble", component);

    expect(after.patchId).not.toBe(inside.patchId);
    expect(refused).toMatchObject({ code: EXIT.invalid, output: { error: "patches-conflict", patches: [replaces.patchId, inside.patchId].sort() } });
  });

  it("drops every path of a content that a patch deletes, and refuses another patch on that content", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const deletes = await ownPatch(on, component, { cites: [[1, 5]], changes: [{ path: "config/rules.txt" }, { path: "docs/rules.txt" }] });
    on.warnings.length = 0;

    const outcome = await on.run("assemble", component);

    const gone = (path: string): string[] => [`--- a/${path}`, "+++ /dev/null", "@@ -1,5 +1,0 @@", ...RULES.map((line) => `-${line}`)];
    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["patches"]).toEqual([{ patchId: deletes.patchId, node: NODE, commit: deletes.commit, kind: "removes-only", size: 5 }]);
    expect(outcome.output["tree"]).toBe(treeOf(TREE.filter((entry) => !entry.path.endsWith("rules.txt"))));
    expect(existsSync(join(on.home, COPIES, component, "config/rules.txt"))).toBe(false);
    expect(printed(on)).toBe(text([...gone("config/rules.txt"), ...gone("docs/rules.txt")]));

    const edits = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    expect(await on.run("assemble", component)).toMatchObject({
      code: EXIT.invalid,
      output: { error: "patches-conflict", patches: [deletes.patchId, edits.patchId].sort() },
    });
  });

  it("holds a patch that only changes a file's mode beside one that changes lines", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const mode = await ownPatch(on, component, { path: "run.sh", cites: [[2, 2]], changes: [{ path: "run.sh", mode: "100644" }] });
    await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    on.warnings.length = 0;

    const outcome = await on.run("assemble", component);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["patches"]).toContainEqual({ patchId: mode.patchId, node: NODE, commit: mode.commit, kind: "adds-or-changes", size: 0 });
    expect(outcome.output["paths"]).toEqual(["config/rules.txt", "docs/rules.txt", "run.sh"]);
    expect(statSync(join(on.home, COPIES, component, "run.sh")).mode & 0o111).toBe(0);
    expect(printed(on)).toContain(text(["--- a/run.sh", "+++ b/run.sh", "old mode 100755", "new mode 100644"]));
  });

  it("is refused when one patch ends a file with no line feed and another adds lines after its end", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 }, [...TREE, { path: "steps.txt", content: "one\ntwo\n" }]);
    const ends = await ownPatch(on, component, { path: "steps.txt", cites: [[2, 2]], changes: [{ path: "steps.txt", content: "one\nTWO" }] });
    on.warnings.length = 0;

    const alone = await on.run("assemble", component);

    expect(alone.code).toBe(EXIT.ok);
    expect(copied(on, component, "steps.txt")).toBe("one\nTWO");
    expect(printed(on)).toBe(text(["--- a/steps.txt", "+++ b/steps.txt", "@@ -2,1 +2,1 @@", "-two", "+TWO", "\\ No newline at end of file"]));

    const adds = await ownPatch(on, component, { path: "steps.txt", cites: [[2, 2]], changes: [{ path: "steps.txt", content: "one\ntwo\nthree\n" }] });
    expect(await on.run("assemble", component)).toMatchObject({
      code: EXIT.invalid,
      output: { error: "patches-conflict", patches: [ends.patchId, adds.patchId].sort() },
    });
  });

  it("has one tree hash for two teams with the same patches, whichever team wrote which (AE6)", async () => {
    const component = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
    const other = otherTeam(on);
    const ours = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const theirs = await patchBy(on, other, OTHER_NODE, component, { cites: [[4, 4]], changes: bothRules(rules({ 4: undefined })) });
    serveView(on, component, [ours, theirs]);

    const first = await on.run("assemble", component);

    // The second team has its own folder and its own node. Its lens names the first team.
    const home = join(on.home, "..", "home-of-team-b");
    mkdirSync(join(home, "lenses"), { recursive: true });
    writeFileSync(join(home, "cairnfield.json"), JSON.stringify({ node: OTHER_NODE, index: INDEX, lens: "lenses/lens.json" }));
    writeFileSync(
      join(home, "lenses/lens.json"),
      JSON.stringify({ patchLevel: 2, teams: [NODE], patchKinds: ["removes-only", "adds-or-changes"], publishRecipes: false }),
    );
    git(on.repo(`copy-${component}`), ["push", "--quiet", other.createRepo(`copy-${component}`), TEAM_BRANCH]);
    const second = { ...on.io, cwd: home };
    const pin = await run(second, ["pin", "https://git.fellbeck-tools.example/plugin.git", "--branch", TEAM_BRANCH, "--commit", component]);
    expect(pin.code).toBe(EXIT.ok);

    const again = await run(second, ["assemble", component]);

    expect(first.code).toBe(EXIT.ok);
    expect(again.code).toBe(EXIT.ok);
    expect((first.output["patches"] as { node: string }[]).map(({ node }) => node).sort()).toEqual([NODE, OTHER_NODE]);
    expect(again.output["patches"]).toEqual(first.output["patches"]);
    expect(again.output["tree"]).toBe(first.output["tree"]);
    expect(again.output["commit"]).toBe(first.output["commit"]);
    expect(first.output["tree"]).toBe(treeOf(withRules(rules({ 3: "allow fetch notes.fellbeck.example", 4: undefined }))));
  });

  it("is written down beside its folder, and is taken away when a later run builds none", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const own = await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });

    const built = await on.run("assemble", component);

    const note = join(on.home, COPIES, `${component}.json`);
    expect(JSON.parse(readFileSync(note, "utf8"))).toEqual({ component, patches: [own.patchId], tree: built.output["tree"], commit: built.output["commit"] });

    useLens(on, { patchLevel: 0 });
    expect(await on.run("assemble", component)).toMatchObject({ code: EXIT.ok, output: { patches: [] } });
    expect(existsSync(note)).toBe(false);
    expect(existsSync(join(on.home, COPIES, component))).toBe(false);
  });

  it("is built again as the same commit", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });

    const first = await on.run("assemble", component);
    const again = await on.run("assemble", component);

    expect(first.code).toBe(EXIT.ok);
    expect(again.output).toEqual(first.output);
  });
});

describe("the diff assemble prints", () => {
  it("holds every changed line of the copy and nothing else", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    on.warnings.length = 0;

    await on.run("assemble", component);

    const each = (path: string): string[] => [
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -3,1 +3,1 @@",
      "-allow fetch *",
      "+allow fetch notes.fellbeck.example",
      "@@ -5,1 +5,0 @@",
      "-allow read env",
    ];
    expect(printed(on)).toBe(text([...each("config/rules.txt"), ...each("docs/rules.txt")]));
  });

  it("shows a terminal escape sequence and a right-to-left override as visible escapes", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    // The line clears the screen, and reads on a terminal as if it allowed less than it does.
    const hostile = "allow fetch \u001b[2J\u202eelpmaxe.kcebllef\u202c\\n";
    await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(rules({ 3: hostile })) });
    on.warnings.length = 0;

    await on.run("assemble", component);

    expect(copied(on, component, "config/rules.txt")).toBe(rules({ 3: hostile }));
    expect(printed(on)).toContain("+allow fetch \\x1b[2J\\u{202e}elpmaxe.kcebllef\\u{202c}\\\\n\n");
    // Nothing the terminal would act on is printed: only tabs, line feeds and what can be seen.
    expect(printed(on)).toMatch(/^[\t\n\x20-\x7e]*$/);
  });

  it("shows what a reader would not see, or could not tell from a plain space or a line break", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    // A filler that is drawn as nothing, a mark that joins nothing, a selector, two spaces that are not the plain one,
    // a carriage return, and two characters that break a line.
    const unseen = "allow\u3164fetch\u034f \ufe0f*\u00a0\u3000\r\u0085\u2028\tend";
    await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(rules({ 3: unseen })) });
    on.warnings.length = 0;

    await on.run("assemble", component);

    expect(printed(on)).toContain("+allow\\u{3164}fetch\\u{34f} \\u{fe0f}*\\xa0\\u{3000}\\x0d\\x85\\u{2028}\tend\n");
    expect(printed(on)).toMatch(/^[\t\n\x20-\x7e]*$/);
  });

  it("shows a line that is no UTF-8 byte by byte", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const line = Buffer.concat([Buffer.from("allow fetch "), Buffer.from([0xff, 0x1b, 0x5b, 0x32, 0x4a, 0x7f, 0x5c, 0x09]), Buffer.from("end\n")]);
    const content = Buffer.concat([Buffer.from(text(RULES.slice(0, 2))), line, Buffer.from(text(RULES.slice(3)))]);
    await ownPatch(on, component, { cites: [[3, 3]], changes: [{ path: "config/rules.txt", content }, { path: "docs/rules.txt", content }] });
    on.warnings.length = 0;

    await on.run("assemble", component);

    expect(printed(on)).toContain("+allow fetch \\xff\\x1b[2J\\x7f\\\\\tend\n");
    expect(printed(on)).toMatch(/^[\t\n\x20-\x7e]*$/);
  });
});

describe("a lens that does not publish recipes", () => {
  it("builds the copy, leaves the fork's refs unchanged and publishes nothing", async () => {
    const component = await pinnedWith(on, { patchLevel: 1, publishRecipes: false });
    await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    const refs = refsOf(on.repo(`fork-${component}`));
    const records = published(on);
    const requests = on.requests.length;

    const outcome = await on.run("assemble", component);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["copy"]).toBe(`${COPIES}/${component}`);
    expect(outcome.output).not.toHaveProperty("recipe");
    expect(refsOf(on.repo(`fork-${component}`))).toEqual(refs);
    expect(published(on)).toEqual(records);
    // Nothing was pushed, and the node was asked for no write token.
    expect(on.gitCalls.some((args) => args[0] === "push")).toBe(false);
    expect(on.requests.slice(requests).some((seen) => (seen.body as { scope?: string } | undefined)?.scope === "write")).toBe(false);
  });
});

describe("a lens that publishes recipes", () => {
  it("pushes the copy to its ref in the fork and publishes a recipe that names the patches and the tree", async () => {
    const component = await pinnedWith(on, { patchLevel: 1, publishRecipes: true });
    const one = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const two = await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });

    const outcome = await on.run("assemble", component);

    const fork = on.repo(`fork-${component}`);
    const recipe = { version: SCHEMA_VERSION, type: "recipe", component, patches: [one.patchId, two.patchId].sort(), tree: outcome.output["tree"] };
    expect(outcome.code).toBe(EXIT.ok);
    expect(git(fork, ["rev-parse", `refs/heads/copy/${component}`])).toBe(outcome.output["commit"]);
    expect(git(fork, ["rev-parse", `refs/heads/copy/${component}^{tree}`])).toBe(outcome.output["tree"]);
    expect(git(fork, ["rev-parse", `refs/heads/copy/${component}^`])).toBe(component);
    expect(outcome.output["recipe"]).toBe(await recordId(recipe));
    expect(outcome.output["published"]).toEqual([`records/${component}/recipe/${await recordId(recipe)}.json`]);
    expect(JSON.parse(git(on.repo("team"), ["cat-file", "blob", `${TEAM_BRANCH}:records/${component}/recipe/${await recordId(recipe)}.json`]))).toEqual(recipe);
  });

  it("moves the copy's ref when the selection changes", async () => {
    const component = await pinnedWith(on, { patchLevel: 1, publishRecipes: true });
    await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const first = await on.run("assemble", component);
    await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });

    const second = await on.run("assemble", component);

    expect(second.code).toBe(EXIT.ok);
    expect(second.output["tree"]).not.toBe(first.output["tree"]);
    expect(git(on.repo(`fork-${component}`), ["rev-parse", `refs/heads/copy/${component}`])).toBe(second.output["commit"]);
  });
});

describe("a team working alone on the demo plugin", () => {
  it("builds its copy twice with one tree hash, from the patch its agent wrote", async () => {
    cpSync(`${FIXTURES}lenses`, join(on.home, "lenses"), { recursive: true });
    cpSync(`${FIXTURES}recordings`, join(on.home, "recordings"), { recursive: true });
    on.configure({ node: NODE, team: "team-a", recordings: "recordings", lens: "lenses/team-a-alone.json" });
    const { first: component } = await pinned(on);
    saveOutbox(on, "team-a");
    expect((await on.run("publish")).code).toBe(EXIT.ok);
    const finding = "72b5c551a1e4d6e2a878068dfd3dc3eceac11ed32d56e0110d54dcc67fd83ba9";
    const patched = await on.run("patch", component, "--finding", finding, "--replay");
    expect(patched.code).toBe(EXIT.ok);

    const first = await on.run("assemble", component);
    const again = await on.run("assemble", component);

    expect(first.code).toBe(EXIT.ok);
    expect(first.output["patches"]).toEqual([
      { patchId: patched.output["patchId"], node: NODE, commit: patched.output["commit"], kind: patched.output["kind"], size: patched.output["size"] },
    ]);
    expect(first.output["paths"]).toEqual(["plugin.json"]);
    expect(again.output["tree"]).toBe(first.output["tree"]);
    expect(again.output["commit"]).toBe(first.output["commit"]);
    // The second run had nothing new to publish: the recipe is the same record.
    expect(again.output["recipe"]).toBe(first.output["recipe"]);
    expect(again.output["published"]).toEqual([]);
    expect(copied(on, component, "plugin.json")).toContain('"hosts": ["api.fellbeck-notes.example"]');
  });
});
