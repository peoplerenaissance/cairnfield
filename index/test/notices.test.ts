// Push notices and the queue (KTD11). A notice is an unauthenticated hint that names one
// node. The index pulls from the registered URL, once for a burst of notices, and again
// for a notice that arrives after a sync has read the node's head.

import { describe, expect, it } from "vitest";
import { NODE_A, NODE_B, START, bench, clockAt, finding, freshIndexForEachTest } from "./bench.ts";
import { FakeNode, nodesBehindFetch } from "./fake-node.ts";

freshIndexForEachTest();

describe("a push notice (KTD11)", () => {
  it("is accepted for a registered node, and queues one sync of that node", async () => {
    const on = bench();
    await on.registerNode(NODE_A);
    expect(await on.notice(NODE_A)).toEqual({ status: 200, body: { version: "1" } });
    expect(on.queue.sent).toEqual([{ body: { kind: "node", node: NODE_A }, delaySeconds: 5, attempts: 1 }]);
  });

  it("is ignored for an unregistered node", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    const asked = nodesBehindFetch(node);
    expect(await on.notice(NODE_A)).toEqual({ status: 404, body: { version: "1", error: "not-found" } });
    await on.drain();
    expect(on.queue.sent).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("is refused when it names a node in no accepted spelling, or holds anything else", async () => {
    const on = bench();
    await on.registerNode(NODE_A);
    const refused = { status: 400, body: { version: "1", error: "bad-request" } };
    expect(await on.notice(`${NODE_A}/`)).toEqual(refused);
    expect(await on.call("POST", "/notices", { node: NODE_A, fetch: "https://elsewhere.example/records" })).toEqual(refused);
    expect(await on.call("POST", "/notices", "not json")).toEqual(refused);
    expect(on.queue.sent).toEqual([]);
  });

  it("causes one sync for fifty notices for one node within 5 seconds", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    for (let sent = 0; sent < 50; sent++) {
      clockAt(START + sent * 100);
      expect((await on.notice(NODE_A)).status).toBe(200);
    }
    clockAt(START + 5000);
    await on.drain();

    expect(on.queue.sent.filter(({ body }) => body.kind === "node")).toHaveLength(1);
    expect(node.requests.filter((url) => url.endsWith("/records"))).toHaveLength(1);
    expect((await on.view(component)).nodes[0]?.processed).toBe(node.head);
  });

  it("leads to a second sync when it arrives while a sync of the same node is running, and the later head is reported as processed", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    await on.notice(NODE_A);
    // While the first sync runs, after it has read the head, the node takes another push and says so.
    node.onListing = async () => {
      node.onListing = undefined;
      await node.publish(finding(component, { location: { path: "README.md", start: 1, end: 1 } }));
      expect((await on.notice(NODE_A)).status).toBe(200);
    };
    await on.deliver();

    const [first, later] = node.commits;
    expect((await on.view(component)).nodes[0]?.processed).toBe(first);
    expect(on.queue.waiting).toHaveLength(1);

    await on.drain();
    const view = await on.view(component);
    expect(view.nodes[0]?.processed).toBe(later);
    expect(node.requests.filter((url) => url.endsWith("/records"))).toHaveLength(2);
    expect(view.findings.flatMap((group) => group.findings)).toHaveLength(2);
  });

  it("never causes a fetch from a URL other than the node it names", async () => {
    const on = bench();
    const one = new FakeNode(NODE_A);
    const other = new FakeNode(NODE_B);
    const asked = nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    await one.publish(finding(component));
    await other.publish(finding(component));
    await on.notice(NODE_A);
    await on.drain();

    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((url) => url.startsWith(`${NODE_A}/`))).toBe(true);
    expect(other.requests).toEqual([]);
  });

  it("queues a sync again when the queued one never ran", async () => {
    const on = bench();
    await on.registerNode(NODE_A);
    await on.notice(NODE_A);
    // The message is lost before any consumer sees it.
    on.queue.waiting.splice(0);
    clockAt(START + 30_000);
    await on.notice(NODE_A);
    expect(on.queue.sent).toHaveLength(1);
    clockAt(START + 61_000);
    await on.notice(NODE_A);
    expect(on.queue.sent).toHaveLength(2);
  });

  it("answers an error and queues again at the next notice when the queue takes no message", async () => {
    const on = bench();
    await on.registerNode(NODE_A);
    on.queue.failures = 1;
    await expect(on.notice(NODE_A)).rejects.toThrow();
    expect((await on.notice(NODE_A)).status).toBe(200);
    expect(on.queue.sent).toHaveLength(1);
  });

  it("is tried again after a while when the node cannot be reached", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    node.respond = () => {
      throw new TypeError("connection refused");
    };
    await on.notice(NODE_A);
    await on.deliver();

    expect(on.queue.waiting).toEqual([{ body: { kind: "node", node: NODE_A }, delaySeconds: 30, attempts: 2 }]);
    expect((await on.view(component)).nodes[0]?.processed).toBeUndefined();

    node.respond = undefined;
    await on.drain();
    expect((await on.view(component)).nodes[0]?.processed).toBe(node.head);
  });
});

describe("the index lag (Appendix H)", () => {
  it("is the time since the index received the oldest notice it has not yet processed", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    expect((await on.view(component)).lag).toBe(0);

    await on.notice(NODE_A);
    clockAt(START + 3000);
    await on.notice(NODE_A);
    clockAt(START + 7000);
    expect((await on.view(component)).lag).toBe(7000);

    await on.drain();
    expect((await on.view(component)).lag).toBe(0);
  });
});
