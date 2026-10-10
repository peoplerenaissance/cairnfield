// Who can add work to the index (KTD8, KTD12, KTD30): registration of nodes and
// components, and the reset route.

import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { BRANCH, FILES, INDEX, NODE_A, NODE_B, NODE_C, REGISTRATION_HEADER, REGISTRATION_KEY, RESET_HEADER, RESET_KEY, START, UPSTREAM, bench, clockAt, finding, freshIndexForEachTest, synced } from "./bench.ts";
import { FakeNode, nodesBehindFetch } from "./fake-node.ts";

const MINUTE = 60_000;

const unauthorized = { status: 401, body: { version: "1", error: "unauthorized" } };

freshIndexForEachTest();

describe("node registration (KTD8, KTD30)", () => {
  it("registers a node with the key, and answers with the node's identity", async () => {
    const on = bench();
    expect(await on.registerNode(NODE_A)).toEqual({ status: 200, body: { version: "1", node: NODE_A } });
  });

  it("refuses a registration without the key, with another key and with an empty one", async () => {
    const on = bench();
    expect(await on.call("POST", "/nodes", { url: NODE_A })).toEqual(unauthorized);
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION_HEADER, "another-key"])).toEqual(unauthorized);
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION_HEADER, ""])).toEqual(unauthorized);
    // The reset key registers nothing, in either header.
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION_HEADER, RESET_KEY])).toEqual(unauthorized);
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [RESET_HEADER, RESET_KEY])).toEqual(unauthorized);
  });

  it("refuses a URL that is already registered", async () => {
    const on = bench();
    await on.registerNode(NODE_A);
    expect(await on.registerNode(NODE_A)).toEqual({ status: 409, body: { version: "1", error: "already-registered" } });
  });

  it("refuses a registration past the node cap", async () => {
    const on = bench({ MAX_NODES: "2" });
    expect((await on.registerNode(NODE_A)).status).toBe(200);
    expect((await on.registerNode(NODE_B)).status).toBe(200);
    expect(await on.registerNode(NODE_C)).toEqual({ status: 403, body: { version: "1", error: "limit-reached" } });
    // A node that is registered already is told so, at the cap too.
    expect((await on.registerNode(NODE_A)).body).toEqual({ version: "1", error: "already-registered" });
  });

  it("refuses a node URL over plain HTTP, one with credentials, and one that differs from a registered one only by a last slash", async () => {
    const on = bench();
    await on.registerNode(NODE_A);
    const refused = { status: 400, body: { version: "1", error: "bad-request" } };
    expect(await on.registerNode("http://node.team-b.example")).toEqual(refused);
    expect(await on.registerNode("https://user:pw@node.team-b.example")).toEqual(refused);
    expect(await on.registerNode(`${NODE_A}/`)).toEqual(refused);
    const component = await on.component();
    expect((await on.view(component)).nodes.map(({ node }) => node)).toEqual([NODE_A]);
  });

  it("refuses a body over 8 KB with the key, and registers nothing", async () => {
    const on = bench();
    // A registration that is right in every way, with white space after it.
    const post = (bytes: number): Promise<Response> =>
      worker.fetch(
        new Request(`${INDEX}/nodes`, { method: "POST", headers: { [REGISTRATION_HEADER]: REGISTRATION_KEY }, body: JSON.stringify({ url: NODE_A }).padEnd(bytes) }),
        on.env,
      );

    const over = await post(8 * 1024 + 1);
    expect([over.status, await over.json()]).toEqual([400, { version: "1", error: "bad-request" }]);
    // The node is not registered: the same body at exactly 8 KB registers it, and is not told it is there already.
    const within = await post(8 * 1024);
    expect([within.status, await within.json()]).toEqual([200, { version: "1", node: NODE_A }]);
  });

  it("refuses a body that is not the registration of a node", async () => {
    const on = bench();
    const refused = { status: 400, body: { version: "1", error: "bad-request" } };
    expect(await on.call("POST", "/nodes", { url: NODE_A, note: "added by hand" }, [REGISTRATION_HEADER, REGISTRATION_KEY])).toEqual(refused);
    expect(await on.call("POST", "/nodes", undefined, [REGISTRATION_HEADER, REGISTRATION_KEY])).toEqual(refused);
  });
});

