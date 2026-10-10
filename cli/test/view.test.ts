// `view`: the index view of one component commit, with everything dropped that comes
// from a node the lens does not name (R23, KTD38). The index is a fake that serves the
// protocol's own view shape.

import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, VIEW, conforms, recordId, recordPath } from "@cairnfield/protocol";
import type { AnyRecord } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import { FIXTURES, INDEX, NODE, OTHER_NODE, THIRD_NODE, bench } from "./support.ts";
import type { Bench } from "./support.ts";

const COMPONENT = "1f".repeat(20);
const HEAD = "2e".repeat(20);
const BLOB = "3d".repeat(20);
const TREE = "4c".repeat(20);
const PATCH_ID = "a".repeat(64);
const HOST = "collect.fellbeck-metrics.example";

const common = { version: SCHEMA_VERSION, component: COMPONENT };
const HIDDEN = {
  ...common,
  type: "finding",
  location: { path: "skills/sync/SKILL.md", start: 41, end: 41 },
  criterion: "safe-to-run-with-access",
  observation: "sends-data-to-host",
  host: HOST,
  check: "instructions",
  model: "other",
};
const ANY_HOST = {
  ...common,
  type: "finding",
  location: { path: "plugin.json", start: 12, end: 12 },
  criterion: "safe-to-run-sandboxed",
  observation: "network-access-any-host",
  check: "permissions",
  model: "other",
};

/** A record as the index publishes it: with its node and where the node holds it. */
async function from(node: string, record: object) {
  const id = await recordId(record);
  return { node, repo: "team", commit: HEAD, path: recordPath(record as AnyRecord, id), id, record };
}

const organization = (node: string) => ({ node, simulated: false, historyRewritten: false });

async function served(): Promise<object> {
  const anyHostId = await recordId(ANY_HOST);
  return {
    version: SCHEMA_VERSION,
    component: COMPONENT,
    state: "ready",
    viewVersion: 9,
    lag: 0,
    organizations: 3,
    nodes: [NODE, OTHER_NODE, THIRD_NODE].map(organization),
    claims: [
      { ...(await from(NODE, { ...common, type: "claim", kind: "review", number: 1, check: "code" })), state: "live" },
      { ...(await from(THIRD_NODE, { ...common, type: "claim", kind: "review", number: 2, check: "code" })), state: "live" },
    ],
    findings: [
      {
        blob: BLOB,
        observation: "sends-data-to-host",
        host: HOST,
        paths: ["skills/sync/SKILL.md"],
        findings: [await from(NODE, HIDDEN), await from(THIRD_NODE, HIDDEN)],
        rechecks: [],
        counterFindings: [],
        nodes: [NODE, THIRD_NODE],
        confirmed: true,
        criteria: [{ criterion: "safe-to-run-with-access", nodes: [NODE, THIRD_NODE], confirmed: true }],
      },
      {
        blob: BLOB,
        observation: "network-access-any-host",
        paths: ["plugin.json"],
        findings: [await from(THIRD_NODE, ANY_HOST)],
        rechecks: [await from(OTHER_NODE, { ...common, type: "re-check", finding: anyHostId, model: "other" })],
        counterFindings: [],
        nodes: [OTHER_NODE, THIRD_NODE],
        confirmed: true,
        criteria: [
          { criterion: "safe-to-run-sandboxed", nodes: [OTHER_NODE, THIRD_NODE], confirmed: true },
          { criterion: "safe-to-run-with-access", nodes: [OTHER_NODE, THIRD_NODE], confirmed: true },
        ],
      },
    ],
    hosts: [{ host: HOST, count: 2 }],
    patches: [
      {
        patches: [
          {
            patchId: PATCH_ID,
            kind: "removes-only",
            size: 1,
            changes: [{ blob: BLOB, hunks: [{ oldStart: 41, removed: 1, newStart: 41, added: 0 }] }],
            paths: ["skills/sync/SKILL.md"],
            records: [
              await from(OTHER_NODE, { ...common, type: "patch", commit: HEAD, findings: [await recordId(HIDDEN)], model: "other" }),
              await from(THIRD_NODE, { ...common, type: "patch", commit: TREE, findings: [await recordId(HIDDEN)], model: "other" }),
            ],
            rechecks: [
              await from(THIRD_NODE, { ...common, type: "patch-re-check", patch: PATCH_ID, verdict: "resolves", model: "other" }),
            ],
            nodes: [OTHER_NODE, THIRD_NODE],
            confirmed: true,
          },
        ],
      },
    ],
    recipes: [
      { tree: TREE, records: [await from(THIRD_NODE, { ...common, type: "recipe", patches: [PATCH_ID], tree: TREE })], nodes: [THIRD_NODE] },
    ],
    pending: [{ node: THIRD_NODE, hash: "b".repeat(64), type: "finding" }],
    rejected: [
      { node: NODE, hash: "c".repeat(64), type: "finding", reason: "lines-out-of-range" },
      { node: THIRD_NODE, hash: "d".repeat(64), type: "patch", reason: "patch-out-of-scope" },
    ],
  };
}

