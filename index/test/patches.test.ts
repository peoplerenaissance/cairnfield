// Patch intake (R11, R16, R24): what the index does with a patch record. It asks the
// node for the commit, checks it against its own copy, stores it as valid or rejected,
// and shows the valid patches of a view in groups. Every commit here is made by hand
// behind a fake node.

import { VIEW, compare, conforms, patchId as patchIdOf, recordId } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PATCH_TRIES, PATCH_WAIT_SECONDS } from "../src/patches.ts";
import { BRANCH, FILES, NODE_A, NODE_B, NODE_C, RESET_HEADER, RESET_KEY, SCRIPT_TEXT, SKILL, SYNC_HOST, UPSTREAM, bench, finding, freshIndexForEachTest, synced } from "./bench.ts";
import type { Bench } from "./bench.ts";
import { blobHash } from "./fake-artifacts.ts";
import type { Files } from "./fake-artifacts.ts";
import { FakeNode, nodesBehindFetch } from "./fake-node.ts";
import type { Change } from "./fake-node.ts";

freshIndexForEachTest();

const SKILL_TEXT = FILES[SKILL] as string;
const README = "README.md";
const README_TEXT = FILES[README] as string;

/** A text with some of its lines replaced. A line given as nothing is taken out. Lines count from 1. */
function edited(text: string, replaced: { readonly [line: number]: string | undefined }): string {
  const lines = text.split("\n").slice(0, -1);
  return lines.flatMap((line, at) => (Object.hasOwn(replaced, at + 1) ? (replaced[at + 1] ?? []) : line)).map((line) => `${line}\n`).join("");
}

/** The skill file without the hidden instruction on its line 3. */
const SKILL_FIXED = edited(SKILL_TEXT, { 3: undefined });

/** A patch record, as a person writes one by hand. */
function patchRecord(component: string, commit: string, findings: readonly (string | undefined)[]): { [field: string]: unknown } {
  return { version: "1", type: "patch", component, commit, findings: [...findings].sort(), model: "none" };
}

const patchPath = (component: string, id: string | undefined): string => `records/${component}/patch/${id}.json`;

/** The ID of the patch that replaces one content of a plain file with another. */
async function idOf(before: string, after: string, mode = "100644"): Promise<string> {
  return patchIdOf([{ oldBlob: await blobHash(before), oldMode: mode, newBlob: await blobHash(after), newMode: mode }]);
}

interface Published {
  readonly finding: string | undefined;
  readonly patch: string | undefined;
  readonly commit: string;
}

/**
 * Has a node publish a finding, push a patch commit to its fork and publish the patch
 * record for it. `cites` holds the fields of the finding that differ from the hidden
 * instruction on line 3 of the skill file.
 */
async function publishPatch(
  node: FakeNode,
  component: string,
  cites: { readonly [field: string]: unknown },
  changes: readonly Change[],
  made: { readonly parent?: string } = {},
): Promise<Published> {
  const [cited] = await node.publish(finding(component, cites));
  const commit = await node.patchCommit(component, changes, made);
  const [patch] = await node.publish(patchRecord(component, commit, [cited]));
  return { finding: cited, patch, commit };
}

/** A finding on one line of the readme. */
const onReadme = (line: number): { readonly [field: string]: unknown } => ({ location: { path: README, start: line, end: line } });

/** One index with one registered node behind `fetch` and the small component, ready. */
async function oneNode(): Promise<{ on: Bench; node: FakeNode; component: string }> {
  const on = bench();
  const node = new FakeNode(NODE_A);
  nodesBehindFetch(node);
  const component = await on.component();
  await on.registerNode(NODE_A);
  return { on, node, component };
}

/** The requests the index made to a node's patch route or its blob route. */
const asked = (node: FakeNode, route: "patch" | "blob"): string[] => node.requests.filter((url) => url.startsWith(`${node.url}/${route}?`));

