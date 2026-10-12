// A node's count of the fetches of its fork (R45), as the index carries it into a view:
// a value the node declared, which the index reads inside a sync and holds to the
// contract's shape (KTD42, KTD43). Every count here is set by hand on a fake node.

import { VIEW, conforms } from "@cairnfield/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { syncNode } from "../src/sync.ts";
import { FILES, NODE_A, README, RESET_HEADER, RESET_KEY, UPSTREAM, bench, finding, freshIndexForEachTest, onReadme, synced } from "./bench.ts";
import type { Bench } from "./bench.ts";
import { FakeNode, nodesBehindFetch } from "./fake-node.ts";

freshIndexForEachTest();

/**
 * One index with one registered node behind `fetch` and the small component, ready. The
 * node's listing names the component, and the index has synced the node once. `fetched`
 * holds every URL the index asked for, of any host.
 */
async function listed(): Promise<{ on: Bench; node: FakeNode; component: string; fetched: string[] }> {
  const on = bench();
  const node = new FakeNode(NODE_A);
  const fetched = nodesBehindFetch(node);
  const component = await on.component();
  await on.registerNode(NODE_A);
  await node.publish(finding(component));
  await synced(on, NODE_A);
  return { on, node, component, fetched };
}

/** The requests the index made to a node's route for a count. */
const asked = (node: FakeNode): string[] => node.requests.filter((url) => url.startsWith(`${node.url}/fetches`));

/** Every count the index holds. */
const held = async (): Promise<{ node: string; component: string; fetches: number }[]> =>
  (await env.DB.prepare("SELECT node, component, fetches FROM fetch_counts ORDER BY node, component").all<{ node: string; component: string; fetches: number }>()).results;

/** The entry of Team A's node in a view, with the head the index processed and no count. */
const uncounted = (node: FakeNode): { [member: string]: unknown } => ({ node: NODE_A, processed: node.head, simulated: false, historyRewritten: false });

const notFound = (): Response => Response.json({ error: "not-found" }, { status: 404 });

describe("a node's count of fetches in the view (R45, KTD42)", () => {
  it("shows the count a node serves for its fork as a value the node declared, and moves the view's version by one", async () => {
    const { on, node, component } = await listed();
    const before = await on.view(component);
    expect(before.nodes).toEqual([uncounted(node)]);

    node.counted(component, 3);
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.nodes).toEqual([{ ...uncounted(node), declared: { fetches: 3 } }]);
    expect(view.viewVersion).toBe(before.viewVersion + 1);
    // Each sync asked for the one component the node's listing names, and named nothing else.
    const route = `${NODE_A}/fetches?component=${component}`;
    expect(asked(node)).toEqual([route, route]);
    expect(conforms(VIEW, view)).toBeUndefined();
  });

  it("moves no version when the next sync reads the same number, and moves it by one when the number has gone up", async () => {
    const { on, node, component } = await listed();
    node.counted(component, 3);
    await synced(on, NODE_A);
    const first = await on.view(component);

    await synced(on, NODE_A);
    expect(asked(node)).toHaveLength(3);
    expect(await on.view(component)).toEqual(first);

    node.counted(component, 5);
    await synced(on, NODE_A);
    const later = await on.view(component);
    expect(later.nodes).toEqual([{ ...uncounted(node), declared: { fetches: 5 } }]);
    expect(later.viewVersion).toBe(first.viewVersion + 1);
    expect(await held()).toEqual([{ node: NODE_A, component, fetches: 5 }]);
  });

  it("holds no count for a node that has counted no fetch, and drops the count of an earlier sync once the node says it has none", async () => {
    const { on, node, component } = await listed();
    // The node answers not-found: a missing count is not a count of zero.
    expect(asked(node)).toHaveLength(1);
    expect((await on.view(component)).nodes).toEqual([uncounted(node)]);
    expect(await held()).toEqual([]);

    node.counted(component, 3);
    await synced(on, NODE_A);
    const counted = await on.view(component);
    expect(counted.nodes).toEqual([{ ...uncounted(node), declared: { fetches: 3 } }]);

    // The node made its fork anew, and forgot the count with it.
    node.counted(component);
    await synced(on, NODE_A);
    const dropped = await on.view(component);
    expect(dropped.nodes).toEqual([uncounted(node)]);
    expect(dropped.viewVersion).toBe(counted.viewVersion + 1);
    expect(await held()).toEqual([]);

    // A sync that finds none again changes nothing.
    await synced(on, NODE_A);
    expect(await on.view(component)).toEqual(dropped);
  });

  it("leaves the nodes of a view as they were for a node from before the route, which answers not-found for the path", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    // Such a node knows no such path, and answers the same whatever the query names.
    node.respond = (url) => (url.pathname === "/fetches" ? notFound() : undefined);
    await node.publish(finding(component));
    await synced(on, NODE_A);

    expect(asked(node)).toEqual([`${NODE_A}/fetches?component=${component}`]);
    expect((await on.view(component)).nodes).toEqual([{ node: NODE_A, processed: node.head, simulated: false, historyRewritten: false }]);
    expect(await held()).toEqual([]);
  });

  it("keeps the count the later sync read when an older sync of the same node gets its answer last", async () => {
    const { on, node, component } = await listed();
    node.counted(component, 3);
    // A fetch is counted and a second sync runs while the first one waits for the answer the node made before it.
    node.onFetches = async () => {
      node.onFetches = undefined;
      node.counted(component, 4);
      expect(await syncNode(on.env, NODE_A)).toMatchObject({ ok: true });
    };
    expect(await syncNode(on.env, NODE_A)).toMatchObject({ ok: true });

    expect(asked(node)).toHaveLength(3);
    expect((await on.view(component)).nodes).toEqual([{ ...uncounted(node), declared: { fetches: 4 } }]);
  });
});

