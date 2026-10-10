// Patch intake (R11, R16, R24): what the index does with a patch record. It asks the
// node for the commit, checks it against its own copy, stores it as valid or rejected,
// and shows the valid patches of a view in groups. Every commit here is made by hand
// behind a fake node.

import { DELETED_BLOB, DELETED_MODE, VIEW, canonicalJson, compare, conforms, patchId as patchIdOf, recordId } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PATCH_TRIES, PATCH_WAIT_SECONDS } from "../src/patches.ts";
import { PASS_RECORDS } from "../src/records.ts";
import { syncNode } from "../src/sync.ts";
import { BRANCH, FILES, NODE_A, NODE_B, NODE_C, RESET_HEADER, RESET_KEY, SCRIPT_TEXT, SKILL, START, SYNC_HOST, UPSTREAM, bench, demoPlugin, edited, finding, fixture, fixturesUnder, freshIndexForEachTest, patchRecord, publishPatch, synced } from "./bench.ts";
import type { Bench } from "./bench.ts";
import { blobHash } from "./fake-artifacts.ts";
import type { Files } from "./fake-artifacts.ts";
import { FakeNode, nodesBehindFetch } from "./fake-node.ts";

freshIndexForEachTest();

const SKILL_TEXT = FILES[SKILL] as string;
const README = "README.md";
const README_TEXT = FILES[README] as string;

/** The skill file without the hidden instruction on its line 3. */
const SKILL_FIXED = edited(SKILL_TEXT, { 3: undefined });

const patchPath = (component: string, id: string | undefined): string => `records/${component}/patch/${id}.json`;

/** The ID of the patch that replaces one content of a plain file with another. */
async function idOf(before: string, after: string, mode = "100644"): Promise<string> {
  return patchIdOf([{ oldBlob: await blobHash(before), oldMode: mode, newBlob: await blobHash(after), newMode: mode }]);
}

/** A finding on one line of the readme. */
const onReadme = (line: number): { readonly [field: string]: unknown } => ({ location: { path: README, start: line, end: line } });

/**
 * One index with one registered node behind `fetch` and a component, ready: the small
 * one unless files are given. `fetched` holds every URL the index asked for, of any host.
 */
async function oneNode(files?: Files): Promise<{ on: Bench; node: FakeNode; component: string; fetched: string[] }> {
  const on = bench();
  const node = new FakeNode(NODE_A);
  const fetched = nodesBehindFetch(node);
  const component = await on.component(files);
  await on.registerNode(NODE_A);
  return { on, node, component, fetched };
}

/**
 * One index with one registered node behind `fetch` and a component whose import has
 * started and will fail: the branch it names does not reach the commit, so the copy
 * finishes without it.
 */
async function failingImport(): Promise<{ on: Bench; node: FakeNode; component: string }> {
  const on = bench();
  const node = new FakeNode(NODE_A);
  nodesBehindFetch(node);
  const component = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
  await on.artifacts.host(UPSTREAM, "other", { [README]: "# Another branch\n" });
  await on.registerComponent({ url: UPSTREAM, branch: "other", commit: component });
  await on.deliver();
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

/**
 * What earlier syncs left: this many patch records of Team A's node that still wait, the
 * oldest first, received from `since` on. A look at one of them settles nothing and asks
 * the node for nothing. Returns their paths, which are in the same order.
 */
async function leftWaiting(component: string, count: number, since: number): Promise<string[]> {
  await env.DB.prepare(
    `WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?5 - 1)
     INSERT INTO records (node, path, component, type, state, hash, head, body, received_at)
     SELECT ?1, 'records/' || ?2 || '/patch/' || printf('%064x', i) || '.json', ?2, 'patch', 'pending', printf('%064x', i), ?3, '{}', ?4 + i FROM n`,
  )
    .bind(NODE_A, component, "0a".repeat(20), since, count)
    .run();
  return Array.from({ length: count }, (_, i) => patchPath(component, i.toString(16).padStart(64, "0")));
}

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

  it("rejects a patch record that was stored as pending just as its component failed", async () => {
    const { on, node, component } = await failingImport();
    // The node's one record of the component, so no other record waits for the copy.
    const [patch] = await node.publish(patchRecord(component, "5e".repeat(20), [await recordId(finding(component))]));
    // The component fails while the sync fetches the record, after it read the component as importing.
    node.onFile = async () => {
      node.onFile = undefined;
      on.artifacts.finish();
      await on.deliver();
    };
    expect(await syncNode(on.env, NODE_A)).toMatchObject({ ok: true, stored: 1 });
    expect((await on.view(component)).state).toBe("failed");

    await on.drain();
    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: patch, type: "patch", reason: "unknown-component" }]);
    expect(asked(node, "patch")).toEqual([]);
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

  it("stores nothing for a look that finishes after a reset dropped its record", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    await on.notice(NODE_A);
    await on.deliver();
    // The look has read its record and the node's answers. The reset comes as it opens the copy.
    const resets: number[] = [];
    on.artifacts.onGet = async () => {
      on.artifacts.onGet = undefined;
      resets.push((await on.call("POST", "/reset", undefined, [RESET_HEADER, RESET_KEY])).status);
    };
    await on.deliver();
    expect(resets).toEqual([200]);
    expect(asked(node, "blob")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM records) AS records, (SELECT COUNT(*) FROM patches) AS patches").first()).toEqual({ records: 0, patches: 0 });
    expect((await on.view(component)).patches).toEqual([]);

    // The reset queued a sync of the node. It stores the record again, and the look at it stores what it computed.
    await on.drain();
    expect(shown(await on.view(component))).toEqual([[patch]]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS held FROM patches").first()).toEqual({ held: 1 });
  });
});