/** The record IDs behind each patch entry of a view, over all its groups. */
const shown = (view: View): string[][] => view.patches.flatMap((group) => group.patches.map((entry) => entry.records.map(({ id }) => id)));

/** The looks at a patch record that wait in the queue. */
const looks = (on: Bench): { readonly node: string; readonly path: string }[] =>
  on.queue.waiting.flatMap(({ body }) => (body.kind === "patch" ? [{ node: body.node, path: body.path }] : []));

describe("a patch record and its commit (KTD7, KTD11)", () => {
  it("asks again after a while for a patch record published before its commit, and shows the patch as valid once the fork holds the commit", async () => {
    const { on, node, component } = await oneNode();
    const [cited] = await node.publish(finding(component));
    const commit = "5e".repeat(20);
    const record = patchRecord(component, commit, [cited]);
    const [patch] = await node.publish(record);
    await on.notice(NODE_A);
    // The sync stores the record and queues a look at its commit. That look finds no commit.
    await on.deliver();
    await on.deliver();

    expect(asked(node, "patch")).toEqual([`${NODE_A}/patch?component=${component}&commit=${commit}`]);
    expect(on.queue.waiting).toEqual([
      { body: { kind: "patch", node: NODE_A, path: patchPath(component, patch), tries: 1 }, delaySeconds: PATCH_WAIT_SECONDS, attempts: 1 },
    ]);
    const waiting = await on.view(component);
    expect(waiting.patches).toEqual([]);
    expect(waiting.pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);

    await node.patchCommit(component, [{ path: SKILL, content: SKILL_FIXED }], { commit });
    await on.drain();

    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([]);
    expect(view.viewVersion).toBeGreaterThan(waiting.viewVersion);
    // Kind, size, changed lines and patch ID are the index's own: the record declares none of them (KTD5).
    expect(view.patches).toEqual([
      {
        patches: [
          {
            patchId: await idOf(SKILL_TEXT, SKILL_FIXED),
            kind: "removes-only",
            size: 1,
            changes: [{ blob: await blobHash(SKILL_TEXT), hunks: [{ oldStart: 3, removed: 1, newStart: 3, added: 0 }] }],
            paths: [SKILL],
            records: [{ node: NODE_A, repo: "team", commit: node.head, path: patchPath(component, patch), id: patch, record }],
            rechecks: [],
            nodes: [NODE_A],
            confirmed: false,
          },
        ],
      },
    ]);
    expect(conforms(VIEW, view)).toBeUndefined();
  });

  it("stops asking after the set number of tries, and leaves the record pending", async () => {
    const { on, node, component } = await oneNode();
    const [cited] = await node.publish(finding(component));
    const [patch] = await node.publish(patchRecord(component, "5e".repeat(20), [cited]));
    await synced(on, NODE_A);

    expect(asked(node, "patch")).toHaveLength(PATCH_TRIES);
    expect(on.queue.waiting).toEqual([]);
    const view = await on.view(component);
    expect(view.pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
    expect(view.rejected).toEqual([]);
  });

  it("checks a patch record that waited for its component's copy once the copy is ready", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit: component });
    await on.registerNode(NODE_A);
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    await on.notice(NODE_A);
    // The import starts and the node is synced. The copy is not ready yet.
    await on.deliver();
    await on.deliver();
    expect((await on.view(component)).pending).toHaveLength(2);
    expect(asked(node, "patch")).toEqual([]);

    on.artifacts.finish();
    await on.drain();
    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(view.patches.map((group) => group.patches.map((entry) => entry.records.map(({ id }) => id)))).toEqual([[[patch]]]);
  });

  it("reads no content from its own copy while the node serves the commit and not the content it puts in place", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    node.respond = (url) => (url.pathname === "/blob" ? Response.json({ error: "not-found" }, { status: 404 }) : undefined);
    await on.notice(NODE_A);
    // The sync reads the cited file once, for the finding.
    await on.deliver();
    expect(on.artifacts.reads(`copy-${component}`)).toEqual({ blobs: 1 });

    await on.drain();
    // Every look asked the node for the new content, and none read the old content from the copy.
    expect(asked(node, "blob")).toHaveLength(PATCH_TRIES);
    expect(on.artifacts.reads(`copy-${component}`)).toEqual({ blobs: 1 });
    expect((await on.view(component)).pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
  });

  it("shows the same patches after a reset and a full sync of the nodes", async () => {
    const { on, node, component } = await oneNode();
    await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    await synced(on, NODE_A);
    const before = await on.view(component);
    expect(before.patches).toHaveLength(1);

    expect((await on.call("POST", "/reset", undefined, [RESET_HEADER, RESET_KEY])).status).toBe(200);
    expect((await on.view(component)).patches).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS held FROM patches").first()).toEqual({ held: 0 });

    // The reset queued a sync of the node, and the sync a look at the patch record's commit.
    await on.drain();
    expect((await on.view(component)).patches).toEqual(before.patches);
  });
});

