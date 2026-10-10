// Who can add work to the index (KTD8, KTD12, KTD30): registration of nodes and
// components, and the reset route.

import { describe, expect, it } from "vitest";
import { BRANCH, NODE_A, NODE_B, NODE_C, REGISTRATION_KEY, RESET_KEY, UPSTREAM, bench, freshIndexForEachTest } from "./bench.ts";

const REGISTRATION = "x-cairnfield-registration-key";
const RESET = "x-cairnfield-reset-key";
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
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION, "another-key"])).toEqual(unauthorized);
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION, ""])).toEqual(unauthorized);
    // The reset key registers nothing, in either header.
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION, RESET_KEY])).toEqual(unauthorized);
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [RESET, RESET_KEY])).toEqual(unauthorized);
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

  it("refuses a body that is not the registration of a node", async () => {
    const on = bench();
    const refused = { status: 400, body: { version: "1", error: "bad-request" } };
    expect(await on.call("POST", "/nodes", { url: NODE_A, note: "added by hand" }, [REGISTRATION, REGISTRATION_KEY])).toEqual(refused);
    expect(await on.call("POST", "/nodes", undefined, [REGISTRATION, REGISTRATION_KEY])).toEqual(refused);
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
    expect(await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit })).toEqual({
      status: 200,
      body: { version: "1", component: commit, state: "ready" },
    });
    await on.drain();
    expect(on.artifacts.imports).toHaveLength(1);
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
    expect(await on.call("POST", "/components", component, [REGISTRATION, RESET_KEY])).toEqual(unauthorized);
  });

  it("refuses a commit, a branch or a URL in no accepted form", async () => {
    const on = bench();
    const refused = { status: 400, body: { version: "1", error: "bad-request" } };
    expect(await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit: "1F".repeat(20) })).toEqual(refused);
    expect(await on.registerComponent({ url: UPSTREAM, branch: "--upload-pack=sh", commit: "1f".repeat(20) })).toEqual(refused);
    expect(await on.registerComponent({ url: "https://user:pw@git.fellbeck-tools.example/x.git", branch: BRANCH, commit: "1f".repeat(20) })).toEqual(refused);
  });
});

describe("the reset route (KTD30)", () => {
  it("accepts a reset with the reset key", async () => {
    const on = bench();
    expect(await on.call("POST", "/reset", undefined, [RESET, RESET_KEY])).toEqual({ status: 200, body: { version: "1" } });
  });

  it("refuses a reset call with the registration key", async () => {
    const on = bench();
    expect(await on.call("POST", "/reset", undefined, [RESET, REGISTRATION_KEY])).toEqual(unauthorized);
    expect(await on.call("POST", "/reset", undefined, [REGISTRATION, REGISTRATION_KEY])).toEqual(unauthorized);
    expect(await on.call("POST", "/reset")).toEqual(unauthorized);
  });
});

describe("an index with neither key set", () => {
  it("refuses a registration and a reset, with no key header and with an empty one", async () => {
    const on = bench({ REGISTRATION_KEY: undefined, RESET_KEY: undefined });
    const component = { url: UPSTREAM, branch: BRANCH, commit: "1f".repeat(20) };
    expect(await on.call("POST", "/nodes", { url: NODE_A })).toEqual(unauthorized);
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION, ""])).toEqual(unauthorized);
    expect(await on.call("POST", "/components", component)).toEqual(unauthorized);
    expect(await on.call("POST", "/components", component, [REGISTRATION, ""])).toEqual(unauthorized);
    expect(await on.call("POST", "/reset")).toEqual(unauthorized);
    expect(await on.call("POST", "/reset", undefined, [RESET, ""])).toEqual(unauthorized);
  });

  it("refuses the same with each key set to nothing", async () => {
    const on = bench({ REGISTRATION_KEY: "", RESET_KEY: "" });
    expect(await on.call("POST", "/nodes", { url: NODE_A }, [REGISTRATION, ""])).toEqual(unauthorized);
    expect(await on.call("POST", "/reset", undefined, [RESET, ""])).toEqual(unauthorized);
  });
});