describe("a patch record that still waits when its tries are spent or its look was lost (KTD11)", () => {
  it("looks again at no more waiting patch records in one sync than a pass reads", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await leftWaiting(component, 125, START);

    expect(await syncNode(on.env, NODE_A)).toMatchObject({ ok: true, stored: 0 });

    // A notice takes no key, so one sync of a node asks it for a bounded number of commits.
    const looks = on.queue.waiting.filter(({ body }) => body.kind === "patch");
    expect(looks).toHaveLength(PASS_RECORDS);
    expect(looks.every(({ body }) => body.kind === "patch" && body.tries === PATCH_TRIES - 1)).toBe(true);
    // They are taken in the order of their paths.
    expect(looks[0]?.body).toMatchObject({ path: `records/${component}/patch/${"0".repeat(64)}.json` });
  });

  it("looks at the waiting patch records of a node in turn over its syncs, a pass at each, and starts over after the last", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const paths = await leftWaiting(component, 125, START);
    const taken = (): string[] => looks(on).map(({ path }) => path);

    expect(await syncNode(on.env, NODE_A)).toMatchObject({ ok: true, stored: 0 });
    expect(taken()).toEqual(paths.slice(0, PASS_RECORDS));
    // Each look leaves its record waiting.
    await on.deliver();
    expect(on.queue.waiting).toEqual([]);

    // The next sync goes on after the last record that one took, and then starts over.
    expect(await syncNode(on.env, NODE_A)).toMatchObject({ ok: true, stored: 0 });
    expect(taken()).toEqual([...paths.slice(PASS_RECORDS), ...paths.slice(0, 2 * PASS_RECORDS - paths.length)]);
  });

  it("looks at the same waiting patch records again at the sync after one whose looks the queue did not take", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const paths = await leftWaiting(component, 125, START);

    on.queue.failures = 1;
    await expect(syncNode(on.env, NODE_A)).rejects.toThrow("the queue took no message");
    expect(on.queue.waiting).toEqual([]);

    expect(await syncNode(on.env, NODE_A)).toMatchObject({ ok: true, stored: 0 });
    expect(looks(on).map(({ path }) => path)).toEqual(paths.slice(0, PASS_RECORDS));
  });

  it("checks a patch record that waits behind a full pass of others at a later sync of its node, once the fork holds the commit", async () => {
    const { on, node, component } = await oneNode();
    const [cited] = await node.publish(finding(component));
    const commit = "5e".repeat(20);
    const [patch] = await node.publish(patchRecord(component, commit, [cited]));
    await synced(on, NODE_A);
    expect(asked(node, "patch")).toHaveLength(PATCH_TRIES);
    // A full pass of older patch records of the node waits too, and no look settles one of them.
    await leftWaiting(component, PASS_RECORDS, START - PASS_RECORDS);
    await node.patchCommit(component, [{ path: SKILL, content: SKILL_FIXED }], { commit });

    // One sync looks at a pass of waiting records, and the record is not among them.
    await synced(on, NODE_A);
    expect(asked(node, "patch")).toHaveLength(PATCH_TRIES);
    expect((await on.view(component)).pending).toHaveLength(PASS_RECORDS + 1);

    // The next sync goes on after them.
    await synced(on, NODE_A);
    const view = await on.view(component);
    expect(shown(view)).toEqual([[patch]]);
    expect(view.pending).toHaveLength(PASS_RECORDS);
    expect(asked(node, "patch")).toHaveLength(PATCH_TRIES + 1);
  });

  it("queues the look at a patch record that a sync stored before a read of the copy failed for a later component", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    // Two commits of the component. They share the skill file, and each has a readme of its own.
    const laterReadme = `${README_TEXT}line 81\n`;
    const first = await on.component();
    const second = await on.component({ ...FILES, [README]: laterReadme });
    await on.registerNode(NODE_A);
    // A pass takes the files in the order of their paths, so every record of one commit comes before the other's.
    const [early = "", late = ""] = [first, second].sort();
    const readme = early === first ? README_TEXT : laterReadme;
    const { patch } = await publishPatch(node, early, onReadme(12), [{ path: README, content: edited(readme, { 12: "line twelve" }) }]);
    const [cited] = await node.publish(finding(late));
    // Only the finding on the later commit cites the skill file, and the read of it fails.
    on.artifacts.blobFaults.set(await blobHash(SKILL_TEXT), "INTERNAL_ERROR");
    await on.notice(NODE_A);
    await on.deliver();

    // The sync threw, so its message waits to be tried again. The look at the patch record it stored is queued.
    expect(on.queue.waiting).toEqual([
      { body: { kind: "patch", node: NODE_A, path: patchPath(early, patch), tries: 0 }, delaySeconds: 0, attempts: 1 },
      { body: { kind: "node", node: NODE_A }, delaySeconds: 30, attempts: 2 },
    ]);
    expect((await on.view(early)).pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);

    // The look checks the patch while the sync still fails.
    await on.deliver();
    expect(shown(await on.view(early))).toEqual([[patch]]);
    expect((await on.view(late)).findings).toEqual([]);

    on.artifacts.blobFaults.clear();
    await on.drain();
    expect((await on.view(late)).findings.flatMap((group) => group.findings.map(({ id }) => id))).toEqual([cited]);
  });

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

  it("rejects a patch record that waits for a failed component at the node's next sync, when the sync that stored it could queue no look", async () => {
    const { on, node, component } = await failingImport();
    const [patch] = await node.publish(patchRecord(component, "5e".repeat(20), [await recordId(finding(component))]));
    // The component fails while the sync fetches the record. Then the queue takes no message from the sync.
    node.onFile = async () => {
      node.onFile = undefined;
      on.artifacts.finish();
      await on.deliver();
      on.queue.failures = 1;
    };
    await expect(syncNode(on.env, NODE_A)).rejects.toThrow("the queue took no message");
    expect((await on.view(component)).pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
    expect(on.queue.waiting).toEqual([]);

    // The sync is tried again. It finds no file it has not read, and the record still waits.
    expect(await syncNode(on.env, NODE_A)).toEqual({ ok: true, head: node.head, stored: 0, more: false });
    await on.drain();
    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: patch, type: "patch", reason: "unknown-component" }]);
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

