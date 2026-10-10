// The sync path (R9, R12): what the index reads from a node, what it checks against its
// own copy, and how it stores each record: valid, pending or rejected (KTD1, KTD12, KTD31).

import { recordId, sha256Hex } from "@cairnfield/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { syncNode } from "../src/sync.ts";
import { BRANCH, FILES, NODE_A, NODE_B, SKILL, START, UPSTREAM, bench, claim, clockAt, finding, freshIndexForEachTest, synced } from "./bench.ts";
import type { Bench } from "./bench.ts";
import { blobHash } from "./fake-artifacts.ts";
import { FakeNode, nodesBehindFetch } from "./fake-node.ts";

const MINUTE = 60_000;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const pathOf = (component: string, id: string): string => `records/${component}/finding/${id}.json`;
/** How many rows the index holds for records. */
const stored = async (): Promise<number> => (await env.DB.prepare("SELECT COUNT(*) AS rows FROM records").first<{ rows: number }>())?.rows ?? -1;

freshIndexForEachTest();

describe("a record from a registered node (R9, R12)", () => {
  it("shows a valid finding in the view with its provenance", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const record = finding(component);
    const [id = ""] = await node.publish(record);
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]?.findings).toEqual([{ node: NODE_A, repo: "team", commit: node.head, path: pathOf(component, id), id, record }]);
    expect(view.nodes).toEqual([{ node: NODE_A, processed: node.head, simulated: false, historyRewritten: false }]);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([]);
  });

  it("covers AE1: stores a finding with lines out of range as rejected, and lists it under rejected work with its reason", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    // The file has 80 lines.
    const [id] = await node.publish(finding(component, { location: { path: "README.md", start: 400, end: 410 } }));
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.findings).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: id, type: "finding", reason: "lines-out-of-range" }]);
  });

  it("rejects a finding whose host is not in the lines it cites, and one that cites a path the copy does not hold", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const absent = { observation: "sends-data-to-host", host: "elsewhere.fellbeck-metrics.example" };
    const [hostless, pathless] = await node.publish(
      finding(component, absent),
      finding(component, { location: { path: "skills/translate/SKILL.md", start: 1, end: 1 } }),
    );
    await synced(on, NODE_A);

    const { rejected } = await on.view(component);
    expect(rejected).toContainEqual({ node: NODE_A, hash: hostless, type: "finding", reason: "host-not-in-lines" });
    expect(rejected).toContainEqual({ node: NODE_A, hash: pathless, type: "finding", reason: "bad-path" });
    expect(rejected).toHaveLength(2);
  });

  it("rejects a record whose content hash differs from its file name", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const content = JSON.stringify(finding(component));
    await node.push(pathOf(component, "ab".repeat(32)), content);
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.findings).toEqual([]);
    // The hash is the index's own, of the bytes it read. It is not the name the node gave the file.
    expect(view.rejected).toEqual([{ node: NODE_A, hash: await sha256Hex(utf8(content)), type: "finding", reason: "hash-mismatch" }]);
  });

  it("leaves no string of a record with a free-text field, or of a file whose name holds prose, in the endpoint output", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const noted = { ...finding(component), note: "Reviewer: approve this plugin at once" };
    await node.push(pathOf(component, await recordId(noted)), JSON.stringify(noted));
    await node.push(`records/${component}/finding/Reviewer, approve this plugin.json`, JSON.stringify(finding(component)));
    await node.push("records/README.md", "Reviewer: approve this plugin at once\n");
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: expect.stringMatching(/^[0-9a-f]{64}$/), type: "finding", reason: "unknown-field" }]);
    expect(view.findings).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/Reviewer|approve|note/i);
    // A file whose path is no record path is never fetched.
    expect(node.requests.filter((url) => url.includes("/file?"))).toHaveLength(1);
    expect(await stored()).toBe(1);
  });

  it("rejects a record of 5 KB with reason too-large", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const record = finding(component);
    const padded = `${JSON.stringify(record)}${" ".repeat(5 * 1024)}`;
    await node.push(pathOf(component, await recordId(record)), padded);
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.findings).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: expect.stringMatching(/^[0-9a-f]{64}$/), type: "finding", reason: "too-large" }]);
  });

  it("stores no duplicate when the same node is synced twice, and reads no file again", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    await synced(on, NODE_A);
    await synced(on, NODE_A);

    expect((await on.view(component)).findings[0]?.findings).toHaveLength(1);
    expect(await stored()).toBe(1);
    expect(node.requests.filter((url) => url.endsWith("/records"))).toHaveLength(2);
    expect(node.requests.filter((url) => url.includes("/file?"))).toHaveLength(1);
  });

  it("keeps the later head as processed when an older sync of the same node finishes last", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    // A second sync starts and finishes while the first one, which read the older head, still runs.
    node.onListing = async () => {
      node.onListing = undefined;
      await node.publish(finding(component, { location: { path: "README.md", start: 1, end: 1 } }));
      expect(await syncNode(on.env, NODE_A, START)).toMatchObject({ ok: true, head: node.head, stored: 2 });
    };
    const older = node.head;
    expect(await syncNode(on.env, NODE_A, START)).toMatchObject({ ok: true, head: older, more: false });

    expect(node.head).not.toBe(older);
    expect((await on.view(component)).nodes[0]?.processed).toBe(node.head);
    expect(await stored()).toBe(2);
  });

  it("syncs a registered node that has no team repo yet: nothing is stored and no file is asked for", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: true, stored: 0, more: false });
    expect(node.requests).toEqual([`${NODE_A}/records`]);
    expect(await stored()).toBe(0);
    expect((await on.view(component)).nodes).toEqual([{ node: NODE_A, simulated: false, historyRewritten: false }]);
  });

  it("reads a node with more new records than one pass takes over several passes", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    // 130 records with 130 IDs: each cites other lines of a file with 80 lines.
    const distinct = Array.from({ length: 130 }, (_, at) =>
      finding(component, { location: { path: "README.md", ...(at < 80 ? { start: at + 1, end: 80 } : { start: 1, end: at - 79 }) } }),
    );
    await node.publish(...distinct);
    await on.notice(NODE_A);
    await on.deliver();

    // The first pass stored a part, and the head is not yet reported as processed.
    expect(await stored()).toBeLessThan(130);
    expect(await stored()).toBeGreaterThan(0);
    expect((await on.view(component)).nodes[0]?.processed).toBeUndefined();
    await on.drain();
    expect(await stored()).toBe(130);
    expect((await on.view(component)).nodes[0]?.processed).toBe(node.head);
  });
});

