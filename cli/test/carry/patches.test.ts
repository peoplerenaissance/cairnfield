// `carry`: which of a team's own patches move to a newer commit of a component (R37,
// KTD39). A patch is a set of content replacements, so it carries when the newer commit
// still holds every content it replaces and every finding it cites carried. The commit
// is built again on the newer commit, and its patch ID stays the same (KTD4).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LISTING_ENTRIES, SCHEMA_VERSION, recordId } from "@cairnfield/protocol";
import { EXIT } from "../../src/outcome.ts";
import { NARROWED, RULES, bothRules, copied, ownPatch, pinnedWith, rules, text } from "../assemble/team.ts";
import { NODE, OUTBOX, bench, finding, git, holdRecords, patchIdOf } from "../support.ts";
import type { Bench } from "../support.ts";
import { carry, findingsSaid, patchCiting, patchRefs, patchesSaid, recordOf, recordsAt, release, releaseWithCopies, tree } from "./release.ts";

vi.setConfig({ testTimeout: 60_000 });

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const NOTES = "# Notes\n\nNothing here.\n";
const OTHER_NOTES = "# Notes\n\nSomething new.\n";
/** The notes with the third line rewritten: what a patch of the notes puts in their place. */
const KEPT_NOTES = "# Notes\n\nNothing to keep.\n";
/** The finding that `ownPatch` writes for one line of the rules file, as it is written for another commit. */
const ruleFinding = (component: string, line: number): object => finding(component, { location: { path: "config/rules.txt", start: line, end: line } });

/** A file of a commit, as a repo holds it. */
const fileAt = (repo: string, commit: string, path: string): string => `${git(repo, ["show", `${commit}:${path}`])}\n`;