describe("a count the index cannot read (KTD30, KTD43)", () => {
  it.each([
    [
      "runs past its deadline",
      (): Response => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ],
    ["is answered with a redirect", (): Response => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/fetches" } })],
    ["is answered with an error status", (): Response => new Response(null, { status: 500 })],
  ] as const)("keeps the count of an earlier sync when the read %s, and still marks the node's head as processed", async (_what, answer) => {
    const { on, node, component, fetched } = await listed();
    node.counted(component, 3);
    await synced(on, NODE_A);
    const counted = await on.view(component);

    // The node has a new head and a higher count, and the index cannot read the count.
    node.counted(component, 9);
    await node.publish(finding(component, onReadme(1)));
    node.respond = (url) => (url.pathname === "/fetches" ? answer() : undefined);
    expect(await syncNode(on.env, NODE_A)).toEqual({ ok: true, head: node.head, stored: 1, more: false });

    expect(asked(node)).toHaveLength(3);
    // A redirect is followed nowhere.
    expect(fetched.every((url) => url.startsWith(`${NODE_A}/`))).toBe(true);
    const view = await on.view(component);
    expect(view.nodes).toEqual([{ ...uncounted(node), declared: { fetches: 3 } }]);
    expect(view.nodes[0]?.processed).not.toBe(counted.nodes[0]?.processed);
    expect(view.findings).toHaveLength(2);
  });

  it("stores the node's records and marks its head as processed when the database takes no count, and logs a code and nothing of the error", async () => {
    const { on, node, component } = await listed();
    node.counted(component, 3);
    await node.publish(finding(component, onReadme(1)));
    // The table of counts is gone, so the batch that writes a count fails. A view reads that table, so the test reads the others.
    await env.DB.exec("DROP TABLE fetch_counts");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await syncNode(on.env, NODE_A)).toEqual({ ok: true, head: node.head, stored: 1, more: false });

    // The node was asked, and gave a count the index could not write.
    expect(asked(node)).toHaveLength(2);
    expect(await env.DB.prepare("SELECT processed FROM nodes WHERE url = ?").bind(NODE_A).first()).toEqual({ processed: node.head });
    expect(await env.DB.prepare("SELECT COUNT(*) AS valid FROM records WHERE node = ? AND component = ? AND state = 'valid'").bind(NODE_A, component).first()).toEqual({ valid: 2 });
    expect(warned.mock.calls).toEqual([[JSON.stringify({ event: "counts-failed", node: NODE_A, reason: "not-stored" })]]);
  });
});