describe("a patch commit that puts no new content in place (KTD4)", () => {
  it("shows a patch that deletes a file whose every line its finding cites, and asks the node for no blob", async () => {
    const { on, node, component } = await oneNode();
    // The skill file has four lines.
    const { patch } = await publishPatch(node, component, { location: { path: SKILL, start: 1, end: 4 } }, [{ path: SKILL }]);
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([]);
    expect(shown(view)).toEqual([[patch]]);
    const blob = await blobHash(SKILL_TEXT);
    expect(view.patches[0]?.patches).toMatchObject([
      {
        patchId: await patchIdOf([{ oldBlob: blob, oldMode: "100644", newBlob: DELETED_BLOB, newMode: DELETED_MODE }]),
        kind: "removes-only",
        size: 4,
        changes: [{ blob, hunks: [{ oldStart: 1, removed: 4, added: 0 }] }],
        paths: [SKILL],
      },
    ]);
    expect(conforms(VIEW, view)).toBeUndefined();
    // A deletion puts no content in place, so there is none to ask the node for.
    expect(asked(node, "patch")).toHaveLength(1);
    expect(asked(node, "blob")).toEqual([]);
  });

  it("shows a patch that only changes the mode of a cited file, and asks the node for no blob", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_TEXT, mode: "100755" }]);
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([]);
    expect(shown(view)).toEqual([[patch]]);
    const blob = await blobHash(SKILL_TEXT);
    // A changed mode is a change, and no line is one.
    expect(view.patches[0]?.patches).toMatchObject([
      {
        patchId: await patchIdOf([{ oldBlob: blob, oldMode: "100644", newBlob: blob, newMode: "100755" }]),
        kind: "adds-or-changes",
        size: 0,
        changes: [{ blob, hunks: [] }],
        paths: [SKILL],
      },
    ]);
    expect(conforms(VIEW, view)).toBeUndefined();
    // The content is the copy's own, so there is none to ask the node for.
    expect(asked(node, "patch")).toHaveLength(1);
    expect(asked(node, "blob")).toEqual([]);
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

  it.each(["oversize", "MEMORY_LIMIT"] as const)(
    "rejects a patch commit with reason too-large when a read of the content it replaces gives %s in the index's own copy",
    async (fault) => {
      const { on, node, component } = await oneNode();
      const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
      await on.notice(NODE_A);
      // The sync reads the skill file for the finding. After that the copy hands it over no more.
      await on.deliver();
      on.artifacts.blobFaults.set(await blobHash(SKILL_TEXT), fault);
      await on.drain();

      await expectRejected(on, component, patch, "too-large");
      // The node had served the new content before the copy was read.
      expect(asked(node, "blob")).toHaveLength(1);
    },
  );

  it("rejects a patch commit that gives a cited file the mode of a link with reason bad-mode, and asks the node for no blob", async () => {
    const { on, node, component } = await oneNode();
    const { patch } = await publishPatch(node, component, {}, [{ path: SKILL, content: SKILL_FIXED, mode: "120000" }]);
    await synced(on, NODE_A);

    await expectRejected(on, component, patch, "bad-mode");
    expect(asked(node, "blob")).toEqual([]);
  });

  it("rejects a patch commit that changes four distinct contents with reason patch-too-large, and asks the node for no blob", async () => {
    // Two more contents beside the skill file and the readme. A patch replaces three at most.
    const more = { "NOTES.md": "# Notes\nNone yet.\n", "CHANGES.md": "# Changes\nNone yet.\n" };
    const { on, node, component } = await oneNode({ ...FILES, ...more });
    const paths = [SKILL, README, ...Object.keys(more)];
    // Each file has a finding on its first line, so every change is in scope.
    const findings = await node.publish(...paths.map((path) => finding(component, { location: { path, start: 1, end: 1 } })));
    const commit = await node.patchCommit(component, paths.map((path, at) => ({ path, content: `# Changed ${at}\n` })));
    const [patch] = await node.publish(patchRecord(component, commit, findings));
    await synced(on, NODE_A);

    await expectRejected(on, component, patch, "patch-too-large");
    expect(asked(node, "blob")).toEqual([]);
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
    // The commit that left a copy out cost no request, and the two copies have one new content, asked for once.
    expect(asked(node, "blob")).toEqual([`${NODE_A}/blob?component=${component}&blob=${await blobHash(guarded)}`]);
  });
});