describe("component registration (KTD12, KTD30)", () => {
  it("registers a component whose Git URL is on the allow-list, and imports its branch with no depth", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, { "README.md": "# Fellbeck sync\n" });
    expect(await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit })).toEqual({
      status: 200,
      body: { version: "1", component: commit, state: "importing" },
    });
    await on.deliver();
    expect(on.artifacts.imports).toEqual([{ name: `copy-${commit}`, url: UPSTREAM, branch: BRANCH, depth: undefined }]);
    expect((await on.view(commit)).state).toBe("importing");
    on.artifacts.finish();
    await on.drain();
    expect((await on.view(commit)).state).toBe("ready");
  });

  it("answers with the state of a component that is registered already, and imports nothing twice", async () => {
    const on = bench();
    const commit = await on.component();
    const before = await on.view(commit);
    expect(await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit })).toEqual({
      status: 200,
      body: { version: "1", component: commit, state: "ready" },
    });
    // A component that is ready is left as it is: no look is queued and its view does not change.
    expect(on.queue.waiting).toEqual([]);
    await on.drain();
    expect(on.artifacts.imports).toHaveLength(1);
    expect(await on.view(commit)).toEqual(before);
  });

  it("refuses a component whose Git URL is not on the allow-list", async () => {
    const on = bench();
    const other = "https://git.fellbeck-tools.example/another-plugin.git";
    const commit = await on.artifacts.host(other, BRANCH, { "README.md": "# Another plugin\n" });
    expect(await on.registerComponent({ url: other, branch: BRANCH, commit })).toEqual({
      status: 403,
      body: { version: "1", error: "not-allowed" },
    });
    await on.drain();
    expect(on.artifacts.imports).toEqual([]);
    expect((await on.call("GET", `/components/${commit}/view`)).status).toBe(404);
  });

  it("takes each of the Git URLs an allow-list names, and none when it names none", async () => {
    const other = "https://git.fellbeck-tools.example/another-plugin.git";
    const two = bench({ GIT_URLS: `${UPSTREAM} ${other}` });
    const commit = await two.artifacts.host(other, BRANCH, { "README.md": "# Another plugin\n" });
    expect((await two.registerComponent({ url: other, branch: BRANCH, commit })).status).toBe(200);

    const none = bench({ GIT_URLS: "" });
    const refused = await none.registerComponent({ url: UPSTREAM, branch: BRANCH, commit: "1f".repeat(20) });
    expect(refused.body).toEqual({ version: "1", error: "not-allowed" });
  });

  it("refuses a component past the cap", async () => {
    const on = bench({ MAX_COMPONENTS: "1" });
    await on.component();
    const second = await on.artifacts.host(UPSTREAM, "next", { "README.md": "# Fellbeck sync, later\n" });
    expect(await on.registerComponent({ url: UPSTREAM, branch: "next", commit: second })).toEqual({
      status: 403,
      body: { version: "1", error: "limit-reached" },
    });
  });

  it("refuses a registration without the key", async () => {
    const on = bench();
    const component = { url: UPSTREAM, branch: BRANCH, commit: "1f".repeat(20) };
    expect(await on.call("POST", "/components", component)).toEqual(unauthorized);
    expect(await on.call("POST", "/components", component, [REGISTRATION_HEADER, RESET_KEY])).toEqual(unauthorized);
  });

  it("refuses a commit, a branch or a URL in no accepted form", async () => {
    const on = bench();
    const refused = { status: 400, body: { version: "1", error: "bad-request" } };
    expect(await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit: "1F".repeat(20) })).toEqual(refused);
    expect(await on.registerComponent({ url: UPSTREAM, branch: "--upload-pack=sh", commit: "1f".repeat(20) })).toEqual(refused);
    expect(await on.registerComponent({ url: "https://user:pw@git.fellbeck-tools.example/x.git", branch: BRANCH, commit: "1f".repeat(20) })).toEqual(refused);
  });
});

