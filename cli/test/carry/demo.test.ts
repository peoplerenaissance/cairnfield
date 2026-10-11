// The demo's carry step, rehearsed on this machine (KTD25, R37): the demo plugin's two
// commits, Team A's saved findings and the recording of its patch. The later commit
// changes the sync script and nothing the patch touches, so the patch carries with its
// patch ID, one finding does not carry, and the team builds its copy of the later commit.

import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordId } from "@cairnfield/protocol";
import { EXIT } from "../../src/outcome.ts";
import { copied } from "../assemble/team.ts";
import { FIXTURES, NODE, bench, git, patchIdOf, pinned, saveOutbox } from "../support.ts";
import type { Bench } from "../support.ts";
import { findingsSaid, patchRefs, patchesSaid, recordOf, recordsAt } from "./release.ts";

vi.setConfig({ testTimeout: 120_000 });

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const COMMITS = JSON.parse(readFileSync(`${FIXTURES}demo-plugin/COMMITS.json`, "utf8")) as { readonly first: string; readonly later: string };
// Team A's saved findings, by ID: the any-host rule, the hidden instruction, the off
// switch the export script does not read, and the upload in the sync script.
const ANY_HOST = "72b5c551a1e4d6e2a878068dfd3dc3eceac11ed32d56e0110d54dcc67fd83ba9";
const HIDDEN = "981ae3aa8aadd84d9f44c609c4302727d91b4d381b92c124d7216879aa665b08";
const OFF_SWITCH = "a4b3c7f9e508e87fc131e4686b4ca4b70bad85cc373276f12be8e51638f50635";
const SYNC_UPLOAD = "e36308f073619df223e0334262049f203c026ddf14f4f9d3a15af666f8ea72e8";
const NAMED_HOST = '    "network": { "hosts": ["api.fellbeck-notes.example"] },';

/** One of Team A's saved findings, as its file holds it. */
function saved(id: string): { readonly [field: string]: unknown } {
  return JSON.parse(readFileSync(`${FIXTURES}outboxes/team-a/records/${COMMITS.first}/finding/${id}.json`, "utf8")) as { readonly [field: string]: unknown };
}

describe("carry, on the demo plugin's two commits", () => {
  it("carries Team A's recorded patch with its patch ID and all its findings but the one on the sync script, and the later commit's copy is built from the carried patch", async () => {
    on.configure({ node: NODE, team: "team-a", recordings: `${FIXTURES}recordings`, lens: `${FIXTURES}lenses/team-a-alone.json` });
    const { first, later, branch } = await pinned(on);
    expect([first, later]).toEqual([COMMITS.first, COMMITS.later]);
    // The node's copy of the later commit, as an import of the plugin's branch gives it.
    git(on.repo(`copy-${first}`), ["push", "--quiet", on.createRepo(`copy-${later}`), branch]);
    // The saved outbox holds four findings, and the recordings two patches. This test replays the one for the any-host rule.
    expect(readdirSync(`${FIXTURES}outboxes/team-a/records/${first}/finding`).sort()).toEqual([ANY_HOST, HIDDEN, OFF_SWITCH, SYNC_UPLOAD].map((id) => `${id}.json`));
    expect(readdirSync(`${FIXTURES}recordings/team-a/${first}`).sort()).toEqual([ANY_HOST, HIDDEN].map((id) => `${id}.json`));
    saveOutbox(on, "team-a");
    expect((await on.run("publish")).code).toBe(EXIT.ok);
    const patched = await on.run("patch", first, "--finding", ANY_HOST, "--replay");
    expect(patched.code).toBe(EXIT.ok);
    const patchId = String(patched.output["patchId"]);

    const outcome = await on.run("carry", first, later, "--branch", branch);

    expect(outcome.code).toBe(EXIT.ok);
    // Each finding is written again for the later commit, at the path and lines it had.
    const written = async (id: string): Promise<string> => recordId({ ...saved(id), component: later });
    expect(findingsSaid(outcome)).toEqual([
      { finding: ANY_HOST, carried: true, reason: "content-unchanged", as: await written(ANY_HOST), path: "plugin.json" },
      { finding: HIDDEN, carried: true, reason: "content-unchanged", as: await written(HIDDEN), path: "skills/sync/SKILL.md" },
      { finding: OFF_SWITCH, carried: true, reason: "content-unchanged", as: await written(OFF_SWITCH), path: "scripts/export.sh" },
      { finding: SYNC_UPLOAD, carried: false, reason: "content-changed" },
    ]);
    expect(recordOf(on, later, "finding", await written(OFF_SWITCH))).toEqual({ ...saved(OFF_SWITCH), component: later });

    // The patch has the patch ID it had on the first commit, in a new commit on the later one.
    const [said, ...rest] = patchesSaid(outcome);
    expect(rest).toEqual([]);
    expect(said).toMatchObject({ patch: patched.output["patch"], patchId, carried: true, reason: "content-unchanged" });
    const commit = said?.commit ?? "";
    const fork = on.repo(`fork-${later}`);
    expect(commit).not.toBe(patched.output["commit"]);
    expect(patchRefs(on, later)).toEqual([`refs/heads/patch/${later}/${patchId} ${commit}`]);
    expect(git(fork, ["rev-list", "--parents", "-n", "1", commit])).toBe(`${commit} ${later}`);
    expect(await patchIdOf(fork, later, commit)).toBe(patchId);
    expect(await patchIdOf(on.repo(`fork-${first}`), first, String(patched.output["commit"]))).toBe(patchId);
    expect(git(fork, ["diff", "--numstat", later, commit])).toBe("1\t1\tplugin.json");
    // Its record cites the finding of the later commit, and no claim of the first.
    const record = { version: "1", type: "patch", component: later, commit, findings: [await written(ANY_HOST)], model: "claude-sonnet-5-5" };
    expect(said?.as).toBe(await recordId(record));
    expect(recordOf(on, later, "patch", said?.as ?? "")).toEqual(record);
    expect(recordsAt(on, later)).toHaveLength(4);

    expect(outcome.output["leftBehind"]).toEqual([]);
    expect(outcome.output["paths"]).toEqual({ added: 0, changed: 1, removed: 0 });

    // The team's lens takes its own patches, so the copy of the later commit holds the carried one.
    const built = await on.run("assemble", later);

    expect(built.code).toBe(EXIT.ok);
    expect(built.output["patches"]).toEqual([{ patchId, node: NODE, commit, kind: "adds-or-changes", size: 2 }]);
    expect(built.output["paths"]).toEqual(["plugin.json"]);
    expect(copied(on, later, "plugin.json").split("\n")[11]).toBe(NAMED_HOST);
    expect(copied(on, later, "scripts/sync.sh")).toBe(readFileSync(`${FIXTURES}demo-plugin/later/scripts/sync.sh`, "utf8"));
  });
});
