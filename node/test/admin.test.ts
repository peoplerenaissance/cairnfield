// The admin routes (KTD10). Every host and team here is invented.

import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { FakeArtifacts } from "./fake-artifacts.ts";
import { ADMIN_KEY, UPSTREAM, answer, importCopy, nodeOver, repoOf } from "./node.ts";

afterEach(reset);

const COMPONENT = "1f".repeat(20);

/** Every admin route, with a body the route accepts. */
const ADMIN_CALLS: readonly (readonly [path: string, body?: unknown])[] = [
  ["team-repo"],
  ["import", { url: UPSTREAM, branch: "main", commit: COMPONENT }],
  ["fork", { component: COMPONENT }],
  ["token", { repo: "team", scope: "write" }],
];

describe("the admin key", () => {
  it("refuses an admin call without the key", async () => {
    const artifacts = new FakeArtifacts();
    const node = nodeOver(artifacts);
    for (const [path, body] of ADMIN_CALLS) {
      expect(await answer(node.admin(path, body, null)), path).toEqual({
        status: 401,
        body: { error: "unauthorized" },
      });
      expect(await answer(node.admin(path, body, "another-key")), path).toEqual({
        status: 401,
        body: { error: "unauthorized" },
      });
    }
    expect(artifacts.repos()).toEqual([]);
  });

  it("refuses every admin call when no key is set", async () => {
    const artifacts = new FakeArtifacts();
    const node = nodeOver(artifacts, {});
    for (const [path, body] of ADMIN_CALLS) {
      // No header, an empty header and the key of another node.
      for (const key of [null, "", ADMIN_KEY]) {
        expect(await answer(node.admin(path, body, key)), path).toEqual({
          status: 401,
          body: { error: "unauthorized" },
        });
      }
    }
    expect(artifacts.repos()).toEqual([]);
  });

  it("refuses every admin call when the key is set to nothing", async () => {
    const node = nodeOver(new FakeArtifacts(), { ADMIN_KEY: "" });
    for (const [path, body] of ADMIN_CALLS) {
      expect(await answer(node.admin(path, body, "")), path).toEqual({
        status: 401,
        body: { error: "unauthorized" },
      });
    }
  });
});

/** A token as Artifacts returns one by itself: write scope, with no scope and no lifetime asked for. */
const returnedByArtifacts = (state: string) =>
  expect.objectContaining({ scope: "write", state, asked: { scope: undefined, ttl: undefined } });

describe("the team repo", () => {
  it("is created once, with an explicit default branch", async () => {
    const artifacts = new FakeArtifacts();
    const node = nodeOver(artifacts);
    const team = await repoOf(node.admin("team-repo"));
    expect(await answer(node.admin("team-repo"))).toEqual({ status: 200, body: { repo: team, ready: true } });
    expect(artifacts.creates).toEqual([{ name: team, setDefaultBranch: "main" }]);
    expect(artifacts.repos()).toEqual([team]);
  });
});

describe("a component copy", () => {
  it("is imported by URL and branch with no depth", async () => {
    const artifacts = new FakeArtifacts();
    const pinned = await artifacts.push(UPSTREAM, "main", { "README.md": "# Demo plugin\n" });
    const copy = await importCopy(nodeOver(artifacts), artifacts, "main", pinned);
    expect(artifacts.imports).toEqual([{ name: copy, url: UPSTREAM, branch: "main", depth: undefined }]);
    expect(artifacts.holds(copy, pinned)).toBe(true);
  });

  it("answers not ready while the import runs, and the same call succeeds once it has finished", async () => {
    const artifacts = new FakeArtifacts();
    const pinned = await artifacts.push(UPSTREAM, "main", { "README.md": "# Demo plugin\n" });
    const node = nodeOver(artifacts);
    const request = { url: UPSTREAM, branch: "main", commit: pinned };

    const copy = await repoOf(node.admin("import", request));
    expect(await answer(node.admin("import", request))).toEqual({ status: 200, body: { repo: copy, ready: false } });
    const copyToken = { repo: "copy", component: pinned, scope: "read" };
    for (const [path, body] of [["fork", { component: pinned }], ["token", copyToken]] as const) {
      expect(await answer(node.admin(path, body)), path).toEqual({ status: 409, body: { error: "not-ready" } });
    }

    artifacts.finish();
    expect(await answer(node.admin("import", request))).toEqual({ status: 200, body: { repo: copy, ready: true } });
    expect((await node.admin("token", copyToken)).status).toBe(200);
    const fork = await repoOf(node.admin("fork", { component: pinned }));
    expect(artifacts.repos()).toEqual([copy, fork]);
    // The calls made while the import ran started no second import.
    expect(artifacts.imports).toHaveLength(1);
  });

  it("is not ready when it does not hold the pinned commit", async () => {
    const artifacts = new FakeArtifacts();
    await artifacts.push(UPSTREAM, "main", { "README.md": "# Demo plugin\n" });
    const elsewhere = await artifacts.push(UPSTREAM, "release", { "README.md": "# Demo plugin 2\n" });
    const node = nodeOver(artifacts);
    const request = { url: UPSTREAM, branch: "main", commit: elsewhere };
    const copy = await repoOf(node.admin("import", request));
    artifacts.finish();
    expect(await answer(node.admin("import", request))).toEqual({ status: 200, body: { repo: copy, ready: false } });
  });
});

