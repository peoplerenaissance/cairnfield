// `decide` and `approvals`: the verdict an operator gives for a commit, and the team's
// table of what it may install (R32). The table is a local file. Nothing here reaches a
// node or an index.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import { DECISIONS, OTHER_PLUGIN_URL, OUTBOX, PLUGIN_URL, bench, pinTree } from "./support.ts";
import type { Bench } from "./support.ts";
import { TREE, bothRules, ownPatch, pinnedWith, rules } from "./assemble/team.ts";

vi.setConfig({ testTimeout: 30_000 });


let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const decide = (url: string, commit: string, verdict: string) => on.run("decide", url, "--commit", commit, "--verdict", verdict);
const now = (): string => new Date(on.io.now()).toISOString();
const table = (): unknown => JSON.parse(readFileSync(join(on.home, DECISIONS), "utf8"));

describe("decide", () => {
  it.each(["fine", "approved-with-mitigations", ""])("refuses the verdict '%s', which is none of the three", async (verdict) => {
    const commit = await pinnedWith(on, { patchLevel: 1 });

    expect(await decide(PLUGIN_URL, commit, verdict)).toEqual({ code: EXIT.usage, output: { error: "usage" } });
    expect(await on.run("decide", PLUGIN_URL, "--commit", commit)).toEqual({ code: EXIT.usage, output: { error: "usage" } });
    expect(existsSync(join(on.home, DECISIONS))).toBe(false);
  });

  it("refuses approved with required mitigations when no copy was built", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 });

    expect(await decide(PLUGIN_URL, commit, "approved-with-required-mitigations")).toEqual({
      code: EXIT.invalid,
      output: { error: "no-copy", component: commit },
    });
    expect(existsSync(join(on.home, DECISIONS))).toBe(false);
  });

  it("records the verdict with the tree hash of the copy the team built", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 });
    await ownPatch(on, commit, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    const built = await on.run("assemble", commit);

    const outcome = await decide(PLUGIN_URL, commit, "approved-with-required-mitigations");

    const entry = { url: PLUGIN_URL, commit, verdict: "approved-with-required-mitigations", date: now(), tree: built.output["tree"] };
    expect(built.code).toBe(EXIT.ok);
    expect(outcome).toEqual({ code: EXIT.ok, output: entry });
    expect(table()).toEqual({ version: SCHEMA_VERSION, decisions: [entry] });
  });

  it("records an approval of a commit the team built no copy of, with no tree hash", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 });

    expect(await decide(PLUGIN_URL, commit, "approved")).toEqual({
      code: EXIT.ok,
      output: { url: PLUGIN_URL, commit, verdict: "approved", date: now() },
    });
  });

  it("records no verdict for a commit that is not pinned here", async () => {
    await pinnedWith(on, { patchLevel: 1 });
    const unknown = "1f".repeat(20);

    expect(await decide(PLUGIN_URL, unknown, "approved")).toEqual({ code: EXIT.invalid, output: { error: "unknown-component", component: unknown } });
  });

  it("reaches no node and no index, and never places the decisions file in the outbox", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 });
    const requests = on.requests.length;

    await decide(PLUGIN_URL, commit, "not-approved");

    expect(on.requests).toHaveLength(requests);
    expect(readdirSync(join(on.home, ".cairnfield"))).toContain("decisions.json");
    expect(existsSync(join(on.home, OUTBOX))).toBe(false);
    expect(await on.run("publish")).toEqual({ code: EXIT.ok, output: { records: 0, published: [], notice: "none" } });
  });

  it("stops at a decisions file it cannot read as one, and leaves it as it is", async () => {
    const commit = await pinnedWith(on, { patchLevel: 1 });
    mkdirSync(join(on.home, ".cairnfield"), { recursive: true });
    writeFileSync(join(on.home, DECISIONS), JSON.stringify({ version: SCHEMA_VERSION, decisions: [{ url: PLUGIN_URL, verdict: "approved" }] }));
    const before = readFileSync(join(on.home, DECISIONS), "utf8");

    expect(await decide(PLUGIN_URL, commit, "approved")).toEqual({ code: EXIT.failed, output: { error: "bad-decisions" } });
    expect(readFileSync(join(on.home, DECISIONS), "utf8")).toBe(before);
  });
});

describe("approvals", () => {
  it("lists nothing for a team that has given no verdict", async () => {
    expect(await on.run("approvals")).toEqual({ code: EXIT.ok, output: { approvals: [] } });
  });

  it("lists one entry for each component: after a verdict for a newer commit, only the newer one", async () => {
    const first = await pinnedWith(on, { patchLevel: 1 });
    await decide(PLUGIN_URL, first, "not-approved");
    await decide(OTHER_PLUGIN_URL, first, "approved");
    const { commit: later } = await pinTree(on, [...TREE, { path: "CHANGES.md", content: "A later release.\n" }]);

    await decide(PLUGIN_URL, later, "approved");

    expect(later).not.toBe(first);
    expect(await on.run("approvals")).toEqual({
      code: EXIT.ok,
      output: {
        approvals: [
          { url: OTHER_PLUGIN_URL, commit: first, verdict: "approved", date: now() },
          { url: PLUGIN_URL, commit: later, verdict: "approved", date: now() },
        ],
      },
    });
  });
});