describe("carry, for a patch", () => {
  it("re-creates a patch whose replaced content is unchanged, with the same patch ID, in a commit on the newer commit (AE16)", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    const [said, ...rest] = patchesSaid(outcome);
    expect(rest).toEqual([]);
    expect(said).toMatchObject({ patch: made.id, patchId: made.patchId, carried: true, reason: "content-unchanged", paths: ["config/rules.txt", "docs/rules.txt"] });
    const commit = said?.commit ?? "";
    const fork = on.repo(`fork-${newer}`);
    // The commit sits on the newer commit, on the ref of its patch ID, and is another commit than the older one.
    expect(patchRefs(on, newer)).toEqual([`refs/heads/patch/${newer}/${made.patchId} ${commit}`]);
    expect(git(fork, ["rev-list", "--parents", "-n", "1", commit])).toBe(`${commit} ${newer}`);
    expect(commit).not.toBe(made.commit);
    // The patch ID is worked out here again, from the two trees the fork holds.
    expect(await patchIdOf(fork, newer, commit)).toBe(made.patchId);
    expect(git(fork, ["diff", "--name-only", newer, commit])).toBe("config/rules.txt\ndocs/rules.txt");
    expect(fileAt(fork, commit, "config/rules.txt")).toBe(NARROWED);
    expect(fileAt(fork, commit, "notes.md")).toBe(OTHER_NOTES);

    // The patch record names the new commit and the finding as it was written for the newer commit.
    const cited = await recordId(ruleFinding(newer, 3));
    const record = { version: "1", type: "patch", component: newer, commit, findings: [cited], model: "none" };
    expect(said?.as).toBe(await recordId(record));
    expect(recordOf(on, newer, "patch", said?.as ?? "")).toEqual(record);
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${cited}.json`, `records/${newer}/patch/${said?.as}.json`]);
  });

  it("commits a carried patch with the fixed message, author and dates", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    const written = git(on.repo(`fork-${newer}`), ["log", "-1", "--format=%B|%an|%ae|%cn|%ce|%at|%ct", patchesSaid(outcome)[0]?.commit ?? ""]);
    const who = "Cairnfield command|command@cairnfield.example";
    expect(written).toBe(`Cairnfield patch\n|${who}|${who}|1760000000|1760000000`);
  });

  it("reports a patch whose replaced content changed as not carried, and writes no commit and no record for it (AE16)", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const reworded = rules({ 1: "allow read notes and drafts" });
    const newer = release(on, older, tree({ "config/rules.txt": reworded, "docs/rules.txt": reworded }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(patchesSaid(outcome)).toEqual([{ patch: made.id, patchId: made.patchId, carried: false, reason: "content-changed" }]);
    expect(existsSync(on.repo(`fork-${newer}`))).toBe(false);
    expect(recordsAt(on, newer)).toEqual([]);
    expect(existsSync(join(on.home, OUTBOX, "records", newer))).toBe(false);
  });

  it("reports a patch that cites one finding that carried and one that did not as not carried", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    // The patch changes the rules alone. Its second finding cites the notes, which the newer commit changes.
    const onNotes = finding(older, { location: { path: "notes.md", start: 3, end: 3 } });
    const made = await patchCiting(on, older, [ruleFinding(older, 3), onNotes], bothRules(NARROWED));
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    const carried = await recordId(ruleFinding(newer, 3));
    expect(outcome.code).toBe(EXIT.ok);
    expect(findingsSaid(outcome)).toEqual(
      [
        { finding: made.findings[0], carried: true, reason: "content-unchanged", as: carried, path: "config/rules.txt" },
        { finding: made.findings[1], carried: false, reason: "content-changed" },
      ].sort((a, b) => ((a.finding ?? "") < (b.finding ?? "") ? -1 : 1)),
    );
    expect(patchesSaid(outcome)).toEqual([{ patch: made.id, patchId: made.patchId, carried: false, reason: "finding-not-carried" }]);
    expect(existsSync(on.repo(`fork-${newer}`))).toBe(false);
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${carried}.json`]);
  });

  it("rewrites every copy the newer commit holds of a content the patch replaces, a third one included", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = release(on, older, tree({ "extra/rules.txt": text(RULES) }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    const [said] = patchesSaid(outcome);
    // The patch still changes both paths it changed, so one more copy does not make it a moved patch.
    const paths = ["config/rules.txt", "docs/rules.txt", "extra/rules.txt"];
    expect(said).toMatchObject({ patch: made.id, patchId: made.patchId, carried: true, reason: "content-unchanged", paths });
    const commit = said?.commit ?? "";
    const fork = on.repo(`fork-${newer}`);
    expect(git(fork, ["diff", "--name-only", newer, commit])).toBe(paths.join("\n"));
    for (const path of paths) expect(fileAt(fork, commit, path)).toBe(NARROWED);
    expect(await patchIdOf(fork, newer, commit)).toBe(made.patchId);
  });

  it("reports a carried patch whose replaced content sits at another path now as moved, with the path its commit changes there", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], path: "notes.md", changes: [{ path: "notes.md", content: KEPT_NOTES }] });
    // The newer commit puts other content at the path the patch changed, and holds the old content at another.
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES, "archive/notes.md": NOTES }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    const cited = await recordId(finding(older, { location: { path: "notes.md", start: 3, end: 3 } }));
    const citedAt = await recordId(finding(newer, { location: { path: "archive/notes.md", start: 3, end: 3 } }));
    expect(findingsSaid(outcome)).toEqual([{ finding: cited, carried: true, reason: "content-moved", as: citedAt, path: "archive/notes.md" }]);
    const [said, ...rest] = patchesSaid(outcome);
    expect(rest).toEqual([]);
    expect(said).toMatchObject({ patch: made.id, patchId: made.patchId, carried: true, reason: "content-moved", paths: ["archive/notes.md"] });
    const commit = said?.commit ?? "";
    const fork = on.repo(`fork-${newer}`);
    expect(git(fork, ["diff", "--name-only", newer, commit])).toBe("archive/notes.md");
    expect(fileAt(fork, commit, "archive/notes.md")).toBe(KEPT_NOTES);
    expect(fileAt(fork, commit, "notes.md")).toBe(OTHER_NOTES);
    expect(await patchIdOf(fork, newer, commit)).toBe(made.patchId);
    expect(recordOf(on, newer, "patch", said?.as ?? "")).toMatchObject({ commit, findings: [citedAt] });
  });

  it("cites a finding once in the carried patch record when two findings the patch cites carry to one record", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    // One content at two paths, with one finding at each. The newer commit holds the content at one path alone.
    const onDocs = finding(older, { location: { path: "docs/rules.txt", start: 3, end: 3 } });
    const made = await patchCiting(on, older, [ruleFinding(older, 3), onDocs], bothRules(NARROWED));
    const newer = release(on, older, tree({ "docs/rules.txt": undefined }));

    const outcome = await carry(on, older, newer);

    const cited = await recordId(ruleFinding(newer, 3));
    expect(outcome.code).toBe(EXIT.ok);
    expect(findingsSaid(outcome)).toEqual(
      [
        { finding: made.findings[0], carried: true, reason: "content-unchanged", as: cited, path: "config/rules.txt" },
        { finding: made.findings[1], carried: true, reason: "content-moved", as: cited, path: "config/rules.txt" },
      ].sort((a, b) => ((a.finding ?? "") < (b.finding ?? "") ? -1 : 1)),
    );
    const [said, ...rest] = patchesSaid(outcome);
    expect(rest).toEqual([]);
    // The patch no longer changes the path the newer commit took out.
    expect(said).toMatchObject({ patch: made.id, patchId: made.patchId, carried: true, reason: "content-moved", paths: ["config/rules.txt"] });
    expect(recordOf(on, newer, "patch", said?.as ?? "")).toMatchObject({ commit: said?.commit, findings: [cited] });
    // The one finding record and the patch record are published, each once.
    const records = [`records/${newer}/finding/${cited}.json`, `records/${newer}/patch/${said?.as}.json`];
    expect(outcome.output["published"]).toEqual(records);
    expect(recordsAt(on, newer)).toEqual(records);
  });

  it("runs the patch checks on the newer commit, and reports a patch they refuse there with the check's code", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    // The patch replaces the rules as a plain file. The newer commit also holds them as a
    // file that may be run, which the patch does not replace, so it would leave a copy as it was.
    const newer = release(on, older, [...tree({}), { path: "bin/rules.txt", content: text(RULES), mode: "100755" }]);

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(patchesSaid(outcome)).toEqual([{ patch: made.id, patchId: made.patchId, carried: false, reason: "refused", check: "patch-incomplete" }]);
    expect(existsSync(on.repo(`fork-${newer}`))).toBe(false);
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${await recordId(ruleFinding(newer, 3))}.json`]);
  });

  // A refusal is what the node answered or what the commit holds. No read failed, so the run goes on.
  it("reports a patch whose fork the node does not have as refused, with the node's answer as the check's code", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    // The record names a commit, and the team has no fork of the older commit to hold one.
    const [cited = ""] = await holdRecords(on, [ruleFinding(older, 3)]);
    const [id = ""] = await holdRecords(on, [{ version: SCHEMA_VERSION, type: "patch", component: older, commit: "2e".repeat(20), findings: [cited], model: "none" }]);
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(patchesSaid(outcome)).toEqual([{ patch: id, carried: false, reason: "refused", check: "node-refused" }]);
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${await recordId(ruleFinding(newer, 3))}.json`]);
  });

  it("reports a patch whose commit puts a file in place that is larger than a node may serve as refused, with the limit's code", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(rules({ 3: `allow fetch ${"notes.".repeat(50_000)}fellbeck.example` })) });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    // A file's size is read before its content, so the patch is refused before its patch ID is known.
    expect(patchesSaid(outcome)).toEqual([{ patch: made.id, carried: false, reason: "refused", check: "too-large" }]);
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${await recordId(ruleFinding(newer, 3))}.json`]);
  });

  // A node lists at most this many paths for a patch commit, so a patch that changes more is one no index can check and no assembly takes.
  it("reports a patch that would change one path more than a node may list as refused, and builds no commit and no record for it", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    // The rules sit at two paths. With these copies the newer commit holds them at one path more than the limit.
    const newer = releaseWithCopies(on, older, "config/rules.txt", MAX_LISTING_ENTRIES - 1);

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(patchesSaid(outcome)).toEqual([{ patch: made.id, patchId: made.patchId, carried: false, reason: "refused", check: "patch-too-large" }]);
    // The fork of the newer commit is made for the first patch that carries, so it holds no ref: there is none.
    expect(existsSync(on.repo(`fork-${newer}`))).toBe(false);
    // The finding the patch cites still carries, and its record is the one record written.
    expect(findingsSaid(outcome)).toMatchObject([{ carried: true, reason: "content-unchanged", path: "config/rules.txt" }]);
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${await recordId(ruleFinding(newer, 3))}.json`]);
    expect(existsSync(join(on.home, OUTBOX, "records", newer, "finding"))).toBe(true);
    expect(existsSync(join(on.home, OUTBOX, "records", newer, "patch"))).toBe(false);
  });

  it("carries a patch that changes as many paths as a node may list", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = releaseWithCopies(on, older, "config/rules.txt", MAX_LISTING_ENTRIES - 2);

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    const [said, ...rest] = patchesSaid(outcome);
    expect(rest).toEqual([]);
    expect(said).toMatchObject({ patch: made.id, patchId: made.patchId, carried: true, reason: "content-unchanged" });
    expect(said?.paths).toHaveLength(MAX_LISTING_ENTRIES);
    expect(patchRefs(on, newer)).toEqual([`refs/heads/patch/${newer}/${made.patchId} ${said?.commit}`]);
  });

  it("carries every patch whose content is unchanged to a commit that adds one file and changes another, and counts one added and one changed path", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const onRules = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const onScript = await ownPatch(on, older, { cites: [[2, 2]], path: "run.sh", changes: [{ path: "run.sh", content: "#!/bin/sh\nexec sync --once\n" }] });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES, "extra.md": "# Extra\n" }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(patchesSaid(outcome).map(({ patch, patchId, carried }) => ({ patch, patchId, carried }))).toEqual(
      [onRules, onScript].map(({ id, patchId }) => ({ patch: id, patchId, carried: true })).sort((a, b) => (a.patch < b.patch ? -1 : 1)),
    );
    expect(patchRefs(on, newer).map((ref) => ref.split(" ")[0])).toEqual(
      [onRules.patchId, onScript.patchId].sort().map((patchId) => `refs/heads/patch/${newer}/${patchId}`),
    );
    expect(outcome.output["paths"]).toEqual({ added: 1, changed: 1, removed: 0 });
  });

  it("leaves `assemble` at level 1 a copy of the newer commit to build from the carried patches", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    const carried = await carry(on, older, newer);

    const outcome = await on.run("assemble", newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["patches"]).toEqual([
      { patchId: made.patchId, node: NODE, commit: patchesSaid(carried)[0]?.commit, kind: "adds-or-changes", size: 2 },
    ]);
    expect(outcome.output["refused"]).toEqual([]);
    expect(copied(on, newer, "config/rules.txt")).toBe(NARROWED);
    expect(copied(on, newer, "docs/rules.txt")).toBe(NARROWED);
    expect(copied(on, newer, "notes.md")).toBe(OTHER_NOTES);
  });
});
