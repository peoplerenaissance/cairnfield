// `carry`: a team moves its own findings and patches to a newer commit of a component
// (R37, KTD39). It pins the newer commit, carries nothing of another team, names what the
// newer copy lost, and a second run changes nothing.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEAM_BRANCH, recordId } from "@cairnfield/protocol";
import { EXIT } from "../../src/outcome.ts";
import { NARROWED, bothRules, otherTeam, ownPatch, patchBy, pinnedWith, refsOf, rules, serveView } from "../assemble/team.ts";
import { NODE, OTHER_NODE, OUTBOX, PLUGIN_URL, bench, finding, git, holdRecords, published, putFile, putRecord } from "../support.ts";
import type { Bench } from "../support.ts";
import { carry, findingsSaid, patchRefs, patchesSaid, recordsAt, release, tree } from "./release.ts";

vi.setConfig({ testTimeout: 60_000 });

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const OTHER_NOTES = "# Notes\n\nSomething new.\n";

/** Every file under the outbox, by its path there. */
const waiting = (): string[] => readdirSync(join(on.home, OUTBOX), { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".json")).sort();

describe("carry", () => {
  it("pins the newer commit from the Git URL of the older one and the branch it is given", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    const requests = on.requests.length;

    const outcome = await carry(on, older, newer);

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { older, newer, findings: [], patches: [], leftBehind: [], paths: { added: 0, changed: 1, removed: 0 } } });
    const imports = on.requests.slice(requests).filter((seen) => seen.url.endsWith("/admin/import"));
    expect(imports.map((seen) => seen.body)).toEqual([{ url: PLUGIN_URL, branch: TEAM_BRANCH, commit: newer }]);
    expect(existsSync(join(on.home, ".cairnfield/checkouts", newer, "notes.md"))).toBe(true);
  });

  it("never carries a finding or a patch of another team, and names another team's patch in the copy last built at the older commit", async () => {
    const older = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
    const mine = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const other = otherTeam(on);
    const theirs = await patchBy(on, other, OTHER_NODE, older, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    serveView(on, older, [theirs]);
    const built = await on.run("assemble", older);
    expect((built.output["patches"] as { readonly patchId: string }[]).map(({ patchId }) => patchId)).toEqual([mine.patchId, theirs.patchId].sort());
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    const theirRecords = git(other.repo("team"), ["ls-tree", "-r", "--name-only", TEAM_BRANCH]);

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    // The team shares through an index, so pinning the newer commit registered it there.
    expect(on.index.components).toContainEqual({ url: PLUGIN_URL, branch: TEAM_BRANCH, commit: newer });
    expect(outcome.output["leftBehind"]).toEqual([theirs.patchId]);
    // One finding and one patch: the team's own. The other team's finding cites line 5.
    const own = await recordId(finding(newer, { location: { path: "config/rules.txt", start: 3, end: 3 } }));
    expect(findingsSaid(outcome).map(({ as }) => as)).toEqual([own]);
    expect(patchesSaid(outcome)).toMatchObject([{ patch: mine.id, patchId: mine.patchId, carried: true }]);
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${own}.json`, `records/${newer}/patch/${patchesSaid(outcome)[0]?.as}.json`]);
    expect(patchRefs(on, newer)).toEqual([`refs/heads/patch/${newer}/${mine.patchId} ${patchesSaid(outcome)[0]?.commit}`]);
    // Nothing was written to the other team's node.
    expect(git(other.repo("team"), ["ls-tree", "-r", "--name-only", TEAM_BRANCH])).toBe(theirRecords);
    expect(existsSync(other.repo(`fork-${newer}`))).toBe(false);
  });

  it("writes nothing new when it runs a second time", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    const first = await carry(on, older, newer);
    expect(first.output["published"]).toHaveLength(2);
    const team = on.repo("team");
    const before = { records: published(on), head: git(team, ["rev-parse", TEAM_BRANCH]), refs: refsOf(on.repo(`fork-${newer}`)), waiting: waiting() };

    const second = await carry(on, older, newer);

    expect(second.code).toBe(EXIT.ok);
    expect(second.output["published"]).toEqual([]);
    expect(findingsSaid(second)).toEqual(findingsSaid(first));
    expect(patchesSaid(second)).toEqual(patchesSaid(first));
    expect({ records: published(on), head: git(team, ["rev-parse", TEAM_BRANCH]), refs: refsOf(on.repo(`fork-${newer}`)), waiting: waiting() }).toEqual(before);
  });

  it("publishes its own records and leaves what else waits in the outbox where it is", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    // A finding a person wrote for the older commit and has not published yet.
    const unpublished = finding(older, { location: { path: "notes.md", start: 1, end: 1 } });
    const path = `records/${older}/finding/${await recordId(unpublished)}.json`;
    putFile(on, path, JSON.stringify(unpublished));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["published"]).toEqual(recordsAt(on, newer));
    expect(published(on)).not.toContain(path);
    expect(waiting()).toContain(path);
  });

  it("publishes nothing when nothing carried, and leaves a record that waits in the outbox where it is", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    // The team's one finding cites the notes, which the newer commit changes.
    const [id = ""] = await holdRecords(on, [finding(older, { location: { path: "notes.md", start: 3, end: 3 } })]);
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    // A finding a person wrote for the older commit and has not published yet. A published record cannot be taken back (KTD1).
    const path = await putRecord(on, finding(older, { location: { path: "notes.md", start: 1, end: 1 } }));
    const before = published(on);

    const outcome = await carry(on, older, newer);

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { published: [] } });
    expect(findingsSaid(outcome)).toEqual([{ finding: id, carried: false, reason: "content-changed" }]);
    expect(published(on)).toEqual(before);
    expect(waiting()).toEqual([path]);
  });

  it("still says what carried when publishing stops, keeps the carried records in the outbox, and publishes them on the next run", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const mine = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    // Only `publish` asks the node for the team repo, so the run stops there, with the patch commit in the fork.
    on.respond = (seen) => {
      if (seen.url === `${NODE}/admin/team-repo`) throw new TypeError("fetch failed");
      return undefined;
    };

    const stopped = await carry(on, older, newer);

    // The exit code and the error are those of `publish`.
    expect(stopped).toMatchObject({ code: EXIT.node, output: { older, newer, error: "node-unreachable", leftBehind: [], paths: { added: 0, changed: 1, removed: 0 } } });
    const own = await recordId(finding(newer, { location: { path: "config/rules.txt", start: 3, end: 3 } }));
    expect(findingsSaid(stopped)).toMatchObject([{ carried: true, as: own }]);
    expect(patchesSaid(stopped)).toMatchObject([{ patch: mine.id, patchId: mine.patchId, carried: true }]);
    const records = [`records/${newer}/finding/${own}.json`, `records/${newer}/patch/${patchesSaid(stopped)[0]?.as}.json`];
    expect(recordsAt(on, newer)).toEqual([]);
    expect(waiting()).toEqual(records);

    on.respond = undefined;
    const again = await carry(on, older, newer);

    expect(again).toMatchObject({ code: EXIT.ok, output: { published: records } });
    expect(findingsSaid(again)).toEqual(findingsSaid(stopped));
    expect(patchesSaid(again)).toEqual(patchesSaid(stopped));
    expect(recordsAt(on, newer)).toEqual(records);
  });

  it("stops with the node's failure when the node does not list the team's records, and writes no record and no commit", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    const before = published(on);
    // A team repo that is not there yet leaves nothing to carry. Any other answer is the node's failure.
    on.respond = (seen) => (seen.url === `${NODE}/records` ? Response.json({ error: "not-ready" }, { status: 409 }) : undefined);

    expect(await carry(on, older, newer)).toEqual({ code: EXIT.node, output: { error: "node-refused", reason: "not-ready" } });
    expect(published(on)).toEqual(before);
    expect(existsSync(on.repo(`fork-${newer}`))).toBe(false);
    expect(existsSync(join(on.home, OUTBOX, "records", newer))).toBe(false);
  });

  it("refuses an older commit that is not pinned here, before any call", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    const elsewhere = "2e".repeat(20);
    const requests = on.requests.length;

    expect(await carry(on, elsewhere, newer)).toEqual({ code: EXIT.invalid, output: { error: "unknown-component", component: elsewhere } });
    expect(on.requests).toHaveLength(requests);
  });

  it.each([
    ["no branch", (older: string, newer: string) => [older, newer]],
    ["one commit", (older: string) => [older, "--branch", TEAM_BRANCH]],
    ["a commit that is no full hash", (older: string, newer: string) => [older, newer.slice(0, 12), "--branch", TEAM_BRANCH]],
    ["the same commit twice", (older: string) => [older, older, "--branch", TEAM_BRANCH]],
  ])("refuses %s", async (_why, argv) => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    expect(await on.run("carry", ...argv(older, newer))).toEqual({ code: EXIT.usage, output: { error: "usage" } });
  });
});