let on: Bench;
beforeEach(async () => {
  on = bench();
  cpSync(`${FIXTURES}lenses`, join(on.home, "lenses"), { recursive: true });
  on.configure({ node: NODE, index: INDEX, lens: "lenses/team-a-alone.json" });
  on.index.views.set(COMPONENT, await served());
});
afterEach(() => {
  on.dispose();
});

describe("view", () => {
  it("is given a view by the fake index that the protocol accepts", async () => {
    expect(conforms(VIEW, await served())).toBeUndefined();
  });

  it("keeps the team's own records and drops every valid record of a node the lens does not name", async () => {
    const outcome = await on.run("view", COMPONENT);

    expect(outcome.code).toBe(EXIT.ok);
    expect(conforms(VIEW, outcome.output)).toBeUndefined();
    expect(outcome.output).toEqual({
      version: SCHEMA_VERSION,
      component: COMPONENT,
      state: "ready",
      viewVersion: 9,
      lag: 0,
      organizations: 1,
      nodes: [organization(NODE)],
      claims: [{ ...(await from(NODE, { ...common, type: "claim", kind: "review", number: 1, check: "code" })), state: "live" }],
      findings: [
        {
          blob: BLOB,
          observation: "sends-data-to-host",
          host: HOST,
          paths: ["skills/sync/SKILL.md"],
          findings: [await from(NODE, HIDDEN)],
          rechecks: [],
          counterFindings: [],
          // One organization is left behind the finding, so it is no longer confirmed.
          nodes: [NODE],
          confirmed: false,
          criteria: [{ criterion: "safe-to-run-with-access", nodes: [NODE], confirmed: false }],
        },
      ],
      hosts: [{ host: HOST, count: 1 }],
      patches: [],
      recipes: [],
      pending: [],
      rejected: [{ node: NODE, hash: "c".repeat(64), type: "finding", reason: "lines-out-of-range" }],
    });
  });

  it("keeps a named team's work, and counts only the organizations the lens names", async () => {
    // The saved lens names Team B by the stand-in this bench gives its node.
    on.configure({ node: NODE, index: INDEX, lens: "lenses/team-a-names-b.json" });

    const { output } = await on.run("view", COMPONENT);

    expect(output).toMatchObject({ organizations: 2, nodes: [organization(NODE), organization(OTHER_NODE)] });
    // Team B confirmed a finding of a team the lens does not name. With that finding gone, so is its re-check.
    expect(output["findings"]).toHaveLength(1);
    expect(output["patches"]).toEqual([
      {
        patches: [
          expect.objectContaining({
            patchId: PATCH_ID,
            records: [expect.objectContaining({ node: OTHER_NODE })],
            rechecks: [],
            nodes: [OTHER_NODE],
            confirmed: false,
          }),
        ],
      },
    ]);
    expect(output["recipes"]).toEqual([]);
  });

  it("takes a group apart when the finding that held it together came from a node the lens does not name", async () => {
    on.configure({ node: NODE, index: INDEX, lens: "lenses/team-a-names-b.json" });
    const at = (start: number, end: number) => ({ ...ANY_HOST, location: { path: "plugin.json", start, end } });
    const mine = await from(NODE, at(1, 5));
    const theirs = await from(OTHER_NODE, at(9, 15));
    // The index saw one chain of overlapping findings, with three organizations behind it.
    const bridged = {
      blob: BLOB,
      observation: "network-access-any-host",
      paths: ["plugin.json"],
      findings: [mine, await from(THIRD_NODE, at(4, 10)), theirs],
      rechecks: [],
      counterFindings: [],
      nodes: [NODE, OTHER_NODE, THIRD_NODE],
      confirmed: true,
      criteria: [{ criterion: "safe-to-run-sandboxed", nodes: [NODE, OTHER_NODE, THIRD_NODE], confirmed: true }],
    };
    const other = "5b".repeat(20);
    on.index.views.set(other, { ...(await served()), component: other, findings: [bridged], hosts: [] });

    const { output } = await on.run("view", other);

    expect(conforms(VIEW, output)).toBeUndefined();
    expect(output["findings"]).toEqual([
      expect.objectContaining({ findings: [mine], nodes: [NODE], confirmed: false }),
      expect.objectContaining({ findings: [theirs], nodes: [OTHER_NODE], confirmed: false }),
    ]);
    for (const group of output["findings"] as { criteria: unknown }[]) {
      expect(group.criteria).toEqual([
        expect.objectContaining({ criterion: "safe-to-run-sandboxed", confirmed: false }),
        expect.objectContaining({ criterion: "safe-to-run-with-access", confirmed: false }),
      ]);
    }
  });

  /** A patch record of a node for these findings. `id` tells its commit from another's. */
  const patchRecord = (node: string, id: string, findings: readonly string[]) =>
    from(node, { ...common, type: "patch", commit: id.repeat(40), findings: [...findings].sort(), model: "other" });

  /** A patch entry of the fake index with these records, which removes lines of `plugin.json`. */
  const patch = (id: string, oldStart: number, removed: number, records: readonly { readonly node: string }[]) => {
    const nodes = [...new Set(records.map(({ node }) => node))].sort();
    return {
      patchId: id.repeat(64),
      kind: "removes-only",
      size: removed,
      changes: [{ blob: BLOB, hunks: [{ oldStart, removed, newStart: oldStart, added: 0 }] }],
      paths: ["plugin.json"],
      records,
      rechecks: [],
      nodes,
      confirmed: nodes.length > 1,
    };
  };

  it("no longer shows two patches side by side when the patch between them is gone", async () => {
    on.configure({ node: NODE, index: INDEX, lens: "lenses/team-a-names-b.json" });
    // Each patch is for a finding that the team published itself, so the lens keeps the finding.
    const hidden = await recordId(HIDDEN);
    const one = async (node: string, id: string, oldStart: number, removed: number) => patch(id, oldStart, removed, [await patchRecord(node, id, [hidden])]);
    const other = "5b".repeat(20);
    const group = { patches: [await one(NODE, "1", 1, 2), await one(THIRD_NODE, "2", 3, 6), await one(OTHER_NODE, "3", 9, 2)] };
    on.index.views.set(other, { ...(await served()), component: other, patches: [group] });

    const { output } = await on.run("view", other);

    expect(output["patches"]).toEqual([
      { patches: [expect.objectContaining({ patchId: "1".repeat(64) })] },
      { patches: [expect.objectContaining({ patchId: "3".repeat(64) })] },
    ]);
  });

  it("drops a patch record of a team the lens names when a finding it names came only from a team the lens does not name", async () => {
    on.configure({ node: NODE, index: INDEX, lens: "lenses/team-a-names-b.json" });
    // The team published the first finding itself. Only the third team published the second.
    const [kept, gone] = [await recordId(HIDDEN), await recordId(ANY_HOST)];
    const mine = await patchRecord(NODE, "4", [kept]);
    const other = "5b".repeat(20);
    const patches = [
      { patches: [patch("1", 1, 2, [await patchRecord(OTHER_NODE, "1", [gone])])] },
      { patches: [patch("2", 9, 2, [await patchRecord(OTHER_NODE, "2", [kept])])] },
      { patches: [patch("3", 20, 2, [await patchRecord(OTHER_NODE, "3", [kept, gone])])] },
      { patches: [patch("4", 30, 2, [mine, await patchRecord(OTHER_NODE, "5", [gone])])] },
    ];
    on.index.views.set(other, { ...(await served()), component: other, patches });

    const { output } = await on.run("view", other);

    expect(conforms(VIEW, output)).toBeUndefined();
    // As in the index's own view of the same teams: a patch shows only while every finding it names is in the view.
    expect(output["patches"]).toEqual([
      { patches: [expect.objectContaining({ patchId: "2".repeat(64), nodes: [OTHER_NODE], confirmed: false })] },
      { patches: [expect.objectContaining({ patchId: "4".repeat(64), records: [mine], nodes: [NODE], confirmed: false })] },
    ]);
  });

  it("fails with a code of its own when the config names no index", async () => {
    on.configure({ node: NODE, lens: "lenses/team-a-alone.json" });
    expect(await on.run("view", COMPONENT)).toEqual({ code: EXIT.noIndex, output: { error: "no-index" } });
    expect(on.requests).toEqual([]);
  });

  it("needs a lens", async () => {
    on.configure({ node: NODE, index: INDEX });
    expect(await on.run("view", COMPONENT)).toEqual({ code: EXIT.usage, output: { error: "no-lens" } });

    on.configure({ node: NODE, index: INDEX, lens: "lenses/none.json" });
    expect(await on.run("view", COMPONENT)).toEqual({ code: EXIT.usage, output: { error: "no-lens" } });

    writeFileSync(join(on.home, "lenses/level-3.json"), JSON.stringify({ patchLevel: 3, teams: [], patchKinds: [], publishRecipes: false }));
    on.configure({ node: NODE, index: INDEX, lens: "lenses/level-3.json" });
    expect(await on.run("view", COMPONENT)).toEqual({ code: EXIT.usage, output: { error: "bad-lens", reason: "level-3-not-built" } });
    expect(on.requests).toEqual([]);
  });

  it("never reads a lens from a checkout, where a component could have put one", async () => {
    const inside = join(on.home, ".cairnfield/checkouts", COMPONENT);
    mkdirSync(inside, { recursive: true });
    // A lens of the component's own, which names its author's node as a team to trust.
    writeFileSync(join(inside, "lens.json"), JSON.stringify({ patchLevel: 2, teams: [THIRD_NODE], patchKinds: [], publishRecipes: false }));
    symlinkSync(join(inside, "lens.json"), join(on.home, "lenses/linked.json"));

    for (const lens of [`.cairnfield/checkouts/${COMPONENT}/lens.json`, "lenses/linked.json"]) {
      on.configure({ node: NODE, index: INDEX, lens });
      expect(await on.run("view", COMPONENT), lens).toEqual({ code: EXIT.usage, output: { error: "bad-lens", reason: "in-checkout" } });
    }
    expect(on.requests).toEqual([]);
  });

  it("says what the index refused, and refuses an answer that is no view", async () => {
    const other = "5b".repeat(20);
    expect(await on.run("view", other)).toEqual({ code: EXIT.index, output: { error: "index-refused", reason: "not-found" } });

    on.index.views.set(other, { ...(await served()), note: "read me first" });
    expect(await on.run("view", other)).toEqual({ code: EXIT.index, output: { error: "index-bad-answer" } });
  });
});
