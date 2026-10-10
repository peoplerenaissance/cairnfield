// `verify`: an installed copy is held to the team's approved entry by its file-tree hash
// (R36). It reads the approvals file it is given and the folder, and nothing else.

import { appendFileSync, chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEAM_BRANCH } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import type { Outcome } from "../src/outcome.ts";
import { run } from "../src/run.ts";
import { FIXTURES, NODE, bench, git, pinned, saveOutbox } from "./support.ts";
import type { Bench, Entry } from "./support.ts";
import { COPIES, TREE, bothRules, ownPatch, pinnedWith, rules } from "./assemble/team.ts";

vi.setConfig({ testTimeout: 60_000 });

/** The Git URL the bench pins its small component from. */
const PLUGIN = "https://git.fellbeck-tools.example/plugin.git";

let on: Bench;
/** A second machine: a folder with no config file, where an engineer checks a copy. */
let elsewhere: string;
beforeEach(() => {
  on = bench();
  elsewhere = join(on.home, "..", "second-machine");
  mkdirSync(elsewhere);
});
afterEach(() => {
  on.dispose();
});

/** Clones one branch of a repo into the second machine, as an engineer who installs a copy does. Returns the folder. */
function clone(repo: string, branch: string, name: string): string {
  git(elsewhere, ["clone", "--quiet", "--branch", branch, repo, name]);
  return join(elsewhere, name);
}

/** Runs `verify` on the second machine. */
const verify = (...argv: string[]): Promise<Outcome> => run({ ...on.io, cwd: elsewhere }, ["verify", ...argv]);

interface Approved {
  readonly component: string;
  readonly tree: string;
  /** A clone of the copy the team published. */
  readonly copy: string;
}

/**
 * A team patches the small component, builds and publishes its copy and approves it. The
 * second machine gets the team's decisions file and a clone of the published copy.
 */
async function approvedCopy(tree: readonly Entry[] = TREE, verdict = "approved-with-required-mitigations"): Promise<Approved> {
  const component = await pinnedWith(on, { patchLevel: 1, publishRecipes: true }, tree);
  await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
  const built = await on.run("assemble", component);
  const decided = await on.run("decide", PLUGIN, "--commit", component, "--verdict", verdict);
  if (built.code !== EXIT.ok || decided.code !== EXIT.ok) throw new Error(`no approved copy: ${JSON.stringify([built.output, decided.output])}`);
  cpSync(join(on.home, ".cairnfield/decisions.json"), join(elsewhere, "approvals.json"));
  return { component, tree: String(built.output["tree"]), copy: clone(on.repo(`fork-${component}`), `copy/${component}`, "installed") };
}