describe("a patch record that still waits when its tries are spent or its look was lost (KTD11)", () => {
  it("checks a patch record at the retried sync when the queue took no look after the record was stored", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    await on.notice(NODE_A);
    // The sync stores both records, and then the queue takes no look at the patch record.
    on.queue.failures = 1;
    await on.deliver();
    expect(on.queue.waiting).toEqual([{ body: { kind: "node", node: NODE_A }, delaySeconds: 30, attempts: 2 }]);
    expect((await on.view(component)).pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);

    await on.drain();
    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(shown(view)).toEqual([[patch]]);
  });

  it("checks a patch record whose tries are spent when another node publishes the finding it names", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    // Team B patches a finding that Team A has not published yet.
    const cited = await recordId(finding(component));
    const commit = await other.patchCommit(component, [{ path: SKILL, content: SKILL_FIXED }]);
    const [patch] = await other.publish(patchRecord(component, commit, [cited]));
    await synced(on, NODE_B);
    // Every look found no valid finding, so none asked the node for the commit.
    expect(on.queue.sent.filter(({ body }) => body.kind === "patch")).toHaveLength(PATCH_TRIES);
    expect(asked(other, "patch")).toEqual([]);
    expect((await on.view(component)).pending).toEqual([{ node: NODE_B, hash: patch, type: "patch" }]);

    expect(await one.publish(finding(component))).toEqual([cited]);
    await synced(on, NODE_A);
    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(shown(view)).toEqual([[patch]]);
    expect(asked(other, "patch")).toHaveLength(1);
  });

  it("checks a patch record whose tries are spent at the next sync of its node, once the fork holds the commit", async () => {
    const { on, node, component } = await oneNode();
    const [cited] = await node.publish(finding(component));
    const commit = "5e".repeat(20);
    const [patch] = await node.publish(patchRecord(component, commit, [cited]));
    await synced(on, NODE_A);
    expect(asked(node, "patch")).toHaveLength(PATCH_TRIES);
    expect((await on.view(component)).pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);

    await node.patchCommit(component, [{ path: SKILL, content: SKILL_FIXED }], { commit });
    await synced(on, NODE_A);
    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(shown(view)).toEqual([[patch]]);
    expect(asked(node, "patch")).toHaveLength(PATCH_TRIES + 1);
  });

  it("looks once at a waiting patch record at each later sync of its node, and queues nothing more when it must still wait", async () => {
    const { on, node, component } = await oneNode();
    const [cited] = await node.publish(finding(component));
    const [patch] = await node.publish(patchRecord(component, "5e".repeat(20), [cited]));
    await synced(on, NODE_A);
    expect(asked(node, "patch")).toHaveLength(PATCH_TRIES);

    for (const sync of [1, 2]) {
      await on.notice(NODE_A);
      await on.deliver();
      expect(looks(on)).toEqual([{ node: NODE_A, path: patchPath(component, patch) }]);
      await on.deliver();
      // The fork still holds no commit, and the one look queued no other.
      expect(asked(node, "patch")).toHaveLength(PATCH_TRIES + sync);
      expect(on.queue.waiting).toEqual([]);
    }
    expect((await on.view(component)).pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
  });

  it("looks at another node's patch record when the finding it names is settled by a check of waiting records that then fails", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit: component });
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    // Two findings of Team A on two files. Waiting records are checked in the order of their IDs.
    const onSkill = { file: SKILL, text: SKILL_TEXT, changed: SKILL_FIXED, cites: {} };
    const onLine12 = { file: README, text: README_TEXT, changed: edited(README_TEXT, { 12: "line twelve" }), cites: onReadme(12) };
    const ids = await one.publish(finding(component, onSkill.cites), finding(component, onLine12.cites));
    const [first = "", last = ""] = [...ids].sort();
    const [checkedFirst, checkedLast] = ids[0] === first ? [onSkill, onLine12] : [onLine12, onSkill];
    // Team B patches the finding that is checked first.
    const commit = await other.patchCommit(component, [{ path: checkedFirst.file, content: checkedFirst.changed }]);
    const [patch] = await other.publish(patchRecord(component, commit, [first]));
    await on.notice(NODE_A);
    await on.notice(NODE_B);
    // The import starts and both nodes are synced. The look at the patch record finds no ready copy and queues no other.
    await on.deliver();
    await on.deliver();
    expect((await on.view(component)).pending).toHaveLength(3);
    expect(looks(on)).toEqual([]);

    // The copy is ready, and the read of the file that the second finding cites fails.
    on.artifacts.blobFaults.set(await blobHash(checkedLast.text), "INTERNAL_ERROR");
    on.artifacts.finish();
    await on.deliver();
    expect(looks(on)).toEqual([{ node: NODE_B, path: patchPath(component, patch) }]);
    await on.deliver();
    const partial = await on.view(component);
    expect(shown(partial)).toEqual([[patch]]);
    expect(partial.pending).toEqual([{ node: NODE_A, hash: last, type: "finding" }]);

    on.artifacts.blobFaults.clear();
    await on.drain();
    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(shown(view)).toEqual([[patch]]);
  });
});

