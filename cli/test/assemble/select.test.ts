// `assemble`: which patches a team's lens lets into its copy (R23, KTD38, KTD40). Level 0
// takes none, level 1 the team's own, and level 2 also those of the teams the lens names.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../../src/outcome.ts";
import { INDEX, NODE, OTHER_NODE, bench, published, remoteOf } from "../support.ts";
import type { Bench } from "../support.ts";
import {
  COPIES,
  OTHER_NAMESPACE,
  THIRD_NAMESPACE,
  THIRD_NODE,
  bothRules,
  copied,
  otherTeam,
  ownPatch,
  patchBy,
  pinnedWith,
  refsOf,
  rules,
  serveView,
  useLens,
} from "./team.ts";

vi.setConfig({ testTimeout: 30_000 });

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const NARROWED = rules({ 3: "allow fetch notes.fellbeck.example" });
const hostsAsked = (): string[] => [...new Set(on.requests.map((seen) => new URL(seen.url).origin))];

describe("assemble at level 0", () => {
  it("selects no patch, builds no copy and produces no recipe", async () => {
    const component = await pinnedWith(on, { patchLevel: 0, publishRecipes: true });
    await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const before = published(on);

    const outcome = await on.run("assemble", component);

    expect(outcome).toEqual({ code: EXIT.ok, output: { component, level: 0, patches: [], refused: [], skipped: [] } });
    expect(published(on)).toEqual(before);
    expect(refsOf(on.repo(`fork-${component}`)).some((ref) => ref.includes("refs/heads/copy/"))).toBe(false);
    expect(existsSync(join(on.home, COPIES, component))).toBe(false);
  });
});

describe("assemble at level 1", () => {
  it("selects the patches whose record is in the team's own repo, and needs no index", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });
    const own = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    // Another team holds a patch too. Nothing asks it.
    await patchBy(on, otherTeam(on), OTHER_NODE, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });

    const outcome = await on.run("assemble", component);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["patches"]).toEqual([{ patchId: own.patchId, node: NODE, commit: own.commit, kind: "adds-or-changes", size: 2 }]);
    expect(copied(on, component, "config/rules.txt")).toBe(NARROWED);
    expect(hostsAsked()).toEqual([NODE]);
  });

  it("builds no copy for a team with no patch of its own", async () => {
    const component = await pinnedWith(on, { patchLevel: 1 });

    expect(await on.run("assemble", component)).toEqual({ code: EXIT.ok, output: { component, level: 1, patches: [], refused: [], skipped: [] } });
  });

  it("skips a patch of a kind the lens does not accept", async () => {
    const component = await pinnedWith(on, { patchLevel: 1, patchKinds: ["removes-only"] });
    const changes = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const removes = await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });

    const outcome = await on.run("assemble", component);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["patches"]).toEqual([{ patchId: removes.patchId, node: NODE, commit: removes.commit, kind: "removes-only", size: 1 }]);
    expect(outcome.output["skipped"]).toEqual([{ patchId: changes.patchId, node: NODE, commit: changes.commit, kind: "adds-or-changes" }]);
    expect(copied(on, component, "config/rules.txt")).toBe(rules({ 5: undefined }));
  });
});

describe("assemble at level 2", () => {
  it("fails with its own exit code when the config names no index", async () => {
    const component = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
    useLens(on, { patchLevel: 2, teams: [OTHER_NODE] }, false);

    expect(await on.run("assemble", component)).toEqual({ code: EXIT.noIndex, output: { error: "no-index" } });
  });

  it("selects a patch of a named team after its commit is fetched from that team's node and checked again", async () => {
    const component = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
    const theirs = await patchBy(on, otherTeam(on), OTHER_NODE, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    serveView(on, component, [theirs]);

    const outcome = await on.run("assemble", component);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["patches"]).toEqual([{ patchId: theirs.patchId, node: OTHER_NODE, commit: theirs.commit, kind: "adds-or-changes", size: 2 }]);
    expect(copied(on, component, "docs/rules.txt")).toBe(NARROWED);
    // The commit came from the fork of the team that wrote it, by its hash.
    const fork = remoteOf(`fork-${component}`, OTHER_NAMESPACE);
    expect(on.gitCalls.some((args) => args[0] === "fetch" && args.includes(fork) && args.includes(theirs.commit))).toBe(true);
    expect(hostsAsked().sort()).toEqual([INDEX, NODE, OTHER_NODE].sort());
  });

  it("does not select a valid patch of a node the lens does not name, and asks that node nothing (AE15)", async () => {
    const component = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
    const named = await patchBy(on, otherTeam(on), OTHER_NODE, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const unnamed = await patchBy(on, on.another(THIRD_NODE, THIRD_NAMESPACE), THIRD_NODE, component, {
      cites: [[5, 5]],
      changes: bothRules(rules({ 5: undefined })),
    });
    serveView(on, component, [named, unnamed]);

    const outcome = await on.run("assemble", component);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["patches"]).toEqual([{ patchId: named.patchId, node: OTHER_NODE, commit: named.commit, kind: "adds-or-changes", size: 2 }]);
    expect(outcome.output["refused"]).toEqual([]);
    expect(copied(on, component, "config/rules.txt")).toBe(NARROWED);
    expect(hostsAsked()).not.toContain(THIRD_NODE);
  });

  it("takes the team's own patches from its own repo, and one patch that two teams wrote once", async () => {
    const component = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
    const own = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const same = await patchBy(on, otherTeam(on), OTHER_NODE, component, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    serveView(on, component, [same]);

    const outcome = await on.run("assemble", component);

    expect(same.patchId).toBe(own.patchId);
    expect(outcome.output["patches"]).toEqual([{ patchId: own.patchId, node: NODE, commit: own.commit, kind: "adds-or-changes", size: 2 }]);
    expect(outcome.output["refused"]).toEqual([]);
  });
});