describe("verify", () => {
  it("passes on a clone of the copy the team published, with no config file, no node and no Git", async () => {
    const { component, tree, copy } = await approvedCopy();
    const requests = on.requests.length;
    const gitCalls = on.gitCalls.length;

    expect(await verify(PLUGIN, copy, "--approvals", "approvals.json")).toEqual({
      code: EXIT.ok,
      output: { url: PLUGIN, commit: component, verdict: "approved-with-required-mitigations", tree },
    });
    expect(on.requests).toHaveLength(requests);
    expect(on.gitCalls).toHaveLength(gitCalls);
  });

  it("passes on the copy the command exported", async () => {
    const { component, tree } = await approvedCopy();

    const outcome = await on.run("verify", PLUGIN, `${COPIES}/${component}`, "--approvals", ".cairnfield/decisions.json");

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { tree } });
  });

  it("hashes a link and a file that may be run as Git does", async () => {
    // The checkout leaves the link out. The copy the team publishes still holds it, and so does a clone.
    const { tree, copy } = await approvedCopy([...TREE, { path: "current-rules", content: "config/rules.txt", mode: "120000" }]);

    expect(await verify(PLUGIN, copy, "--approvals", "approvals.json")).toMatchObject({ code: EXIT.ok, output: { tree } });
  });

  it.each([
    ["one changed byte", (copy: string) => appendFileSync(join(copy, "notes.md"), " ")],
    ["one added file", (copy: string) => writeFileSync(join(copy, "config/extra.txt"), "")],
    ["one changed file mode", (copy: string) => chmodSync(join(copy, "notes.md"), 0o755)],
  ])("fails on a copy with %s (AE17)", async (_what, change) => {
    const { component, tree, copy } = await approvedCopy();
    change(copy);

    const outcome = await verify(PLUGIN, copy, "--approvals", "approvals.json");

    expect(outcome).toMatchObject({ code: EXIT.differs, output: { error: "copy-differs", url: PLUGIN, commit: component, approved: tree } });
    expect(outcome.output["found"]).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.output["found"]).not.toBe(tree);
  });

  it("fails on a clone of the original", async () => {
    const { component } = await approvedCopy();
    const original = clone(on.repo(`copy-${component}`), TEAM_BRANCH, "original");

    expect(await verify(PLUGIN, original, "--approvals", "approvals.json")).toMatchObject({ code: EXIT.differs, output: { error: "copy-differs" } });
  });

  it("fails with its own exit code for a component with no entry", async () => {
    const { copy } = await approvedCopy();
    const other = "https://git.fellbeck-tools.example/another-plugin.git";

    expect(await verify(other, copy, "--approvals", "approvals.json")).toEqual({ code: EXIT.notApproved, output: { error: "not-approved", url: other } });
  });

  it("fails with that exit code for a component the team did not approve", async () => {
    const { copy } = await approvedCopy(TREE, "not-approved");

    expect(await verify(PLUGIN, copy, "--approvals", "approvals.json")).toEqual({ code: EXIT.notApproved, output: { error: "not-approved", url: PLUGIN } });
  });

  it("fails when it is given no approvals file, and reads no published recipe in its place", async () => {
    const { copy } = await approvedCopy();
    const requests = on.requests.length;

    expect(await verify(PLUGIN, copy)).toEqual({ code: EXIT.usage, output: { error: "no-approvals" } });
    expect(await verify(PLUGIN, copy, "--approvals", "none.json")).toEqual({ code: EXIT.usage, output: { error: "no-approvals" } });
    expect(on.requests).toHaveLength(requests);
  });

  it("refuses an approvals file that lies in the copy it checks", async () => {
    const { copy } = await approvedCopy();
    cpSync(join(elsewhere, "approvals.json"), join(copy, "approvals.json"));

    expect(await verify(PLUGIN, copy, "--approvals", join(copy, "approvals.json"))).toEqual({ code: EXIT.usage, output: { error: "bad-approvals" } });
  });
});

describe("a team working alone, with no index", () => {
  it("goes from pin to verify on the demo plugin (AE18)", async () => {
    cpSync(`${FIXTURES}lenses`, join(on.home, "lenses"), { recursive: true });
    cpSync(`${FIXTURES}recordings`, join(on.home, "recordings"), { recursive: true });
    on.configure({ node: NODE, team: "team-a", recordings: "recordings", lens: "lenses/team-a-alone.json" });
    const plugin = await pinned(on);
    const component = plugin.first;
    saveOutbox(on, "team-a");
    const steps = [
      await on.run("publish"),
      await on.run("patch", component, "--finding", "72b5c551a1e4d6e2a878068dfd3dc3eceac11ed32d56e0110d54dcc67fd83ba9", "--replay"),
      await on.run("assemble", component),
      await on.run("decide", plugin.url, "--commit", component, "--verdict", "approved-with-required-mitigations"),
      await on.run("approvals"),
    ];
    expect(steps.map(({ code }) => code)).toEqual([EXIT.ok, EXIT.ok, EXIT.ok, EXIT.ok, EXIT.ok]);
    // No step asked an index for anything.
    expect([...new Set(on.requests.map((seen) => new URL(seen.url).origin))]).toEqual([NODE]);

    cpSync(join(on.home, ".cairnfield/decisions.json"), join(elsewhere, "approvals.json"));
    const installed = clone(on.repo(`fork-${component}`), `copy/${component}`, "installed");
    const original = clone(on.repo(`copy-${component}`), TEAM_BRANCH, "original");
    git(original, ["checkout", "--quiet", component]);

    expect(await verify(plugin.url, installed, "--approvals", "approvals.json")).toMatchObject({ code: EXIT.ok, output: { commit: component } });
    expect(await verify(plugin.url, original, "--approvals", "approvals.json")).toMatchObject({ code: EXIT.differs, output: { error: "copy-differs" } });
  });
});