describe("a patch commit the index rejects (R11, KTD6, KTD7)", () => {
  /** Expects the one patch record of a node to be listed as rejected work, and as nothing else. */
  async function expectRejected(on: Bench, component: string, patch: string | undefined, reason: string): Promise<void> {
    const view = await on.view(component);
    // Rejected work is four values only (KTD31).
    expect(view.rejected).toEqual([{ node: NODE_A, hash: patch, type: "patch", reason }]);
    expect(view.patches).toEqual([]);
    expect(view.pending).toEqual([]);
    expect(conforms(VIEW, view)).toBeUndefined();
  }

  it("covers AE2: stores a patch commit that also changes a file its finding does not cite as rejected with reason patch-out-of-scope", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [
      { path: SKILL, content: SKILL_FIXED },
      { path: README, content: edited(README_TEXT, { 1: "line one" }) },
    ]);
    await synced(on, NODE_A);

    await expectRejected(on, component, patch, "patch-out-of-scope");
    // The commit was refused before any of its content was read, and the record keeps no content.
    expect(asked(node, "blob")).toEqual([]);
    expect(await env.DB.prepare("SELECT state, reason, body FROM records WHERE type = 'patch'").first()).toEqual({
      state: "rejected",
      reason: "patch-out-of-scope",
      body: null,
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS held FROM patches").first()).toEqual({ held: 0 });
  });

  it("covers AE13: stores a patch commit that changes a cited line and a second line of the same file as rejected with reason patch-out-of-scope", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, onReadme(12), [{ path: README, content: edited(README_TEXT, { 12: "line twelve", 30: "line thirty" }) }]);
    await synced(on, NODE_A);

    await expectRejected(on, component, patch, "patch-out-of-scope");
  });

  it("covers AE14: stores a patch commit that adds one line of 9 KB as rejected with reason patch-too-large", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: edited(SKILL_TEXT, { 3: "x".repeat(9 * 1024) }) }]);
    await synced(on, NODE_A);

    await expectRejected(on, component, patch, "patch-too-large");
  });

  it("rejects a patch commit whose parent is not the pinned commit with reason wrong-parent", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED }], { parent: "7a".repeat(20) });
    await synced(on, NODE_A);

    await expectRejected(on, component, patch, "wrong-parent");
  });

  it("rejects a patch commit with reason blob-mismatch when a served blob does not match its listed hash", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    node.serveInstead(component, await blobHash(SKILL_FIXED), edited(SKILL_TEXT, { 3: "Keep it long." }));
    await synced(on, NODE_A);

    await expectRejected(on, component, patch, "blob-mismatch");
  });

  it("rejects a patch commit with reason too-large when a served blob has 300 KB", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: edited(SKILL_TEXT, { 3: "x".repeat(300 * 1024) }) }]);
    await synced(on, NODE_A);

    await expectRejected(on, component, patch, "too-large");
  });

  it("covers AE11: rejects a patch commit that rewrites one of two byte-identical copies with reason patch-incomplete, and takes one that rewrites both as one replacement", async () => {
    const { on, node, component } = await oneNode();
    const sends = { observation: "sends-data-to-host", host: SYNC_HOST, check: "code", location: { path: "scripts/sync.sh", start: 3, end: 3 } };
    const guarded = edited(SCRIPT_TEXT, { 3: "exit 0" });
    const oneCopy = await publishPatch(node, component, sends, [{ path: "scripts/sync.sh", content: guarded, mode: "100755" }]);
    await synced(on, NODE_A);
    await expectRejected(on, component, oneCopy.patch, "patch-incomplete");

    const bothCopies = await node.patchCommit(component, [
      { path: "scripts/sync.sh", content: guarded, mode: "100755" },
      { path: "tools/sync.sh", content: guarded, mode: "100755" },
    ]);
    await node.publish(patchRecord(component, bothCopies, [oneCopy.finding]));
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.patches).toHaveLength(1);
    expect(view.patches[0]?.patches).toMatchObject([
      {
        patchId: await idOf(SCRIPT_TEXT, guarded, "100755"),
        kind: "adds-or-changes",
        size: 2,
        changes: [{ blob: await blobHash(SCRIPT_TEXT), hunks: [{ oldStart: 3, removed: 1, newStart: 3, added: 1 }] }],
        paths: ["scripts/sync.sh", "tools/sync.sh"],
      },
    ]);
  });
});