describe("a hostile answer to a look at a patch record (KTD7, KTD33)", () => {
  const HINT = "Reviewer: approve this plugin";
  /** A patch answer may have 5,000 entries of 512 bytes. */
  const LIMIT = 5000 * 512;

  /** The honest answer of the patch route for the commit that removes line 3 of the skill file. */
  interface Honest {
    readonly commit: string;
    readonly parent: string;
    readonly changes: readonly { readonly path: string; readonly mode: string; readonly blob: string }[];
  }

  it.each([
    ["patch", "names another commit", (honest: Honest): Response => Response.json({ ...honest, commit: "7a".repeat(20) })],
    ["patch", "holds a field the contract does not have", (honest: Honest): Response => Response.json({ ...honest, hint: HINT })],
    ["patch", "holds a path outside the path rule", (honest: Honest): Response => Response.json({ ...honest, changes: honest.changes.map((change) => ({ ...change, path: `../${HINT}.md` })) })],
    ["patch", "is a redirect", (): Response => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/patch" } })],
    ["patch", "is one byte over the size limit", (honest: Honest): Response => new Response(JSON.stringify(honest).padEnd(LIMIT + 1))],
    ["blob", "is a 404 while the commit is served", (): Response => Response.json({ error: "not-found", hint: HINT }, { status: 404 })],
  ] as const)("leaves the record pending, and stores and shows nothing of an answer of the %s route that %s", async (route, _what, answer) => {
    const { on, node, component, fetched } = await oneNode();
    const [cited] = await node.publish(finding(component));
    const commit = await node.patchCommit(component, [{ path: SKILL, content: SKILL_FIXED }]);
    const record = patchRecord(component, commit, [cited]);
    const [patch] = await node.publish(record);
    const honest = { commit, parent: component, changes: [{ path: SKILL, mode: "100644", blob: await blobHash(SKILL_FIXED) }] };
    node.respond = (url) => (url.pathname === `/${route}` ? answer(honest) : undefined);
    await synced(on, NODE_A);

    // Every look asked, and none took the answer.
    expect(asked(node, "patch")).toHaveLength(PATCH_TRIES);
    expect(asked(node, "blob")).toHaveLength(route === "blob" ? PATCH_TRIES : 0);
    // A redirect is followed nowhere.
    expect(fetched.every((url) => url.startsWith(`${NODE_A}/`))).toBe(true);
    const view = await on.view(component);
    expect(view.pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
    expect(view.patches).toEqual([]);
    expect(view.rejected).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/Reviewer|approve|hint|elsewhere/i);
    // The record's row is as the sync wrote it, and nothing was computed for it.
    expect(await env.DB.prepare("SELECT state, reason, body FROM records WHERE type = 'patch'").first()).toEqual({ state: "pending", reason: null, body: canonicalJson(record) });
    expect(await env.DB.prepare("SELECT COUNT(*) AS held FROM patches").first()).toEqual({ held: 0 });

    // The same record is checked at the next sync, once the node answers as the contract says.
    node.respond = undefined;
    await synced(on, NODE_A);
    expect(shown(await on.view(component))).toEqual([[patch]]);
  });
});

describe("a patch record and the findings it names (KTD5)", () => {
  it("takes a patch that names two findings and changes the lines that both cite", async () => {
    const { on, node, component } = await oneNode();
    const findings = await node.publish(finding(component, onReadme(12)), finding(component, onReadme(30)));
    // The same commit is out of scope for a patch that names only the finding on line 12 (AE13).
    const changed = edited(README_TEXT, { 12: "line twelve", 30: "line thirty" });
    const commit = await node.patchCommit(component, [{ path: README, content: changed }]);
    const [patch] = await node.publish(patchRecord(component, commit, findings));
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([]);
    expect(shown(view)).toEqual([[patch]]);
    expect(view.patches[0]?.patches).toMatchObject([{ patchId: await idOf(README_TEXT, changed), kind: "adds-or-changes", size: 4, paths: [README] }]);
  });

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

  it("shows a patch re-check nowhere when its patch ID matches no patch of the view", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    // Team B says that a patch resolves its finding. No patch of the component has that ID.
    const [stray] = await other.publish({ version: "1", type: "patch-re-check", component, patch: "ab".repeat(32), verdict: "resolves", model: "none" });
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    expect(await env.DB.prepare("SELECT state FROM records WHERE hash = ?").bind(stray).first()).toEqual({ state: "valid" });
    const view = await on.view(component);
    expect(view.patches).toHaveLength(1);
    expect(view.patches[0]?.patches).toMatchObject([{ rechecks: [], nodes: [NODE_A], confirmed: false }]);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(stray);
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
  it("is listed as rejected work with reason patch-out-of-scope, and its finding as a valid finding", async () => {
    const made = JSON.parse(fixture("out-of-scope/COMMIT.json")) as { readonly component: string; readonly commit: string };
    const on = bench();
    const node = new FakeNode(NODE_B);
    nodesBehindFetch(node);
    // The demo plugin's first commit, under its own hash.
    const component = await on.component(demoPlugin(), made.component);
    expect(component).toBe(made.component);
    await on.registerNode(NODE_B);

    // The node is honest about the commit: it serves the one file the commit changes, as the fixture holds it.
    const changed = "out-of-scope/files/";
    const changes = fixturesUnder(changed).map((path) => ({ path: path.slice(changed.length), content: fixture(path) }));
    await node.patchCommit(component, changes, { commit: made.commit });
    // The two record files go out as they are written, as `publish` pushes an outbox.
    const records = fixturesUnder("out-of-scope/records/").filter((held) => held.endsWith(".json"));
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
