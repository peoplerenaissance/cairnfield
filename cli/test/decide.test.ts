// `decide` and `approvals`: the verdict an operator gives for a commit, and the team's
// table of what it may install (R32). The table is a local file. Nothing here reaches a
// node or an index.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import type { Outcome } from "../src/outcome.ts";
import { DECISIONS, OTHER_PLUGIN_URL, OUTBOX, PLUGIN_URL, bench, pinTree } from "./support.ts";
import type { Bench } from "./support.ts";
import { COPIES, NARROWED, TREE, bothRules, ownPatch, pinnedWith, rules } from "./assemble/team.ts";

vi.setConfig({ testTimeout: 30_000 });

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const decide = (commit: string, verdict: string, tree?: string): Promise<Outcome> =>
  on.run("decide", commit, "--verdict", verdict, ...(tree === undefined ? [] : ["--tree", tree]));
const now = (): string => new Date(on.io.now()).toISOString();
const table = (): unknown => JSON.parse(readFileSync(join(on.home, DECISIONS), "utf8"));

/** Pins the small component, patches it and builds the copy. Returns the commit and the copy's tree hash. */
async function built(): Promise<{ readonly commit: string; readonly tree: string }> {
  const commit = await pinnedWith(on, { patchLevel: 1 });
  await ownPatch(on, commit, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
  const outcome = await on.run("assemble", commit);
  if (outcome.code !== EXIT.ok) throw new Error(`no copy was built: ${JSON.stringify(outcome.output)}`);
  return { commit, tree: String(outcome.output["tree"]) };
}

describe("decide", () => {
  it.each(["fine", "approved-with-mitigations", ""])("refuses the verdict '%s', which is none of the three", async (verdict) => {
    const commit = await pinnedWith(on, { patchLevel: 1 });

    expect(await decide(commit, verdict)).toEqual({ code: EXIT.usage, output: { error: "usage" } });
    expect(await on.run("decide", commit)).toEqual({ code: EXIT.usage, output: { error: "usage" } });
    expect(existsSync(join(on.home, DECISIONS))).toBe(false);
  });

  it("refuses approved with required mitigations when no copy was built", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 });

    expect(await decide(commit, "approved-with-required-mitigations")).toEqual({ code: EXIT.invalid, output: { error: "no-copy", component: commit } });
    expect(await decide(commit, "approved", "1f".repeat(20))).toEqual({ code: EXIT.invalid, output: { error: "no-copy", component: commit } });
    expect(existsSync(join(on.home, DECISIONS))).toBe(false);
  });

  it("records the verdict under the URL the commit was pinned from, with the tree hash of the copy the team built", async () => {
    const { commit, tree } = await built();

    const outcome = await decide(commit, "approved-with-required-mitigations", tree);

    const entry = { url: PLUGIN_URL, commit, verdict: "approved-with-required-mitigations", date: now(), tree };
    expect(outcome).toEqual({ code: EXIT.ok, output: entry });
    expect(table()).toEqual({ version: SCHEMA_VERSION, decisions: [entry] });
  });

  it("refuses a verdict on a copy that names no tree hash, or not the hash of the copy that is there", async () => {
    const { commit, tree } = await built();

    expect(await decide(commit, "approved")).toEqual({ code: EXIT.invalid, output: { error: "no-tree", component: commit } });

    // The operator read the diff of this copy. Before the verdict, the copy is built again with another patch in it.
    await ownPatch(on, commit, { cites: [[3, 3]], changes: bothRules(NARROWED) });
    const again = await on.run("assemble", commit);

    expect(again.output["tree"]).not.toBe(tree);
    expect(await decide(commit, "approved", tree)).toEqual({ code: EXIT.invalid, output: { error: "tree-differs", component: commit } });
    expect(existsSync(join(on.home, DECISIONS))).toBe(false);
  });

  it("says how many entries of the pinned tree the exported copy leaves out", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 }, [...TREE, { path: "current-rules", content: "config/rules.txt", mode: "120000" }]);
    await ownPatch(on, commit, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    const tree = String((await on.run("assemble", commit)).output["tree"]);

    expect(await decide(commit, "approved", tree)).toMatchObject({ code: EXIT.ok, output: { tree, leftOut: 1 } });
  });

  it("records an approval of a commit the team built no copy of, with no tree hash", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 });

    expect(await decide(commit, "approved")).toEqual({ code: EXIT.ok, output: { url: PLUGIN_URL, commit, verdict: "approved", date: now() } });
  });

  it("records no verdict for a commit that is not pinned here", async () => {
    await pinnedWith(on, { patchLevel: 1 });
    const unknown = "1f".repeat(20);

    expect(await decide(unknown, "approved")).toEqual({ code: EXIT.invalid, output: { error: "unknown-component", component: unknown } });
  });

  it("reaches no node and no index, and never places the decisions file in the outbox", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 });
    const requests = on.requests.length;

    await decide(commit, "not-approved");

    expect(on.requests).toHaveLength(requests);
    expect(readdirSync(join(on.home, ".cairnfield"))).toContain("decisions.json");
    expect(existsSync(join(on.home, OUTBOX))).toBe(false);
    expect(await on.run("publish")).toEqual({ code: EXIT.ok, output: { records: 0, published: [], notice: "none" } });
  });

  it.each([
    ["an entry with no commit", JSON.stringify({ version: SCHEMA_VERSION, decisions: [{ url: PLUGIN_URL, verdict: "approved" }] })],
    ["text that is not JSON", "{ decisions: "],
  ])("stops at a decisions file that holds %s, and leaves it as it is", async (_what, text) => {
    const commit = await pinnedWith(on, { patchLevel: 1 });
    mkdirSync(join(on.home, ".cairnfield"), { recursive: true });
    writeFileSync(join(on.home, DECISIONS), text);

    expect(await decide(commit, "approved")).toEqual({ code: EXIT.failed, output: { error: "bad-decisions" } });
    expect(await on.run("approvals")).toEqual({ code: EXIT.failed, output: { error: "bad-decisions" } });
    expect(readFileSync(join(on.home, DECISIONS), "utf8")).toBe(text);
  });

  it.each([
    ["names another commit", (commit: string, note: { [field: string]: unknown }) => ({ ...note, component: commit.replace(/^./, (first) => (first === "0" ? "1" : "0")) })],
    ["holds a tree that is no hash", (_commit: string, note: { [field: string]: unknown }) => ({ ...note, tree: "main" })],
  ])("stops at the note of a built copy that %s", async (_what, change) => {
    const { commit, tree } = await built();
    const file = join(on.home, COPIES, `${commit}.json`);
    writeFileSync(file, JSON.stringify(change(commit, JSON.parse(readFileSync(file, "utf8")) as { [field: string]: unknown })));

    expect(await decide(commit, "approved", tree)).toEqual({ code: EXIT.failed, output: { error: "bad-copy", component: commit } });
    expect(existsSync(join(on.home, DECISIONS))).toBe(false);
  });
});

describe("approvals", () => {
  it("lists nothing for a team that has given no verdict", async () => {
    expect(await on.run("approvals")).toEqual({ code: EXIT.ok, output: { approvals: [] } });
  });

  it("lists one entry for each component: after a verdict for a newer commit, only the newer one", async () => {
    const first = await pinnedWith(on, { patchLevel: 1 });
    await decide(first, "not-approved");
    const another = await pinTree(on, [{ path: "README.md", content: "# Another plugin\n" }], OTHER_PLUGIN_URL);
    await decide(another.commit, "approved");
    const { commit: later } = await pinTree(on, [...TREE, { path: "CHANGES.md", content: "A later release.\n" }]);

    await decide(later, "approved");

    expect(later).not.toBe(first);
    expect(await on.run("approvals")).toEqual({
      code: EXIT.ok,
      output: {
        approvals: [
          { url: OTHER_PLUGIN_URL, commit: another.commit, verdict: "approved", date: now() },
          { url: PLUGIN_URL, commit: later, verdict: "approved", date: now() },
        ],
      },
    });
  });
});
