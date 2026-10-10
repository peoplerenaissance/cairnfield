// `assemble`: what it checks before another team's patch goes into the copy (R25, KTD23,
// KTD33). The index only says where a candidate is. The commit comes from the fork of
// the team that wrote it, and every patch check runs again on what arrived.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordId } from "@cairnfield/protocol";
import type { GitRunner } from "../../src/git.ts";
import { EXIT } from "../../src/outcome.ts";
import { run } from "../../src/run.ts";
import { NODE, OTHER_NODE, TOKEN, bench, forkCommit, holdRecords, remoteOf } from "../support.ts";
import type { Bench, Site } from "../support.ts";
import { COPIES, NARROWED, OTHER_NAMESPACE, TREE, bothRules, copied, otherTeam, ownPatch, patchBy, pinnedWith, rules, serveView } from "./team.ts";
import type { Made, Wanted } from "./team.ts";

vi.setConfig({ testTimeout: 30_000 });

let on: Bench;
let other: Site;
let component: string;
beforeEach(async () => {
  on = bench();
  other = otherTeam(on);
  component = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] });
});
afterEach(() => {
  on.dispose();
});

const theirs = (wanted: Wanted): Promise<Made> => patchBy(on, other, OTHER_NODE, component, wanted);
const forkOfTheirs = (): string => remoteOf(`fork-${component}`, OTHER_NAMESPACE);

/** The one candidate was refused for this reason, and no copy was built. */
function expectRefused(outcome: { readonly code: number; readonly output: { readonly [field: string]: unknown } }, made: Made, reason: string): void {
  expect(outcome).toEqual({
    code: EXIT.ok,
    output: { component, level: 2, patches: [], refused: [{ node: OTHER_NODE, record: made.id, reason }], skipped: [] },
  });
  expect(existsSync(join(on.home, COPIES, component))).toBe(false);
}