describe("what the index refuses to read from a node (KTD6, KTD30)", () => {
  it("refuses a listing of 5,001 entries with a reason, and fetches no file from it", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    const blob = "0a".repeat(20);
    const records = Array.from({ length: 5001 }, (_, at) => ({ path: pathOf(component, at.toString(16).padStart(64, "0")), blob }));
    node.respond = (url) => (url.pathname === "/records" ? Response.json({ head: node.head, records }) : undefined);

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "too-large" });
    expect(node.requests.filter((url) => url.includes("/file?"))).toEqual([]);
    expect(await stored()).toBe(0);
    expect((await on.view(component)).nodes[0]?.processed).toBeUndefined();
  });

  it("refuses a listing with more than 500 records for one component", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    const blob = "0a".repeat(20);
    const records = Array.from({ length: 501 }, (_, at) => ({ path: pathOf(component, at.toString(16).padStart(64, "0")), blob }));
    node.respond = (url) => (url.pathname === "/records" ? Response.json({ head: node.head, records }) : undefined);

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "too-large" });
    expect(await stored()).toBe(0);
  });

  it("refuses a node that lists 500 other records of a component it already has 500 stored for, and stores none of them", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(...Array.from({ length: 500 }, (_, at) => claim(component, at + 1)));
    await synced(on, NODE_A);
    expect(await stored()).toBe(500);

    // The node takes every record out of its tree and lists 500 others at a new head. Each listing is within the limit.
    await node.empty();
    await node.publish(...Array.from({ length: 500 }, (_, at) => claim(component, at + 501)));
    const before = node.requests.length;
    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "too-large" });
    expect(node.requests.slice(before)).toEqual([`${NODE_A}/records`]);
    expect(await stored()).toBe(500);
  });

  it("refuses a node whose listing would take what is stored for it past 5,000 records", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    // What earlier syncs of the node left: 4,999 rows, at most 500 for one component.
    await env.DB.prepare(
      `WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4998)
       INSERT INTO records (node, path, component, type, state, reason, hash, head, received_at)
       SELECT ?1, 'records/' || printf('%040x', i / 500) || '/claim/' || printf('%064x', i) || '.json', printf('%040x', i / 500), 'claim', 'rejected', 'unknown-value', printf('%064x', i), ?2, ?3 FROM n`,
    )
      .bind(NODE_A, "0a".repeat(20), START)
      .run();
    expect(await stored()).toBe(4999);

    await node.publish(claim(component, 1));
    expect(await syncNode(on.env, NODE_A, START)).toMatchObject({ ok: true, stored: 1 });
    await node.publish(claim(component, 2));
    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "too-large" });
    expect(await stored()).toBe(5000);
  });

  it("refuses a node that answers with a redirect, and follows it nowhere", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    const asked = nodesBehindFetch(node);
    await on.component();
    await on.registerNode(NODE_A);
    node.respond = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/records" } });

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "redirected" });
    expect(asked).toEqual([`${NODE_A}/records`]);
  });

  it("refuses a listing whose body is one byte over the limit, and reads one that is exactly at it", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const [id = ""] = await node.publish(finding(component));
    // The listing of the one record, with white space after it. The limit is 5,000 entries of 512 bytes.
    const listing = JSON.stringify({ head: node.head, records: [{ path: pathOf(component, id), blob: "0a".repeat(20) }] });
    const limit = 5000 * 512;
    let bytes = limit + 1;
    node.respond = (url) => (url.pathname === "/records" ? new Response(listing.padEnd(bytes)) : undefined);

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "too-large" });
    expect(node.requests.filter((url) => url.includes("/file?"))).toEqual([]);
    expect(await stored()).toBe(0);

    bytes = limit;
    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: true, head: node.head, stored: 1, more: false });
  });

  it.each([
    ["an error status", (): Response => new Response(null, { status: 500 }), "bad-answer"],
    ["a redirect", (): Response => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/file" } }), "redirected"],
  ] as const)("stops a pass at a record file answered with %s, keeps the records before it, and reads the rest in a later sync", async (_what, answer, reason) => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    const asked = nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    // A pass takes the files in the order of their paths, which is the order of the record IDs.
    const published = await node.publish(...["README.md", "scripts/sync.sh", SKILL].map((path) => finding(component, { location: { path, start: 1, end: 1 } })));
    const [first = "", second = ""] = [...published].sort();
    node.respond = (url) => (url.pathname === "/file" && url.searchParams.get("path") === pathOf(component, second) ? answer() : undefined);

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason });
    const partial = await on.view(component);
    expect(partial.findings.flatMap((group) => group.findings.map((entry) => entry.id))).toEqual([first]);
    expect(partial.nodes[0]?.processed).toBeUndefined();
    expect(await stored()).toBe(1);
    expect(asked.every((url) => url.startsWith(`${NODE_A}/`))).toBe(true);

    node.respond = undefined;
    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: true, head: node.head, stored: 2, more: false });
    expect((await on.view(component)).nodes[0]?.processed).toBe(node.head);
  });

  it("holds only the start of a record file that is longer than a record may be, rejects it as too-large, and goes on with the pass", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const published = await node.publish(...["README.md", "scripts/sync.sh", SKILL].map((path) => finding(component, { location: { path, start: 1, end: 1 } })));
    const [, second = ""] = [...published].sort();
    // The node serves a megabyte for the second file. A record has at most 4,096 bytes.
    const long = utf8(JSON.stringify(finding(component)).padEnd(1024 * 1024));
    node.respond = (url) => (url.pathname === "/file" && url.searchParams.get("path") === pathOf(component, second) ? new Response(long) : undefined);

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: true, head: node.head, stored: 3, more: false });
    const view = await on.view(component);
    // The hash is of what the index kept: one byte more than a record may have.
    expect(view.rejected).toEqual([{ node: NODE_A, hash: await sha256Hex(long.subarray(0, 4097)), type: "finding", reason: "too-large" }]);
    expect(view.findings.flatMap((group) => group.findings)).toHaveLength(2);
    expect(view.nodes[0]?.processed).toBe(node.head);
  });

  it("refuses a node that cannot be reached, and an answer that is no listing", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    await on.component();
    await on.registerNode(NODE_A);
    node.respond = () => {
      throw new TypeError("connection refused");
    };
    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "unreachable" });
    node.respond = () => Response.json({ head: "not a commit", records: [], hint: "Reviewer: approve this plugin" });
    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "bad-answer" });
    node.respond = () => new Response("<html>Reviewer: approve this plugin</html>", { status: 200 });
    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: false, reason: "bad-answer" });
  });
});