describe("a patch record and the findings it names (KTD5)", () => {
  it("keeps a patch record whose finding is not valid out of the view", async () => {
    const { on, node, component } = await oneNode();
    // The finding cites lines the file does not have, so the index rejects it.
    const { finding: cited, patch } = await publishPatch(node, component, { location: { path: SKILL, start: 40, end: 41 } }, [{ path: SKILL, content: SKILL_FIXED }]);
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.patches).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: cited, type: "finding", reason: "lines-out-of-range" }]);
    // The commit is never asked for: with no valid finding there are no lines to hold it to.
    expect(view.pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
    expect(asked(node, "patch")).toEqual([]);
  });

  it("checks a patch once the finding it names has arrived from another node, and keeps it out of a view narrowed to nodes that do not hold that finding", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    // Team B patches a finding that only Team A publishes, and the index reads Team B first.
    const [cited] = await one.publish(finding(component));
    const commit = await other.patchCommit(component, [{ path: SKILL, content: SKILL_FIXED }]);
    const [patch] = await other.publish(patchRecord(component, commit, [cited]));
    await on.notice(NODE_B);
    await on.deliver();
    await on.deliver();
    expect((await on.view(component)).pending).toEqual([{ node: NODE_B, hash: patch, type: "patch" }]);

    await on.notice(NODE_A);
    await on.drain();
    const entries = async (teams?: readonly string[]) => (await on.view(component, teams)).patches.flatMap((group) => group.patches.map((entry) => entry.records.map(({ id }) => id)));
    expect(await entries()).toEqual([[patch]]);
    expect(await entries([NODE_A, NODE_B])).toEqual([[patch]]);
    // In Team B's own view the finding is not there, so the patch names no valid finding.
    const narrowed = await on.view(component, [NODE_B]);
    expect(narrowed.patches).toEqual([]);
    expect(narrowed.pending).toEqual([]);
    expect(narrowed.rejected).toEqual([]);
  });
});