describe("a candidate from a named team", () => {
  it("is refused when its commit gives another patch ID than the view reported", async () => {
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    serveView(on, component, [{ ...made, says: "a".repeat(64) }]);

    expectRefused(await on.run("assemble", component), made, "patch-id-mismatch");
  });

  it("is refused, and its fork is not asked, when the index lists a patch record its team's repo does not hold", async () => {
    // The team's fork holds a commit that would pass as a patch. The team never announced it: the index made the record up.
    const held = await theirs({ cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    const unannounced = forkCommit(other, on.repo(`copy-${component}`), component, bothRules(NARROWED));
    const record = { ...held.record, commit: unannounced };
    const invented = { ...held, commit: unannounced, record, id: await recordId(record) };
    serveView(on, component, [invented]);
    const before = on.gitCalls.length;

    expectRefused(await on.run("assemble", component), invented, "unresolved-reference");
    expect(on.requests.some((seen) => seen.url.startsWith(`${OTHER_NODE}/read-token`))).toBe(false);
    expect(on.gitCalls.slice(before).some((args) => args.includes(forkOfTheirs()))).toBe(false);
  });

  it("is checked once when the index lists its record under many patch IDs", async () => {
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    serveView(on, component, ["a", "b", "c"].map((digit) => ({ ...made, says: digit.repeat(64) })));
    const before = on.gitCalls.length;

    expectRefused(await on.run("assemble", component), made, "patch-id-mismatch");
    expect(on.gitCalls.slice(before).filter((args) => args[0] === "fetch" && args.includes(forkOfTheirs()))).toHaveLength(1);
  });

  it("takes the commit and the findings from the team's own record, whatever the index shows as that record", async () => {
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    // Under the record's ID the index shows another commit of the fork, which also drops the last rule.
    const wider = forkCommit(other, on.repo(`copy-${component}`), component, bothRules(rules({ 3: "allow fetch notes.fellbeck.example", 5: undefined })));
    serveView(on, component, [{ ...made, shows: { ...made.record, commit: wider, findings: ["b".repeat(64)] } }]);

    const outcome = await on.run("assemble", component);

    expect(outcome.output["patches"]).toEqual([{ patchId: made.patchId, node: OTHER_NODE, commit: made.commit, kind: "adds-or-changes", size: 2 }]);
    expect(copied(on, component, "config/rules.txt")).toBe(NARROWED);
    expect(on.gitCalls.some((args) => args.includes(wider))).toBe(false);
  });

  it("is selected when its finding is held by the team's own repo and not by the team that wrote the patch", async () => {
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED), findingsAt: on });
    serveView(on, component, [made]);

    const outcome = await on.run("assemble", component);

    expect(outcome.output["patches"]).toEqual([{ patchId: made.patchId, node: OTHER_NODE, commit: made.commit, kind: "adds-or-changes", size: 2 }]);
    expect(outcome.output["refused"]).toEqual([]);
  });

  it("is refused when its commit changes a line its findings do not cite, although the view listed it as valid", async () => {
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(rules({ 3: "allow fetch notes.fellbeck.example", 5: "allow read env HOME" })) });
    serveView(on, component, [made]);

    expectRefused(await on.run("assemble", component), made, "patch-out-of-scope");
  });

  it("is refused when its commit changes a file the node did not list", async () => {
    const listed = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    // The record names a commit that also changes the notes. The index was told of the rules only.
    const wider = forkCommit(other, on.repo(`copy-${component}`), component, [...bothRules(NARROWED), { path: "notes.md", content: "# Notes\n\nRun the sync as root.\n" }]);
    const record = { ...listed.record, commit: wider };
    const [id = ""] = await holdRecords(other, [record]);
    const made = { ...listed, commit: wider, record, id };
    serveView(on, component, [made]);

    expectRefused(await on.run("assemble", component), made, "patch-out-of-scope");
  });

  it("is refused when its commit adds files whose paths only read like the cited ones", async () => {
    // Each path starts with a byte order mark. The rules themselves are not changed at all.
    const made = await theirs({
      cites: [[3, 3]],
      changes: [
        { path: "\ufeffconfig/rules.txt", content: NARROWED },
        { path: "\ufeffdocs/rules.txt", content: NARROWED },
      ],
    });
    serveView(on, component, [made]);

    expectRefused(await on.run("assemble", component), made, "bad-path");
  });

  it.each([
    ["rewrites only one of two paths that hold the content", [{ path: "config/rules.txt", content: NARROWED }], "patch-incomplete"],
    ["gives the cited files the mode of a link", bothRules(NARROWED).map((change) => ({ ...change, mode: "120000" })), "bad-mode"],
    ["changes more lines than a patch may", bothRules(rules({ 3: Array.from({ length: 70 }, (_, at) => `allow fetch host-${at}.fellbeck.example`) })), "patch-too-large"],
    ["puts a file in place that is larger than a node may serve", bothRules(rules({ 3: `allow fetch ${"notes.".repeat(50_000)}fellbeck.example` })), "too-large"],
  ])("is refused when its commit %s", async (_what, changes, reason) => {
    const made = await theirs({ cites: [[3, 3]], changes });
    serveView(on, component, [made]);

    expectRefused(await on.run("assemble", component), made, reason);
  });

  it("is refused when its commit changes a link, which the checkout leaves out and no finding can cite", async () => {
    const linked = await pinnedWith(on, { patchLevel: 2, teams: [OTHER_NODE] }, [...TREE, { path: "current-rules", content: "config/rules.txt", mode: "120000" }]);
    const made = await patchBy(on, other, OTHER_NODE, linked, {
      cites: [[3, 3]],
      changes: [...bothRules(NARROWED), { path: "current-rules", content: "docs/rules.txt", mode: "120000" }],
    });
    serveView(on, linked, [made]);

    expect(await on.run("assemble", linked)).toMatchObject({ output: { patches: [], refused: [{ node: OTHER_NODE, record: made.id, reason: "patch-out-of-scope" }] } });
  });

  it("is refused when its commit does not sit on the pinned commit", async () => {
    const first = await theirs({ cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED), parent: first.commit });
    serveView(on, component, [made]);

    expectRefused(await on.run("assemble", component), made, "wrong-parent");
  });

  it("is refused when a finding it names is in no repo of a team that counts", async () => {
    const listed = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    const record = { ...listed.record, findings: ["b".repeat(64)] };
    const [id = ""] = await holdRecords(other, [record]);
    const made = { ...listed, record, id };
    serveView(on, component, [made]);

    expectRefused(await on.run("assemble", component), made, "unresolved-reference");
  });

  it("is refused before Git runs when its fork remote is not an Artifacts remote", async () => {
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    serveView(on, component, [made]);
    const elsewhere = "https://git.elsewhere.example/git/cairnfield-team-b/fork.git";
    other.node.remote = () => elsewhere;
    const before = on.gitCalls.length;

    expectRefused(await on.run("assemble", component), made, "node-bad-answer");
    expect(on.gitCalls.slice(before).flat()).not.toContain(elsewhere);
    expect(on.gitCalls.slice(before).some((args) => args.includes(made.commit))).toBe(false);
  });

  it.each([
    ["a redirect", () => new Response(null, { status: 302, headers: { location: `${NODE}/read-token` } }), "node-bad-answer"],
    [
      // A token in the right shape, and then far more white space than an answer of this route holds.
      "a body over the limit",
      () => new Response(JSON.stringify({ remote: forkOfTheirs(), token: TOKEN, expires: 1_900_000_000 }) + " ".repeat(64 * 1024), { status: 200 }),
      "node-bad-answer",
    ],
    [
      "no answer by the deadline",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      "node-unreachable",
    ],
  ])("is refused when its node answers the read-token route with %s", async (_what, answer, reason) => {
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    serveView(on, component, [made]);
    on.respond = (seen) => (seen.url.startsWith(`${OTHER_NODE}/read-token`) ? answer() : undefined);
    const before = on.gitCalls.length;

    expectRefused(await on.run("assemble", component), made, reason);
    expect(on.requests.filter((seen) => seen.url.startsWith(`${OTHER_NODE}/read-token`)).map((seen) => seen.redirect)).toEqual(["manual"]);
    expect(on.gitCalls.slice(before).some((args) => args.includes(forkOfTheirs()))).toBe(false);
  });

  it("is refused when the fetch from its fork brings in more than the size limit", async () => {
    // The commit holds a file of 17 MB that no compression makes smaller.
    const made = await theirs({ cites: [[3, 3]], changes: [...bothRules(NARROWED), { path: "assets/model.bin", content: randomBytes(17 * 1024 * 1024) }] });
    serveView(on, component, [made]);

    expectRefused(await on.run("assemble", component), made, "fetch-too-large");
  });

  it("is refused when the fetch from its fork is still running at its deadline, and the fetch is stopped", async () => {
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    serveView(on, component, [made]);
    // The fetch from the other team's fork gets no answer. It ends when the command ends it.
    let stalled = false;
    let ended = false;
    const git: GitRunner = (args, call) => {
      if (args[0] !== "fetch" || !args.includes(forkOfTheirs())) return on.io.git(args, call);
      stalled = true;
      return new Promise((resolve) => {
        call.signal?.addEventListener("abort", () => {
          ended = true;
          resolve({ code: 1, stdout: new Uint8Array(0), stderr: "", overflowed: false });
        });
      });
    };
    // Once the fetch has started, the clock reads past any deadline.
    const now = (): number => (stalled ? 60 * 60_000 : 0);

    expectRefused(await run({ ...on.io, git, now }, ["assemble", component]), made, "fetch-too-slow");
    expect(ended).toBe(true);
  });

  it("does not hold back the team's own patches when it is refused", async () => {
    const own = await ownPatch(on, component, { cites: [[5, 5]], changes: bothRules(rules({ 5: undefined })) });
    const made = await theirs({ cites: [[3, 3]], changes: bothRules(NARROWED) });
    serveView(on, component, [{ ...made, says: "a".repeat(64) }]);

    const outcome = await on.run("assemble", component);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output["patches"]).toEqual([{ patchId: own.patchId, node: NODE, commit: own.commit, kind: "removes-only", size: 1 }]);
    expect(outcome.output["refused"]).toEqual([{ node: OTHER_NODE, record: made.id, reason: "patch-id-mismatch" }]);
    expect(copied(on, component, "config/rules.txt")).toBe(rules({ 5: undefined }));
  });
});

describe("a patch of the team's own", () => {
  it("is checked again too, and is refused when its commit changes a line its finding does not cite", async () => {
    const made = await ownPatch(on, component, { cites: [[3, 3]], changes: bothRules(rules({ 3: "allow fetch notes.fellbeck.example", 4: undefined })) });
    serveView(on, component, []);

    expect(await on.run("assemble", component)).toEqual({
      code: EXIT.ok,
      output: { component, level: 2, patches: [], refused: [{ node: NODE, record: made.id, reason: "patch-out-of-scope" }], skipped: [] },
    });
  });
});