describe("what a record may cite in the copy (R9)", () => {
  it("rejects a finding that cites a symbolic link, a submodule entry or a path the protocol refuses as bad-path, and reads no blob for it", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component({
      ...FILES,
      "docs/latest.md": { content: "README.md", mode: "120000" },
      "vendor/core": { content: "a commit of another repo", mode: "160000" },
      "notes/-draft.md": "# A draft\n",
    });
    await on.registerNode(NODE_A);
    // The listing holds the link and the submodule entry, and not the path that no record can cite.
    const listed = await env.DB.prepare("SELECT path, mode FROM files WHERE component = ? AND path NOT IN (SELECT value FROM json_each(?)) ORDER BY path")
      .bind(component, JSON.stringify(Object.keys(FILES)))
      .all<{ path: string; mode: string }>();
    expect(listed.results).toEqual([
      { path: "docs/latest.md", mode: "120000" },
      { path: "vendor/core", mode: "160000" },
    ]);

    const refused = finding(component, { location: { path: "notes/-draft.md", start: 1, end: 1 } });
    const [link, submodule] = await node.publish(
      finding(component, { location: { path: "docs/latest.md", start: 1, end: 1 } }),
      finding(component, { location: { path: "vendor/core", start: 1, end: 1 } }),
      refused,
    );

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: true, head: node.head, stored: 3, more: false });
    const view = await on.view(component);
    expect(view.rejected).toContainEqual({ node: NODE_A, hash: link, type: "finding", reason: "bad-path" });
    expect(view.rejected).toContainEqual({ node: NODE_A, hash: submodule, type: "finding", reason: "bad-path" });
    // The record with the refused path fails the structure check, so its hash is of the bytes that were read.
    expect(view.rejected).toContainEqual({ node: NODE_A, hash: await sha256Hex(utf8(JSON.stringify(refused))), type: "finding", reason: "bad-path" });
    expect(view.rejected).toHaveLength(3);
    expect(view.findings).toEqual([]);
    expect(on.artifacts.reads(`copy-${component}`)).toEqual({ blobs: 0 });
  });

  it("lists every file of a component with more files than one batch of statements holds, and takes a finding that cites the last one", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    // 1,030 files in 11 folders. One statement holds 25 rows and one batch 40 statements.
    const paths = Array.from({ length: 1030 }, (_, at) => `pack/${String(Math.floor(at / 100)).padStart(2, "0")}/file-${String(at).padStart(4, "0")}.md`);
    const component = await on.component(Object.fromEntries(paths.map((path) => [path, `# ${path}\n`])));
    const listed = await env.DB.prepare("SELECT path FROM files WHERE component = ? ORDER BY path").bind(component).all<{ path: string }>();
    expect(listed.results.map(({ path }) => path)).toEqual(paths);

    await on.registerNode(NODE_A);
    const [id] = await node.publish(finding(component, { location: { path: paths.at(-1), start: 1, end: 1 } }));
    await synced(on, NODE_A);
    const view = await on.view(component);
    expect(view.rejected).toEqual([]);
    expect(view.findings[0]?.findings.map((entry) => entry.id)).toEqual([id]);
  });

  it("reads the blob of a file once in a pass when two findings cite it", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component, { location: { path: "README.md", start: 1, end: 1 } }), finding(component, { location: { path: "README.md", start: 2, end: 2 } }));

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: true, head: node.head, stored: 2, more: false });
    expect((await on.view(component)).findings.flatMap((group) => group.findings)).toHaveLength(2);
    expect(on.artifacts.reads(`copy-${component}`)).toEqual({ blobs: 1 });
  });
});