describe("patches in the view (R16, R24)", () => {
  it("covers AE3: shows two patch records from two nodes with one patch ID as one entry with two organizations", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    // Each team deletes the same line in a commit of its own, for a finding of its own.
    const first = await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    const second = await publishPatch(other, component, { location: { path: SKILL, start: 2, end: 3 } }, [{ path: SKILL, content: SKILL_FIXED }]);
    expect(second.commit).not.toBe(first.commit);
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const view = await on.view(component);
    expect(view.patches).toHaveLength(1);
    expect(view.patches[0]?.patches).toHaveLength(1);
    const [entry] = view.patches[0]?.patches ?? [];
    expect(entry).toMatchObject({ patchId: await idOf(SKILL_TEXT, SKILL_FIXED), kind: "removes-only", size: 1, nodes: [NODE_A, NODE_B], confirmed: true });
    expect(entry?.records.map(({ node, id }) => [node, id]).sort()).toEqual([[NODE_A, first.patch], [NODE_B, second.patch]].sort());
    expect(conforms(VIEW, view)).toBeUndefined();

    // Counted again among the nodes a query lists (KTD38).
    const narrowed = await on.view(component, [NODE_B]);
    expect(narrowed.patches[0]?.patches).toMatchObject([{ nodes: [NODE_B], confirmed: false }]);
    expect(narrowed.patches[0]?.patches[0]?.records.map(({ id }) => id)).toEqual([second.patch]);
  });

  it("counts a node whose patch re-check says the patch resolves its finding, and no node whose re-check says it does not", async () => {
    const on = bench();
    const [one, other, third] = [new FakeNode(NODE_A), new FakeNode(NODE_B), new FakeNode(NODE_C)];
    nodesBehindFetch(one, other, third);
    const component = await on.component();
    for (const node of [NODE_A, NODE_B, NODE_C]) await on.registerNode(node);
    await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    const recheck = { version: "1", type: "patch-re-check", component, patch: await idOf(SKILL_TEXT, SKILL_FIXED), model: "none" };
    const [resolves] = await other.publish({ ...recheck, verdict: "resolves" });
    const [doesNot] = await third.publish({ ...recheck, verdict: "does-not-resolve" });
    for (const node of [NODE_A, NODE_B, NODE_C]) await synced(on, node);

    const [entry] = (await on.view(component)).patches[0]?.patches ?? [];
    expect(entry).toMatchObject({ nodes: [NODE_A, NODE_B], confirmed: true });
    expect(entry?.rechecks.map(({ node, id }) => [node, id]).sort()).toEqual([[NODE_B, resolves], [NODE_C, doesNot]].sort());
  });

  it("covers AE10: gives the same replacement published for two component commits one patch ID on both pages", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const first = await on.component();
    // A later commit of the component that leaves the skill file as it was.
    const later: Files = { ...FILES, [README]: `${README_TEXT}line 81\n` };
    const second = await on.component(later);
    expect(second).not.toBe(first);
    await on.registerNode(NODE_A);
    await publishPatch(node, first, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    await publishPatch(node, second, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    await synced(on, NODE_A);

    const idsOn = async (component: string): Promise<string[]> => (await on.view(component)).patches.flatMap((group) => group.patches.map(({ patchId }) => patchId));
    expect(await idsOn(first)).toEqual([await idOf(SKILL_TEXT, SKILL_FIXED)]);
    expect(await idsOn(second)).toEqual(await idsOn(first));
  });

  it("shows two patches that change adjacent lines of one block in one group as two entries, and a patch further down in a group of its own", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    const twelve = edited(README_TEXT, { 12: "line twelve" });
    const thirteen = edited(README_TEXT, { 13: "line thirteen" });
    const forty = edited(README_TEXT, { 40: undefined });
    await publishPatch(one, component, onReadme(12), [{ path: README, content: twelve }]);
    await publishPatch(other, component, onReadme(13), [{ path: README, content: thirteen }]);
    await publishPatch(other, component, onReadme(40), [{ path: README, content: forty }]);
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const view = await on.view(component);
    const shown = view.patches.map((group) => group.patches.map(({ patchId, nodes }) => ({ patchId, nodes })));
    const sideBySide = [
      { patchId: await idOf(README_TEXT, twelve), nodes: [NODE_A] },
      { patchId: await idOf(README_TEXT, thirteen), nodes: [NODE_B] },
    ].sort((a, b) => compare(a.patchId, b.patchId));
    const alone = [{ patchId: await idOf(README_TEXT, forty), nodes: [NODE_B] }];
    expect(shown).toHaveLength(2);
    expect(shown).toContainEqual(sideBySide);
    expect(shown).toContainEqual(alone);
    expect(conforms(VIEW, view)).toBeUndefined();
    // The same view on the next poll: its groups and entries come in a set order.
    expect(await on.view(component)).toEqual(view);
  });
});