describe("a fork", () => {
  it("holds the pinned commit when its copy was imported from a branch that is not the default", async () => {
    const artifacts = new FakeArtifacts();
    const pinned = await artifacts.push(UPSTREAM, "release", { "README.md": "# Demo plugin\n" });
    const node = nodeOver(artifacts);
    const copy = await importCopy(node, artifacts, "release", pinned);

    const fork = await repoOf(node.admin("fork", { component: pinned }));
    expect(await answer(node.admin("fork", { component: pinned }))).toEqual({
      status: 200,
      body: { repo: fork, ready: false },
    });
    artifacts.finish();
    expect(await answer(node.admin("fork", { component: pinned }))).toEqual({
      status: 200,
      body: { repo: fork, ready: true },
    });
    expect(artifacts.holds(fork, pinned)).toBe(true);
    expect(artifacts.forks).toEqual([{ from: copy, name: fork, defaultBranchOnly: false }]);
  });

  it("is not made of a component that has no copy", async () => {
    const artifacts = new FakeArtifacts();
    expect(await answer(nodeOver(artifacts).admin("fork", { component: COMPONENT }))).toEqual({
      status: 404,
      body: { error: "not-found" },
    });
    expect(artifacts.repos()).toEqual([]);
  });
});

describe("the token Artifacts returns", () => {
  it("is revoked after an import, a create and a fork", async () => {
    const artifacts = new FakeArtifacts();
    const pinned = await artifacts.push(UPSTREAM, "main", { "README.md": "# Demo plugin\n" });
    const node = nodeOver(artifacts);

    const started = await repoOf(node.admin("import", { url: UPSTREAM, branch: "main", commit: pinned }));
    // Nothing can revoke a token while the import runs.
    expect(artifacts.tokens(started)).toEqual([returnedByArtifacts("active")]);
    const copy = await importCopy(node, artifacts, "main", pinned);
    const team = await repoOf(node.admin("team-repo"));
    const fork = await repoOf(node.admin("fork", { component: pinned }));
    artifacts.finish();
    await node.admin("fork", { component: pinned });

    for (const repo of [copy, team, fork]) {
      expect(artifacts.tokens(repo), repo).toEqual([returnedByArtifacts("revoked")]);
    }
    const listed = await (await artifacts.get(copy)).listTokens();
    expect(listed.tokens.filter((token) => token.state === "active" && token.scope === "write")).toEqual([]);
  });
});