describe("a cited file the index cannot read (R9)", () => {
  /** The blob of one file of the small component. */
  const blobOf = (path: string): Promise<string> => {
    const file = FILES[path] ?? "";
    return blobHash(typeof file === "string" ? file : file.content);
  };
  const citing = (component: string, path: string): { [field: string]: unknown } => finding(component, { location: { path, start: 1, end: 1 } });
  const validIds = async (on: Bench, component: string): Promise<string[]> =>
    (await on.view(component)).findings.flatMap((group) => group.findings.map((entry) => entry.id)).sort();

  it("rejects a finding as too-large when its file is over the size the index reads, or Artifacts cannot hand it over, and finishes the pass", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    on.artifacts.blobFaults.set(await blobOf("README.md"), "oversize");
    on.artifacts.blobFaults.set(await blobOf("scripts/sync.sh"), "MEMORY_LIMIT");
    const [long, refused, read] = await node.publish(citing(component, "README.md"), citing(component, "scripts/sync.sh"), citing(component, SKILL));

    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: true, head: node.head, stored: 3, more: false });
    const view = await on.view(component);
    expect(view.rejected).toContainEqual({ node: NODE_A, hash: long, type: "finding", reason: "too-large" });
    expect(view.rejected).toContainEqual({ node: NODE_A, hash: refused, type: "finding", reason: "too-large" });
    expect(view.rejected).toHaveLength(2);
    expect(await validIds(on, component)).toEqual([read]);
    expect(view.nodes[0]?.processed).toBe(node.head);
  });

  it("rejects the same two as too-large when they waited for the copy, and settles another node's record that waited with them", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    // The first node's records are checked first.
    const [long, refused] = await one.publish(citing(commit, "README.md"), citing(commit, "scripts/sync.sh"));
    const [read] = await other.publish(citing(commit, SKILL));
    await on.notice(NODE_A);
    await on.notice(NODE_B);
    await on.deliver();
    expect((await on.view(commit)).pending).toHaveLength(3);

    on.artifacts.blobFaults.set(await blobOf("README.md"), "oversize");
    on.artifacts.blobFaults.set(await blobOf("scripts/sync.sh"), "MEMORY_LIMIT");
    on.artifacts.finish();
    await on.drain();
    const view = await on.view(commit);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toContainEqual({ node: NODE_A, hash: long, type: "finding", reason: "too-large" });
    expect(view.rejected).toContainEqual({ node: NODE_A, hash: refused, type: "finding", reason: "too-large" });
    expect(view.rejected).toHaveLength(2);
    expect(await validIds(on, commit)).toEqual([read]);
  });

  /** Three findings on three files, and the file that the record checked last cites. Records are checked in the order of their IDs. */
  const threeWithTheLast = async (node: FakeNode, component: string): Promise<{ readonly ids: string[]; readonly last: string; readonly lastFile: string }> => {
    const files = ["README.md", "scripts/sync.sh", SKILL];
    const ids = await node.publish(...files.map((path) => citing(component, path)));
    const last = [...ids].sort().at(-1) ?? "";
    return { ids: [...ids].sort(), last, lastFile: files[ids.indexOf(last)] ?? "" };
  };

  it("stores the records a sync judged before a read of the copy failed with another error, and reads the rest when the sync is tried again", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const { ids, last, lastFile } = await threeWithTheLast(node, component);
    on.artifacts.blobFaults.set(await blobOf(lastFile), "INTERNAL_ERROR");
    await on.notice(NODE_A);
    await on.deliver();

    // The sync threw, so its message waits to be tried again. The two records before the error are stored.
    expect(on.queue.waiting).toEqual([{ body: { kind: "node", node: NODE_A }, delaySeconds: 30, attempts: 2 }]);
    expect(await validIds(on, component)).toEqual(ids.filter((id) => id !== last));
    expect(await stored()).toBe(2);
    expect((await on.view(component)).nodes[0]?.processed).toBeUndefined();

    on.artifacts.blobFaults.clear();
    await on.drain();
    expect(await validIds(on, component)).toEqual(ids);
    expect((await on.view(component)).nodes[0]?.processed).toBe(node.head);
  });

  it("settles the waiting records a look judged before a read of the copy failed with another error, and the rest when the look is tried again", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.registerNode(NODE_A);
    const { ids, last, lastFile } = await threeWithTheLast(node, commit);
    await on.notice(NODE_A);
    await on.deliver();
    expect((await on.view(commit)).pending).toHaveLength(3);

    on.artifacts.blobFaults.set(await blobOf(lastFile), "INTERNAL_ERROR");
    on.artifacts.finish();
    await on.deliver();
    expect(on.queue.waiting).toEqual([{ body: { kind: "component", component: commit }, delaySeconds: 30, attempts: 2 }]);
    const view = await on.view(commit);
    expect(view.state).toBe("ready");
    expect(view.pending).toEqual([{ node: NODE_A, hash: last, type: "finding" }]);
    expect(await validIds(on, commit)).toEqual(ids.filter((id) => id !== last));

    on.artifacts.blobFaults.clear();
    await on.drain();
    expect((await on.view(commit)).pending).toEqual([]);
    expect(await validIds(on, commit)).toEqual(ids);
  });
});