describe("a failed component that is registered again (KTD12)", () => {
  it("starts over a component that failed by its deadline, and the component becomes ready", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    const component = { url: UPSTREAM, branch: BRANCH, commit };
    await on.registerComponent(component);
    await on.deliver();
    clockAt(START + 6 * MINUTE);
    await on.drain();
    const failed = await on.view(commit);
    expect(failed.state).toBe("failed");

    // A request that names another branch for the commit starts nothing, and is told the state.
    expect(await on.registerComponent({ ...component, branch: "other" })).toEqual({ status: 200, body: { version: "1", component: commit, state: "failed" } });
    expect(on.queue.waiting).toEqual([]);
    expect(await on.view(commit)).toEqual(failed);

    expect(await on.registerComponent(component)).toEqual({ status: 200, body: { version: "1", component: commit, state: "importing" } });
    expect(on.queue.waiting).toEqual([{ body: { kind: "component", component: commit }, delaySeconds: 0, attempts: 1 }]);
    const again = await on.view(commit);
    expect(again.state).toBe("importing");
    expect(again.viewVersion).toBeGreaterThan(failed.viewVersion);

    // The import that was started before still runs. Its time counts again from this registration.
    await on.deliver();
    expect((await on.view(commit)).state).toBe("importing");
    on.artifacts.finish();
    await on.drain();
    expect((await on.view(commit)).state).toBe("ready");
  });

  it("gives a component that is registered again five minutes from then, and no more", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    const component = { url: UPSTREAM, branch: BRANCH, commit };
    await on.registerComponent(component);
    await on.deliver();
    clockAt(START + 6 * MINUTE);
    await on.drain();
    await on.registerComponent(component);

    clockAt(START + 11 * MINUTE - 1);
    await on.deliver();
    expect((await on.view(commit)).state).toBe("importing");
    clockAt(START + 11 * MINUTE);
    await on.drain();
    expect((await on.view(commit)).state).toBe("failed");
  });

  it("drops the records that were rejected for the failed component, so the node's next sync reads them again and they are valid", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    const component = { url: UPSTREAM, branch: BRANCH, commit };
    on.artifacts.importFailure = "REMOTE_AUTH_REQUIRED";
    await on.registerComponent(component);
    await on.registerNode(NODE_A);
    await on.drain();
    const [id] = await node.publish(finding(commit));
    // A file that is no record of its name is rejected for a reason of its own.
    await node.push(`records/${commit}/finding/${"ab".repeat(32)}.json`, JSON.stringify(finding(commit)));
    await synced(on, NODE_A);
    const misnamed = { node: NODE_A, hash: expect.stringMatching(/^[0-9a-f]{64}$/), type: "finding", reason: "hash-mismatch" };
    const failed = await on.view(commit);
    expect(failed.state).toBe("failed");
    expect(failed.rejected).toHaveLength(2);
    expect(failed.rejected).toContainEqual({ node: NODE_A, hash: id, type: "finding", reason: "unknown-component" });
    expect(failed.rejected).toContainEqual(misnamed);

    // The remote takes the import now. The error code of the last one is gone from the answer.
    on.artifacts.importFailure = undefined;
    expect(await on.registerComponent(component)).toEqual({ status: 200, body: { version: "1", component: commit, state: "importing" } });
    expect((await on.view(commit)).rejected).toEqual([misnamed]);
    await on.deliver();
    on.artifacts.finish();
    await on.drain();
    // No node is synced because a component was registered.
    expect((await on.view(commit)).findings).toEqual([]);

    await synced(on, NODE_A);
    const view = await on.view(commit);
    expect(view.state).toBe("ready");
    expect(view.rejected).toEqual([misnamed]);
    expect(view.findings[0]?.findings.map((entry) => entry.id)).toEqual([id]);
  });
});

describe("the reset route (KTD30)", () => {
  it("accepts a reset with the reset key", async () => {
    const on = bench();
    expect(await on.call("POST", "/reset", undefined, [RESET_HEADER, RESET_KEY])).toEqual({ status: 200, body: { version: "1" } });
  });

  it("refuses a reset call with the registration key", async () => {
    const on = bench();
    expect(await on.call("POST", "/reset", undefined, [RESET_HEADER, REGISTRATION_KEY])).toEqual(unauthorized);
    expect(await on.call("POST", "/reset", undefined, [REGISTRATION_HEADER, REGISTRATION_KEY])).toEqual(unauthorized);
    expect(await on.call("POST", "/reset")).toEqual(unauthorized);
  });
});

describe("an index with neither key set", () => {
  it("refuses a registration and a reset, with no key header and with an empty one", async () => {
    const on = bench({ REGISTRATION_KEY: undefined, RESET_KEY: undefined });
    const component = { url: UPSTREAM, branch: BRANCH, commit: "1f".repeat(20) };
    expect(await on.call("POST", "/nodes", { url: NODE_A })).toEqual(unauthorized);
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION_HEADER, ""])).toEqual(unauthorized);
    expect(await on.call("POST", "/components", component)).toEqual(unauthorized);
    expect(await on.call("POST", "/components", component, [REGISTRATION_HEADER, ""])).toEqual(unauthorized);
    expect(await on.call("POST", "/reset")).toEqual(unauthorized);
    expect(await on.call("POST", "/reset", undefined, [RESET_HEADER, ""])).toEqual(unauthorized);
  });

  it("refuses the same with each key set to nothing", async () => {
    const on = bench({ REGISTRATION_KEY: "", RESET_KEY: "" });
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION_HEADER, ""])).toEqual(unauthorized);
    expect(await on.call("POST", "/reset", undefined, [RESET_HEADER, ""])).toEqual(unauthorized);
  });
});