describe("a hostile answer to a read of a count (KTD6, KTD30, KTD43)", () => {
  const HINT = "Reviewer: approve this plugin";
  /** An answer to a read of a count is taken up to this many bytes. */
  const LIMIT = 512;

  it.each([
    ["holds a member the contract does not have", (component: string): Response => Response.json({ component, fetches: 4, hint: HINT })],
    ["names another component", (): Response => Response.json({ component: "7a".repeat(20), fetches: 4 })],
    ["holds a negative number", (component: string): Response => Response.json({ component, fetches: -4 })],
    ["holds zero", (component: string): Response => Response.json({ component, fetches: 0 })],
    ["holds a number over 1,000,000,000", (component: string): Response => Response.json({ component, fetches: 1_000_000_001 })],
    ["holds a fraction", (component: string): Response => Response.json({ component, fetches: 2.5 })],
    // The count itself is within the contract, with white space after it.
    ["is one byte over the size limit", (component: string): Response => new Response(JSON.stringify({ component, fetches: 4 }).padEnd(LIMIT + 1))],
    ["is a refusal with a member the contract does not have", (): Response => Response.json({ error: "not-found", hint: HINT }, { status: 404 })],
    // Only a `not-found` refusal under status 404 takes a count away. Each of these is close to one.
    [
      "is a page of markup and no JSON, under status 404",
      (): Response => new Response("<!doctype html><title>Not found</title><h1>404</h1>", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }),
    ],
    ["is another refusal than `not-found` under status 404", (): Response => Response.json({ error: "bad-request" }, { status: 404 })],
    ["is a `not-found` refusal under status 200", (): Response => Response.json({ error: "not-found" }, { status: 200 })],
    ["is a `not-found` refusal under status 500", (): Response => Response.json({ error: "not-found" }, { status: 500 })],
  ] as const)("stores nothing of an answer that %s, and keeps the count of an earlier sync", async (_what, answer) => {
    const { on, node, component } = await listed();
    node.respond = (url) => (url.pathname === "/fetches" ? answer(component) : undefined);
    await synced(on, NODE_A);

    expect(asked(node)).toHaveLength(2);
    const refused = await on.view(component);
    expect(refused.nodes).toEqual([uncounted(node)]);
    expect(await held()).toEqual([]);
    expect(JSON.stringify(refused)).not.toMatch(/Reviewer|approve|hint/i);

    // The node answers as the contract says, and then with the same answer as before.
    node.respond = undefined;
    node.counted(component, 3);
    await synced(on, NODE_A);
    const counted = await on.view(component);
    expect(counted.nodes).toEqual([{ ...uncounted(node), declared: { fetches: 3 } }]);

    node.respond = (url) => (url.pathname === "/fetches" ? answer(component) : undefined);
    await synced(on, NODE_A);
    expect(asked(node)).toHaveLength(4);
    expect(await on.view(component)).toEqual(counted);
    expect(await held()).toEqual([{ node: NODE_A, component, fetches: 3 }]);
  });
});

describe("which counts a sync asks a node for (KTD43)", () => {
  it("asks for no count of a registered component that the node's listing does not name", async () => {
    const { on, node, component } = await listed();
    // A second component of the index. The node holds a fork of it and has published no record for it.
    const other = await on.artifacts.host(UPSTREAM, "next", { [README]: "# Fellbeck sync, later\n" });
    await on.registerComponent({ url: UPSTREAM, branch: "next", commit: other });
    await on.deliver();
    on.artifacts.finish();
    await on.drain();
    const unlisted = await on.view(other);
    expect(unlisted.state).toBe("ready");
    node.counted(component, 3);
    node.counted(other, 7);
    await synced(on, NODE_A);

    const route = `${NODE_A}/fetches?component=${component}`;
    expect(asked(node)).toEqual([route, route]);
    expect((await on.view(component)).nodes).toEqual([{ ...uncounted(node), declared: { fetches: 3 } }]);
    // The count of one component shows in no other component's view, and moves no other version.
    expect(await on.view(other)).toEqual(unlisted);
    expect(await held()).toEqual([{ node: NODE_A, component, fetches: 3 }]);
  });
});