describe("a record and the state of its component's copy (KTD12, KTD36)", () => {
  it("holds a record as pending while the copy is importing, and as valid once the copy is ready", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.registerNode(NODE_A);
    const [id] = await node.publish(finding(commit));
    await on.notice(NODE_A);
    // The import starts and the node is synced. The copy is not ready yet.
    await on.deliver();
    await on.deliver();

    const before = await on.view(commit);
    expect(before.state).toBe("importing");
    expect(before.pending).toEqual([{ node: NODE_A, hash: id, type: "finding" }]);
    expect(before.findings).toEqual([]);

    on.artifacts.finish();
    await on.drain();
    const after = await on.view(commit);
    expect(after.state).toBe("ready");
    expect(after.pending).toEqual([]);
    expect(after.findings[0]?.findings.map((entry) => entry.id)).toEqual([id]);
    expect(after.viewVersion).toBeGreaterThan(before.viewVersion);
  });

  it("leaves a patch record pending when the copy becomes ready, and checks the finding that waited with it", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.registerNode(NODE_A);
    const [cited] = await node.publish(finding(commit));
    const [patch] = await node.publish({ version: "1", type: "patch", component: commit, commit: "3d".repeat(20), findings: [cited], model: "none" });
    await on.notice(NODE_A);
    await on.deliver();
    expect((await on.view(commit)).pending).toHaveLength(2);

    on.artifacts.finish();
    await on.drain();
    const view = await on.view(commit);
    expect(view.state).toBe("ready");
    expect(view.findings[0]?.findings.map((entry) => entry.id)).toEqual([cited]);
    // A patch record waits for its commit, not for the copy.
    expect(view.pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
    expect(view.rejected).toEqual([]);
  });

  it("checks more waiting records than one pass takes over several looks, the next one queued at once", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.registerNode(NODE_A);
    // 130 records with 130 IDs: each cites other lines of a file with 80 lines.
    await node.publish(
      ...Array.from({ length: 130 }, (_, at) => finding(commit, { location: { path: "README.md", ...(at < 80 ? { start: at + 1, end: 80 } : { start: 1, end: at - 79 }) } })),
    );
    await on.notice(NODE_A);
    // The node is read in two passes while the copy imports.
    await on.deliver();
    await on.deliver();
    expect((await on.view(commit)).pending).toHaveLength(130);

    on.artifacts.finish();
    await on.deliver();
    const partly = await on.view(commit);
    expect(partly.state).toBe("ready");
    expect(partly.pending).toHaveLength(10);
    expect(on.queue.waiting).toEqual([{ body: { kind: "component", component: commit }, delaySeconds: 0, attempts: 1 }]);

    await on.drain();
    const view = await on.view(commit);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([]);
    expect(view.findings.flatMap((group) => group.findings)).toHaveLength(130);
  });

  it("rejects a pending record that fails a check once the copy is ready", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.registerNode(NODE_A);
    const [id] = await node.publish(finding(commit, { location: { path: "README.md", start: 400, end: 410 } }));
    await on.notice(NODE_A);
    await on.deliver();
    await on.deliver();
    expect((await on.view(commit)).pending).toHaveLength(1);

    on.artifacts.finish();
    await on.drain();
    const view = await on.view(commit);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: id, type: "finding", reason: "lines-out-of-range" }]);
  });

  it("checks a record that was stored as pending just as the copy became ready", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.deliver();
    await on.registerNode(NODE_A);
    const [id] = await node.publish(finding(commit));
    // The copy becomes ready while the sync fetches the record, after it read the component's state.
    node.onFile = async () => {
      node.onFile = undefined;
      on.artifacts.finish();
      await on.deliver();
    };
    expect(await syncNode(on.env, NODE_A, START)).toMatchObject({ ok: true, stored: 1 });
    expect((await on.view(commit)).state).toBe("ready");

    await on.drain();
    const view = await on.view(commit);
    expect(view.pending).toEqual([]);
    expect(view.findings[0]?.findings.map((entry) => entry.id)).toEqual([id]);
  });

  it("rejects a record that was stored as pending just as the component failed", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    // The branch that is imported does not reach the commit, so the copy finishes without it.
    await on.artifacts.host(UPSTREAM, "other", { "README.md": "# Another branch\n" });
    await on.registerComponent({ url: UPSTREAM, branch: "other", commit });
    await on.deliver();
    await on.registerNode(NODE_A);
    const [id] = await node.publish(finding(commit));
    node.onFile = async () => {
      node.onFile = undefined;
      on.artifacts.finish();
      await on.deliver();
    };
    expect(await syncNode(on.env, NODE_A, START)).toMatchObject({ ok: true, stored: 1 });
    expect((await on.view(commit)).state).toBe("failed");

    await on.drain();
    const view = await on.view(commit);
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: id, type: "finding", reason: "unknown-component" }]);
  });

  it("checks a record that waits for a ready copy at the node's next sync, when the look that was to check it could not be queued", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.deliver();
    await on.registerNode(NODE_A);
    const [id] = await node.publish(finding(commit));
    // The copy becomes ready while the sync fetches the record. Then the queue takes no message from the sync.
    node.onFile = async () => {
      node.onFile = undefined;
      on.artifacts.finish();
      await on.deliver();
      on.queue.failures = 1;
    };
    await expect(syncNode(on.env, NODE_A, START)).rejects.toThrow("the queue took no message");
    expect((await on.view(commit)).pending).toEqual([{ node: NODE_A, hash: id, type: "finding" }]);
    expect(on.queue.waiting).toEqual([]);

    // The sync is tried again. It finds no file it has not read, and the record still waits.
    expect(await syncNode(on.env, NODE_A, START)).toEqual({ ok: true, head: node.head, stored: 0, more: false });
    await on.drain();
    const view = await on.view(commit);
    expect(view.pending).toEqual([]);
    expect(view.findings[0]?.findings.map((entry) => entry.id)).toEqual([id]);
  });

  it("leaves the waiting records of a component alone when a look gives the copy up just after another look found it ready", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    const component = { url: UPSTREAM, branch: BRANCH, commit };
    await on.registerComponent(component);
    await on.registerNode(NODE_A);
    const [cited] = await node.publish(finding(commit));
    const [patch] = await node.publish({ version: "1", type: "patch", component: commit, commit: "3d".repeat(20), findings: [cited], model: "none" });
    await on.notice(NODE_A);
    await on.deliver();
    expect((await on.view(commit)).pending).toHaveLength(2);

    // Two looks when the time is up. One finds the copy still importing. Before it gives
    // the component up, the import finishes and the other look stores the copy as ready.
    clockAt(START + 5 * MINUTE);
    let versionWhenReady: number | undefined;
    on.artifacts.onGet = async () => {
      on.artifacts.onGet = undefined;
      on.artifacts.finish();
      await on.registerComponent(component);
      await on.deliver();
      versionWhenReady = (await on.view(commit)).viewVersion;
    };
    await on.drain();

    const view = await on.view(commit);
    expect(view.state).toBe("ready");
    expect(view.findings[0]?.findings.map((entry) => entry.id)).toEqual([cited]);
    // A patch record waits for its commit, and the look that gave up changed nothing.
    expect(view.rejected).toEqual([]);
    expect(view.pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
    expect(view.viewVersion).toBe(versionWhenReady);
  });

  it("stores no record pushed before its component commit was registered, and reads it at the next sync after the registration", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerNode(NODE_A);
    const [id] = await node.publish(finding(commit));
    await synced(on, NODE_A);

    // The record was neither fetched nor stored.
    expect(node.requests).toEqual([`${NODE_A}/records`]);
    expect(await stored()).toBe(0);

    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.deliver();
    on.artifacts.finish();
    await on.drain();
    expect((await on.view(commit)).findings).toEqual([]);

    await synced(on, NODE_A);
    expect((await on.view(commit)).findings[0]?.findings.map((entry) => entry.id)).toEqual([id]);
  });

  it("stores a component whose import Artifacts refuses as failed with the error code, and rejects a pending record for it", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    // The remote cannot be reached at first, which is worth another try.
    on.artifacts.importFailure = "UPSTREAM_UNAVAILABLE";
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.registerNode(NODE_A);
    const [id] = await node.publish(finding(commit));
    await on.notice(NODE_A);
    await on.deliver();
    await on.deliver();
    expect((await on.view(commit)).state).toBe("importing");
    expect((await on.view(commit)).pending).toEqual([{ node: NODE_A, hash: id, type: "finding" }]);

    on.artifacts.importFailure = "REMOTE_AUTH_REQUIRED";
    await on.drain();
    const view = await on.view(commit);
    expect(view.state).toBe("failed");
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_A, hash: id, type: "finding", reason: "unknown-component" }]);
    // A registration that names another branch for the commit starts nothing, and is told the state.
    expect((await on.registerComponent({ url: UPSTREAM, branch: "other", commit })).body).toEqual({
      version: "1",
      component: commit,
      state: "failed",
      importError: "REMOTE_AUTH_REQUIRED",
    });

    // A record that arrives for a failed component is rejected at once.
    const [later] = await node.publish(finding(commit, { location: { path: "README.md", start: 1, end: 1 } }));
    await synced(on, NODE_A);
    expect((await on.view(commit)).rejected).toContainEqual({ node: NODE_A, hash: later, type: "finding", reason: "unknown-component" });
  });

  it("looks at a copy again after a while when Artifacts has an error of its own", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    on.artifacts.importFailure = "INTERNAL_ERROR";
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.deliver();
    expect(on.queue.waiting).toEqual([{ body: { kind: "component", component: commit }, delaySeconds: 30, attempts: 2 }]);
    expect((await on.view(commit)).state).toBe("importing");

    on.artifacts.importFailure = undefined;
    await on.deliver();
    on.artifacts.finish();
    await on.drain();
    expect((await on.view(commit)).state).toBe("ready");
  });

  it("marks a component as failed when its copy finishes without the pinned commit", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.artifacts.host(UPSTREAM, "other", { "README.md": "# Another branch\n" });
    await on.registerComponent({ url: UPSTREAM, branch: "other", commit });
    await on.deliver();
    on.artifacts.finish();
    await on.drain();
    // The component is stored with the branch `other`. A registration that names another one is told the state.
    expect((await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit })).body).toEqual({
      version: "1",
      component: commit,
      state: "failed",
      importError: "NOT_FOUND",
    });
  });

  it("marks a component as failed when its copy is not ready within the set time", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.deliver();
    expect((await on.view(commit)).state).toBe("importing");
    clockAt(START + 6 * MINUTE);
    await on.drain();
    expect((await on.view(commit)).state).toBe("failed");
  });

  it("gives an import its full time when the first look at the component runs more than five minutes after the registration", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    // The first look, which starts the import, runs late. The look after it finds the import running.
    clockAt(START + 6 * MINUTE);
    await on.deliver();
    expect(on.artifacts.imports).toHaveLength(1);
    await on.deliver();
    expect((await on.view(commit)).state).toBe("importing");

    on.artifacts.finish();
    await on.drain();
    expect((await on.view(commit)).state).toBe("ready");
  });

  it("marks a component as failed five minutes after its import started, and not before", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    clockAt(START + 6 * MINUTE);
    await on.deliver();
    clockAt(START + 11 * MINUTE - 1);
    await on.deliver();
    expect((await on.view(commit)).state).toBe("importing");

    clockAt(START + 11 * MINUTE);
    await on.drain();
    expect((await on.view(commit)).state).toBe("failed");
  });

  it("marks a component as failed when there is still no copy five minutes after its import started, and starts no other import", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.deliver();
    // The import fails after it was started, and leaves no copy. Until the time is up it is started again.
    on.artifacts.abandon();
    clockAt(START + 5 * MINUTE - 1);
    await on.deliver();
    expect(on.artifacts.imports).toHaveLength(2);
    expect((await on.view(commit)).state).toBe("importing");

    on.artifacts.abandon();
    clockAt(START + 5 * MINUTE);
    await on.drain();
    expect((await on.view(commit)).state).toBe("failed");
    expect(on.artifacts.imports).toHaveLength(2);
  });

  it("leaves the index's copy with no active token after the import", async () => {
    const on = bench();
    const commit = await on.component();
    expect(on.artifacts.tokens(`copy-${commit}`)).toEqual([{ scope: "write", state: "revoked" }]);
  });
});
