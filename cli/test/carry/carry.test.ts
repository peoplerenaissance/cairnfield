// `carry`: a team moves its own findings and patches to a newer commit of a component
// (R37, KTD39). It pins the newer commit, carries nothing of another team, names what the
// newer copy lost, and a second run changes nothing.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, TEAM_BRANCH, recordId } from "@cairnfield/protocol";
import { EXIT } from "../../src/outcome.ts";
import { NARROWED, bothRules, otherTeam, ownPatch, patchBy, pinnedWith, refsOf, rules, serveView } from "../assemble/team.ts";
import type { Lens, Made } from "../assemble/team.ts";
import {
  INDEX,
  NODE,
  OTHER_NODE,
  OTHER_PLUGIN_URL,
  OUTBOX,
  PLUGIN_URL,
  TOKEN,
  bench,
  commitEntries,
  finding,
  git,
  holdRecords,
  published,
  putFile,
  putRecord,
  remoteOf,
} from "../support.ts";
import type { Bench } from "../support.ts";
import { carry, findingsSaid, onPatchRef, patchRefs, patchesSaid, recordsAt, release, tree } from "./release.ts";

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

  it("counts a patch of its own that was refused before its patch ID was known as its own, and names only another team's patch as left behind", async () => {
    const older = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
    const other = otherTeam(on);
    // The team's patch cites a finding that only the other team's repo holds. Assembly counts
    // that team's records at level 2, and `carry` counts the team's own repo alone.
    const mine = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED), findingsAt: other });
    onPatchRef(on, older, mine);
    const theirs = await patchBy(on, other, OTHER_NODE, older, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    serveView(on, older, [theirs]);
    const built = await on.run("assemble", older);
    expect((built.output["patches"] as { readonly patchId: string }[]).map(({ patchId }) => patchId)).toEqual([mine.patchId, theirs.patchId].sort());
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    // The patch was refused before its patch ID was known, so its entry holds none.
    expect(patchesSaid(outcome)).toEqual([{ patch: mine.id, carried: false, reason: "refused", check: "unresolved-reference" }]);
    expect(outcome.output["leftBehind"]).toEqual([theirs.patchId]);
  });

  it("asks the fork of the older commit for no ref when it read every patch of the copy as its own", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const mine = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const built = await on.run("assemble", older);
    expect((built.output["patches"] as { readonly patchId: string }[]).map(({ patchId }) => patchId)).toEqual([mine.patchId]);
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    const requests = on.requests.length;
    const gitCalls = on.gitCalls.length;

    const outcome = await carry(on, older, newer);

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { leftBehind: [] } });
    expect(patchesSaid(outcome)).toMatchObject([{ patch: mine.id, patchId: mine.patchId, carried: true }]);
    // One read token for the fork of the older commit: the one the patch's commit is fetched with.
    expect(on.requests.slice(requests).filter((seen) => seen.url === `${NODE}/read-token?component=${older}`)).toHaveLength(1);
    // The one remote whose refs are listed is the team repo, by `publish`.
    const listed = on.gitCalls.slice(gitCalls).filter(([command]) => command === "ls-remote");
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((args) => !args.includes(remoteOf("team")))).toEqual([]);
  });

  it("takes a ref of its fork as a patch of its own only when it is the ref of a patch at the older commit", async () => {
    const older = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
    const mine = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const other = otherTeam(on);
    const theirs = await patchBy(on, other, OTHER_NODE, older, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    serveView(on, older, [theirs]);
    expect((await on.run("assemble", older)).code).toBe(EXIT.ok);
    // Refs of the team's own fork that name the other team's patch ID. None is the ref of a patch at the older commit.
    for (const ref of [
      // Where assembly pushes a copy the team publishes.
      `refs/heads/copy/${older}`,
      // A patch at another commit.
      `refs/heads/patch/${"2e".repeat(20)}/${theirs.patchId}`,
      // A name that only ends as a patch ref does. Git matches a pattern against the end of a name.
      `refs/heads/kept/refs/heads/patch/${older}/${theirs.patchId}`,
      // A name that only starts as one.
      `refs/heads/patch/${older}/${theirs.patchId}/more`,
    ]) {
      git(on.repo(`fork-${older}`), ["update-ref", ref, mine.commit]);
    }
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(patchesSaid(outcome)).toMatchObject([{ patch: mine.id, patchId: mine.patchId, carried: true }]);
    expect(outcome.output["leftBehind"]).toEqual([theirs.patchId]);
  });

  describe("with a copy that holds another team's patch and no patch of the team's own", () => {
    let older: string;
    let newer: string;
    let theirs: Made;
    beforeEach(async () => {
      older = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
      theirs = await patchBy(on, otherTeam(on), OTHER_NODE, older, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
      serveView(on, older, [theirs]);
      const built = await on.run("assemble", older);
      expect((built.output["patches"] as { readonly patchId: string }[]).map(({ patchId }) => patchId)).toEqual([theirs.patchId]);
      newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    });

    it("names that patch as left behind when the team has no fork of the older commit", async () => {
      // A team that pushed no patch at the older commit has no fork of it.
      expect(existsSync(on.repo(`fork-${older}`))).toBe(false);

      const outcome = await carry(on, older, newer);

      expect(outcome).toMatchObject({ code: EXIT.ok, output: { patches: [], leftBehind: [theirs.patchId] } });
      expect(on.gitCalls.some(([command]) => command === "ls-remote")).toBe(false);
    });

    it("stops with the node's failure when the node gives no access to the fork of the older commit, names no patch as left behind, and publishes what carried on the next run", async () => {
      // A finding of the team's own, which carries.
      await holdRecords(on, [finding(older, { location: { path: "config/rules.txt", start: 3, end: 3 } })]);
      const record = `records/${newer}/finding/${await recordId(finding(newer, { location: { path: "config/rules.txt", start: 3, end: 3 } }))}.json`;
      on.respond = (seen) => {
        if (seen.url === `${NODE}/read-token?component=${older}`) throw new TypeError("fetch failed");
        return undefined;
      };

      expect(await carry(on, older, newer)).toEqual({ code: EXIT.node, output: { error: "node-unreachable" } });
      // The fork is asked before anything is published, so the carried record waits in the outbox.
      expect(recordsAt(on, newer)).toEqual([]);
      expect(waiting()).toEqual([record]);

      on.respond = undefined;
      expect(await carry(on, older, newer)).toMatchObject({ code: EXIT.ok, output: { published: [record], leftBehind: [theirs.patchId] } });
    });

    it("stops with Git's failure when the fork of the older commit does not list its refs, and names no patch as left behind", async () => {
      // The node names a fork that Git cannot read.
      on.createRepo(`fork-${older}`);
      on.node.remote = (repo) => remoteOf(repo === `fork-${older}` ? "gone" : repo);

      expect(await carry(on, older, newer)).toEqual({ code: EXIT.git, output: { error: "git-failed", step: "ls-remote" } });
    });
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

  // A read of the team's own node that fails says nothing of the patch. It ends the command
  // with the failure's own outcome, and is never an entry: a caller that reads only the
  // exit code must not go on to build a copy without the patch. A fetch from the team's own
  // fork that fails is still an entry today, `refused` with `git-failed`: Git gives one
  // failure for a fetch that failed and for a commit the fork does not hold.
  describe("when a read fails as a patch of the team's own is checked", () => {
    let older: string;
    let newer: string;
    let mine: Made;
    /** The record the patch's finding becomes at the newer commit, by its path. It carries before any patch is read. */
    let cited: string;
    beforeEach(async () => {
      older = await pinnedWith(on, { patchLevel: 1 });
      mine = await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
      newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
      cited = `records/${newer}/finding/${await recordId(finding(newer, { location: { path: "config/rules.txt", start: 3, end: 3 } }))}.json`;
    });

    /** The run stopped before it built a patch: the carried finding waits in the outbox, and nothing is published or pushed. */
    function stoppedBeforeThePatch(): void {
      expect(recordsAt(on, newer)).toEqual([]);
      expect(waiting()).toEqual([cited]);
      expect(existsSync(on.repo(`fork-${newer}`))).toBe(false);
    }

    it("stops with the node's failure when the node cannot be reached for a patch record, gives no entry for the patch, and carries it on the next run", async () => {
      const record = `records/${older}/patch/${mine.id}.json`;
      on.respond = (seen) => {
        const { origin, pathname, searchParams } = new URL(seen.url);
        if (origin === NODE && pathname === "/file" && searchParams.get("path") === record) throw new TypeError("fetch failed");
        return undefined;
      };

      // The output is the failure alone. It lists no finding and no patch.
      expect(await carry(on, older, newer)).toEqual({ code: EXIT.node, output: { error: "node-unreachable" } });
      stoppedBeforeThePatch();

      on.respond = undefined;
      const again = await carry(on, older, newer);

      expect(again.code).toBe(EXIT.ok);
      expect(patchesSaid(again)).toMatchObject([{ patch: mine.id, patchId: mine.patchId, carried: true, reason: "content-unchanged" }]);
      expect(again.output["published"]).toEqual([cited, `records/${newer}/patch/${patchesSaid(again)[0]?.as}.json`]);
    });

    it("reports the patch as refused with Git's code when the fetch of its commit from the team's fork fails, and publishes what carried", async () => {
      // The node names a fork that Git cannot read.
      on.node.remote = (repo) => remoteOf(repo === `fork-${older}` ? "gone" : repo);

      const outcome = await carry(on, older, newer);

      expect(outcome).toMatchObject({ code: EXIT.ok, output: { published: [cited] } });
      // The fetch failed before the commit was read, so the entry holds no patch ID.
      expect(patchesSaid(outcome)).toEqual([{ patch: mine.id, carried: false, reason: "refused", check: "git-failed" }]);
    });

    it("reports a patch record that names a commit the fork does not hold as refused with Git's code on every run, and carries and publishes the team's other patch", async () => {
      // A record a person wrote by hand. The fork of the older commit is there, and holds no such commit.
      const [onLastRule = ""] = await holdRecords(on, [finding(older, { location: { path: "config/rules.txt", start: 5, end: 5 } })]);
      const [unheld = ""] = await holdRecords(on, [{ version: SCHEMA_VERSION, type: "patch", component: older, commit: "2e".repeat(20), findings: [onLastRule], model: "none" }]);

      const first = await carry(on, older, newer);

      expect(first.code).toBe(EXIT.ok);
      const said = new Map(patchesSaid(first).map((entry) => [entry.patch, entry]));
      expect([...said.keys()].sort()).toEqual([mine.id, unheld].sort());
      expect(said.get(unheld)).toEqual({ patch: unheld, carried: false, reason: "refused", check: "git-failed" });
      const carried = said.get(mine.id);
      expect(carried).toMatchObject({ patchId: mine.patchId, carried: true, reason: "content-unchanged" });
      const record = `records/${newer}/patch/${carried?.as}.json`;
      expect(first.output["published"]).toContain(record);
      expect(recordsAt(on, newer)).toContain(record);
      expect(patchRefs(on, newer)).toEqual([`refs/heads/patch/${newer}/${mine.patchId} ${carried?.commit}`]);

      const second = await carry(on, older, newer);

      expect(second.code).toBe(EXIT.ok);
      expect(patchesSaid(second)).toEqual(patchesSaid(first));
      expect(second.output["published"]).toEqual([]);
    });

    it.each([
      // A fork the node does not have is the one answer that refuses the patch. See the patch tests.
      ["refuses access to it for another reason than that it has none", () => Response.json({ error: "not-ready" }, { status: 409 }), { error: "node-refused", reason: "not-ready" }],
      [
        "cannot be reached for it",
        () => {
          throw new TypeError("fetch failed");
        },
        { error: "node-unreachable" },
      ],
      [
        "names a remote for it that is no Artifacts remote",
        () => Response.json({ remote: "https://git.elsewhere.example/git/cairnfield-team-a/fork.git", token: TOKEN, expires: 1_900_000_000 }),
        { error: "node-bad-answer" },
      ],
    ])("stops with the node's failure when the node is asked for the fork of the older commit and %s", async (_why, answer, output) => {
      on.respond = (seen) => (seen.url === `${NODE}/read-token?component=${older}` ? answer() : undefined);

      expect(await carry(on, older, newer)).toEqual({ code: EXIT.node, output });
      stoppedBeforeThePatch();
    });
  });

  // `pin` ends the command when it fails, so `carry` ends there with the outcome of `pin`.
  describe("when the newer commit cannot be pinned", () => {
    const checkout = (commit: string): string => join(on.home, ".cairnfield/checkouts", commit);

    /** The older commit with a finding and a patch of the team's own. Both carry to a newer commit that keeps the rules. */
    async function olderWithPatch(lens: Lens): Promise<{ readonly older: string; readonly before: readonly string[] }> {
      const older = await pinnedWith(on, lens);
      await ownPatch(on, older, { cites: [[3, 3]], changes: bothRules(NARROWED) });
      return { older, before: published(on) };
    }

    /** The run wrote nothing for the newer commit: no record in the team repo or the outbox, and no fork to hold a patch. */
    function wroteNothing(newer: string, before: readonly string[]): void {
      expect(recordsAt(on, newer)).toEqual([]);
      expect(published(on)).toEqual(before);
      expect(existsSync(join(on.home, OUTBOX, "records", newer))).toBe(false);
      expect(existsSync(on.repo(`fork-${newer}`))).toBe(false);
    }

    /** Has one address fail as a network does. */
    const unreachable = (url: string) => (): void => {
      on.respond = (seen) => {
        if (seen.url === url) throw new TypeError("fetch failed");
        return undefined;
      };
    };

    it("stops with the outcome of `pin` when the node's copy does not hold the newer commit, and makes no checkout, record or fork for it", async () => {
      const { older, before } = await olderWithPatch({ patchLevel: 1 });
      // A commit the source holds and the node's copy does not.
      const newer = commitEntries(on.repo("source"), tree({ "notes.md": OTHER_NOTES }), older);
      on.node.importRefusal = "not-found";

      // The code is the one `pin` gives, and not `bad-checkout`, which says a checkout here cannot be read.
      expect(await carry(on, older, newer)).toEqual({ code: EXIT.notHeld, output: { error: "not-held", component: newer } });
      expect(existsSync(checkout(newer))).toBe(false);
      expect(existsSync(`${checkout(newer)}.json`)).toBe(false);
      wroteNothing(newer, before);
    });

    it("stops with the refusal of `pin` when the newer commit is already pinned here from another Git URL, before any call, and carries nothing to it", async () => {
      const { older, before } = await olderWithPatch({ patchLevel: 1 });
      const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
      // The same commit under another name. Its checkout is here and reads well, so only the refusal of `pin` stops the command.
      expect(await on.run("pin", OTHER_PLUGIN_URL, "--branch", TEAM_BRANCH, "--commit", newer)).toMatchObject({ code: EXIT.ok });
      const requests = on.requests.length;

      expect(await carry(on, older, newer)).toEqual({
        code: EXIT.invalid,
        output: { error: "pinned-from-another-url", component: newer, url: OTHER_PLUGIN_URL },
      });
      expect(on.requests).toHaveLength(requests);
      wroteNothing(newer, before);
    });

    it.each([
      ["the node cannot be reached", { code: EXIT.node, output: { error: "node-unreachable" } }, unreachable(`${NODE}/admin/import`)],
      [
        "the node refuses the import",
        { code: EXIT.node, output: { error: "node-refused", reason: "refused" } },
        (): void => {
          on.node.importRefusal = "refused";
        },
      ],
      ["the index cannot be reached", { code: EXIT.index, output: { error: "index-unreachable" } }, unreachable(`${INDEX}/components`)],
    ])("stops with the failure of the call when %s as it pins the newer commit, and carries nothing to the checkout it has", async (_why, failure, fail) => {
      // The team shares through an index, so `pin` registers the commit there after the node imports it.
      const { older, before } = await olderWithPatch({ patchLevel: 2, teams: [OTHER_NODE] });
      const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
      // The team pinned the newer commit before. Its checkout is here, so only the failed call stops the command.
      expect(await on.run("pin", PLUGIN_URL, "--branch", TEAM_BRANCH, "--commit", newer)).toMatchObject({ code: EXIT.ok });
      fail();

      expect(await carry(on, older, newer)).toEqual(failure);
      wroteNothing(newer, before);
    });
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