describe("the demo's hand-made patch from the second team's node (KTD26)", () => {
  /** A file of `fixtures/`, as the Vitest config read it. */
  function fixture(path: string): string {
    const text = env.FIXTURES[path];
    if (text === undefined) throw new Error(`the fixtures hold no ${path}`);
    return text;
  }

  it("is listed as rejected work with reason patch-out-of-scope, and its finding as a valid finding", async () => {
    const made = JSON.parse(fixture("out-of-scope/COMMIT.json")) as { readonly component: string; readonly commit: string };
    const on = bench();
    const node = new FakeNode(NODE_B);
    nodesBehindFetch(node);
    // The demo plugin's first commit, under its own hash. Its two scripts may be run.
    const first = "demo-plugin/first/";
    const plugin: { [path: string]: Files[string] } = {};
    for (const path of Object.keys(env.FIXTURES).filter((held) => held.startsWith(first))) {
      const name = path.slice(first.length);
      plugin[name] = name.startsWith("scripts/") ? { content: fixture(path), mode: "100755" } : fixture(path);
    }
    const component = await on.component(plugin, made.component);
    expect(component).toBe(made.component);
    await on.registerNode(NODE_B);

    // The node is honest about the commit: it serves the one file the commit changes, as the fixture holds it.
    const changed = "out-of-scope/files/";
    const changes = Object.keys(env.FIXTURES).filter((held) => held.startsWith(changed)).map((path) => ({ path: path.slice(changed.length), content: fixture(path) }));
    await node.patchCommit(component, changes, { commit: made.commit });
    // The two record files go out as they are written, as `publish` pushes an outbox.
    const records = Object.keys(env.FIXTURES).filter((held) => held.startsWith("out-of-scope/records/") && held.endsWith(".json")).sort();
    for (const path of records) await node.push(path.slice("out-of-scope/".length), fixture(path));
    await synced(on, NODE_B);

    const [citedPath = "", patchFile = ""] = records;
    const idIn = (path: string): string => path.slice(path.lastIndexOf("/") + 1, -".json".length);
    const view = await on.view(component);
    expect(view.rejected).toEqual([{ node: NODE_B, hash: idIn(patchFile), type: "patch", reason: "patch-out-of-scope" }]);
    expect(view.patches).toEqual([]);
    expect(view.pending).toEqual([]);
    expect(view.findings.map((group) => group.findings.map(({ id }) => id))).toEqual([[idIn(citedPath)]]);
    expect(asked(node, "patch")).toEqual([`${NODE_B}/patch?component=${made.component}&commit=${made.commit}`]);
  });
});