describe("a repo token", () => {
  it("is refused with write scope for a component copy", async () => {
    const artifacts = new FakeArtifacts();
    const pinned = await artifacts.push(UPSTREAM, "main", { "README.md": "# Demo plugin\n" });
    const node = nodeOver(artifacts);
    const copy = await importCopy(node, artifacts, "main", pinned);

    expect(await answer(node.admin("token", { repo: "copy", component: pinned, scope: "write" }))).toEqual({
      status: 403,
      body: { error: "refused" },
    });
    expect((await node.admin("token", { repo: "copy", component: pinned, scope: "read" })).status).toBe(200);

    const listed = await (await artifacts.get(copy)).listTokens();
    const active = listed.tokens.filter((token) => token.state === "active");
    expect(active.map((token) => token.scope)).toEqual(["read"]);
  });

  it("comes from a call that sets the scope and a lifetime of an hour at most", async () => {
    const artifacts = new FakeArtifacts();
    const pinned = await artifacts.push(UPSTREAM, "main", { "README.md": "# Demo plugin\n" });
    const node = nodeOver(artifacts);
    const copy = await importCopy(node, artifacts, "main", pinned);
    const team = await repoOf(node.admin("team-repo"));
    const fork = await repoOf(node.admin("fork", { component: pinned }));
    artifacts.finish();

    const asked = [
      [{ repo: "team", scope: "write" }, team],
      [{ repo: "team", scope: "read" }, team],
      [{ repo: "fork", component: pinned, scope: "write" }, fork],
      [{ repo: "fork", component: pinned, scope: "read" }, fork],
      [{ repo: "copy", component: pinned, scope: "read" }, copy],
    ] as const;
    for (const [request, repo] of asked) {
      const { status, body } = await answer(node.admin("token", request));
      const issued = artifacts.tokens(repo).at(-1);
      expect(issued?.asked.scope).toBe(request.scope);
      expect(issued?.asked.ttl).toBeGreaterThanOrEqual(60);
      expect(issued?.asked.ttl).toBeLessThanOrEqual(3600);
      expect({ status, body }).toEqual({
        status: 200,
        body: { remote: artifacts.remote(repo), token: issued?.plaintext, expires: issued?.expires },
      });
    }
  });

  it("stays active when its repo is asked for again", async () => {
    const artifacts = new FakeArtifacts();
    const node = nodeOver(artifacts);
    const team = await repoOf(node.admin("team-repo"));
    await node.admin("token", { repo: "team", scope: "write" });
    await node.admin("team-repo");
    expect(artifacts.tokens(team).map((token) => token.state)).toEqual(["revoked", "active"]);
  });

  it("is not issued for a repo the node does not hold", async () => {
    const node = nodeOver(new FakeArtifacts());
    for (const request of [{ repo: "team", scope: "read" }, { repo: "fork", component: COMPONENT, scope: "read" }]) {
      expect(await answer(node.admin("token", request))).toEqual({ status: 404, body: { error: "not-found" } });
    }
  });
});

describe("a body the contract does not allow", () => {
  const good = { url: UPSTREAM, branch: "main", commit: COMPONENT };
  const BAD_BODIES: readonly (readonly [why: string, path: string, body: unknown])[] = [
    ["no body", "import", undefined],
    ["a list", "import", [good]],
    ["a URL that is not HTTPS", "import", { ...good, url: "http://git.fellbeck-tools.example/demo-plugin.git" }],
    ["a URL with a user", "import", { ...good, url: "https://someone@git.fellbeck-tools.example/demo-plugin.git" }],
    ["a URL that is not serialized", "import", { ...good, url: "https://Git.fellbeck-tools.example/demo-plugin.git" }],
    ["a branch that reads as an option", "import", { ...good, branch: "--upload-pack=x" }],
    ["a commit of 39 characters", "import", { ...good, commit: COMPONENT.slice(1) }],
    ["a commit in upper case", "import", { ...good, commit: COMPONENT.toUpperCase() }],
    ["a field the contract does not name", "import", { ...good, depth: 1 }],
    ["a missing field", "import", { url: UPSTREAM, commit: COMPONENT }],
    ["no component", "fork", {}],
    ["a component that is a branch name", "fork", { component: "main" }],
    ["a field the contract does not name", "fork", { component: COMPONENT, branch: "main" }],
    ["a repo the contract does not name", "token", { repo: "index", scope: "read" }],
    ["a scope the contract does not name", "token", { repo: "team", scope: "admin" }],
    ["no scope", "token", { repo: "team" }],
    ["a copy with no component", "token", { repo: "copy", scope: "read" }],
    ["a team repo with a component", "token", { repo: "team", component: COMPONENT, scope: "read" }],
  ];

  it.each(BAD_BODIES)("is refused: %s (%s)", async (_why, path, body) => {
    const artifacts = new FakeArtifacts();
    expect(await answer(nodeOver(artifacts).admin(path, body))).toEqual({
      status: 400,
      body: { error: "bad-request" },
    });
    expect(artifacts.imports).toEqual([]);
    expect(artifacts.repos()).toEqual([]);
  });
});