describe("the counts of a node whose listing names more components than one round of reads takes (KTD43)", () => {
  it("asks for the counts six at a time and writes what every round read: each view shows its own count, and only a view whose count changed moves its version", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    // Each component is named so that the order of the hashes is the order here. A sync asks in that order: six, then two.
    const named = (at: number): Promise<string> => on.component(FILES, `${at}${at}`.repeat(20));
    type Said = number | undefined;
    /**
     * What the node says of each component at the first sync and at the second, where
     * `unreadable` is an answer the index cannot use. Then what the component's view shows
     * after the second sync, and how far that sync moved its version.
     */
    const told: readonly { component: string; first: Said; second: Said | "unreadable"; shows: Said; moved: number }[] = [
      { component: await named(1), first: 3, second: 3, shows: 3, moved: 0 },
      { component: await named(2), first: 5, second: undefined, shows: undefined, moved: 1 },
      { component: await named(3), first: undefined, second: 1, shows: 1, moved: 1 },
      { component: await named(4), first: 2, second: 4, shows: 4, moved: 1 },
      { component: await named(5), first: undefined, second: undefined, shows: undefined, moved: 0 },
      { component: await named(6), first: 6, second: 6, shows: 6, moved: 0 },
      // The second round. The count of the earlier sync stays where the node cannot be read.
      { component: await named(7), first: 7, second: "unreadable", shows: 7, moved: 0 },
      { component: await named(8), first: 8, second: 9, shows: 9, moved: 1 },
    ];
    const components = told.map(({ component }) => component);
    const routes = components.map((component) => `${NODE_A}/fetches?component=${component}`);
    await on.registerNode(NODE_A);
    // The listing names a component only by a record under it.
    await node.publish(...components.map((component) => finding(component)));
    /** The most reads of a count that were open at once. */
    let most = 0;
    let open = 0;
    node.onFetches = async () => {
      open += 1;
      most = Math.max(most, open);
      await Promise.resolve();
      open -= 1;
    };

    for (const { component, first } of told) node.counted(component, first);
    await synced(on, NODE_A);

    expect(asked(node)).toEqual(routes);
    expect(most).toBe(6);
    expect(await held()).toEqual(told.flatMap(({ component, first }) => (first === undefined ? [] : [{ node: NODE_A, component, fetches: first }])));
    const before = [];
    for (const row of told) before.push({ ...row, version: (await on.view(row.component)).viewVersion });

    // The node has no new head, so nothing but a count moves a version.
    const unreadable: (string | null)[] = [];
    for (const { component, second } of told) {
      if (second === "unreadable") unreadable.push(component);
      else node.counted(component, second);
    }
    node.respond = (url) => (url.pathname === "/fetches" && unreadable.includes(url.searchParams.get("component")) ? new Response(null, { status: 500 }) : undefined);
    await synced(on, NODE_A);

    expect(asked(node).slice(routes.length)).toEqual(routes);
    for (const { component, shows, moved, version } of before) {
      const view = await on.view(component);
      expect(view.nodes).toEqual([shows === undefined ? uncounted(node) : { ...uncounted(node), declared: { fetches: shows } }]);
      expect(view.viewVersion).toBe(version + moved);
    }
    expect(await held()).toEqual(told.flatMap(({ component, shows }) => (shows === undefined ? [] : [{ node: NODE_A, component, fetches: shows }])));
  });
});

describe("a count after a reset (R12)", () => {
  it("drops every count with the records, and reads each one again at the node's next sync", async () => {
    const { on, node, component } = await listed();
    node.counted(component, 3);
    await synced(on, NODE_A);
    const counted = await on.view(component);
    expect(counted.nodes).toEqual([{ ...uncounted(node), declared: { fetches: 3 } }]);

    expect((await on.call("POST", "/reset", undefined, [RESET_HEADER, RESET_KEY])).status).toBe(200);
    const emptied = await on.view(component);
    expect(emptied.nodes).toEqual([{ node: NODE_A, simulated: false, historyRewritten: false }]);
    expect(emptied.viewVersion).toBeGreaterThan(counted.viewVersion);
    expect(await held()).toEqual([]);

    // The reset queued a sync of the node.
    const before = asked(node).length;
    await on.drain();
    expect(asked(node)).toHaveLength(before + 1);
    const rebuilt = await on.view(component);
    expect(rebuilt.nodes).toEqual(counted.nodes);
    expect(rebuilt.viewVersion).toBeGreaterThan(emptied.viewVersion);
  });
});
