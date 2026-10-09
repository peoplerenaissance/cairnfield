// The public routes (KTD7). Every host, team and file here is invented.

import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { FakeArtifacts, blobHash } from "./fake-artifacts.ts";
import type { Files } from "./fake-artifacts.ts";
import { UPSTREAM, answer, forkCopy, importCopy, nodeOver, repoOf } from "./node.ts";
import type { TestNode } from "./node.ts";

afterEach(reset);

const COMPONENT = "1f".repeat(20);
const CLAIM = `records/${COMPONENT}/claim/${"a".repeat(64)}.json`;
const FINDING = `records/${COMPONENT}/finding/${"b".repeat(64)}.json`;
// The node validates nothing, so a record's content can be any bytes.
const CLAIM_TEXT = '{"type":"claim","number":1}';
const FINDING_TEXT = '{"type":"finding","observation":"runs-shell-command"}';

const NOT_FOUND = { status: 404, body: { error: "not-found" } };
const BAD_REQUEST = { status: 400, body: { error: "bad-request" } };

async function nodeWithTeamRepo(): Promise<{ artifacts: FakeArtifacts; node: TestNode; team: string }> {
  const artifacts = new FakeArtifacts();
  const node = nodeOver(artifacts);
  return { artifacts, node, team: await repoOf(node.admin("team-repo")) };
}

describe("the record listing", () => {
  it("returns the head commit and each record path with its blob hash", async () => {
    const { artifacts, node, team } = await nodeWithTeamRepo();
    await artifacts.push(team, "main", { [CLAIM]: CLAIM_TEXT });
    const head = await artifacts.push(team, "main", {
      "README.md": "The records of team A\n",
      [CLAIM]: CLAIM_TEXT,
      [FINDING]: FINDING_TEXT,
    });

    const { status, body } = await answer(node.get("records"));
    const listing = body as { head: string; records: { path: string; blob: string }[] };
    listing.records.sort((a, b) => (a.path < b.path ? -1 : 1));
    expect({ status, body: listing }).toEqual({
      status: 200,
      body: {
        head,
        records: [
          { path: CLAIM, blob: await blobHash(CLAIM_TEXT) },
          { path: FINDING, blob: await blobHash(FINDING_TEXT) },
        ],
      },
    });
  });

  it("lists a file under the records folder whatever its path, because the node validates nothing", async () => {
    const { artifacts, node, team } = await nodeWithTeamRepo();
    const head = await artifacts.push(team, "main", { "records/notes.txt": "not a record\n" });
    expect(await answer(node.get("records"))).toEqual({
      status: 200,
      body: { head, records: [{ path: "records/notes.txt", blob: await blobHash("not a record\n") }] },
    });
  });

  it("reads the branch the team repo was created with, and names it and not `HEAD`", async () => {
    const { artifacts, node, team } = await nodeWithTeamRepo();
    const head = await artifacts.push(team, "main", { [CLAIM]: CLAIM_TEXT });
    await artifacts.push(team, "other", { [FINDING]: FINDING_TEXT });
    expect(await answer(node.get("records"))).toEqual({
      status: 200,
      body: { head, records: [{ path: CLAIM, blob: await blobHash(CLAIM_TEXT) }] },
    });
    expect(artifacts.logRefs(team)).toEqual(["main"]);
  });

  it("answers not found before the team repo exists and before its first push", async () => {
    const artifacts = new FakeArtifacts();
    const node = nodeOver(artifacts);
    expect(await answer(node.get("records"))).toEqual(NOT_FOUND);
    await node.admin("team-repo");
    expect(await answer(node.get("records"))).toEqual(NOT_FOUND);
  });
});

describe("a record fetch", () => {
  it("returns the content at the given commit after a later push", async () => {
    const { artifacts, node, team } = await nodeWithTeamRepo();
    const first = await artifacts.push(team, "main", { [FINDING]: FINDING_TEXT });
    const later = await artifacts.push(team, "main", { [FINDING]: '{"type":"finding","later":true}' });

    const response = await node.get(`file?commit=${first}&path=${FINDING}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(FINDING_TEXT);
    expect(await (await node.get(`file?commit=${later}&path=${FINDING}`)).text()).toBe(
      '{"type":"finding","later":true}',
    );
  });

  it("returns not found for a missing path and for a commit the repo does not hold", async () => {
    const { artifacts, node, team } = await nodeWithTeamRepo();
    const head = await artifacts.push(team, "main", { [FINDING]: FINDING_TEXT });
    expect(await answer(node.get(`file?commit=${head}&path=${CLAIM}`))).toEqual(NOT_FOUND);
    expect(await answer(node.get(`file?commit=${COMPONENT}&path=${FINDING}`))).toEqual(NOT_FOUND);
  });
});

const PLUGIN: Files = {
  "README.md": "# Demo plugin\n",
  "docs/guide.md": "Run the sync skill.\n",
  "skills/sync/notes.md": "Notes\n",
  "skills/sync/run.sh": { content: "curl https://collect.fellbeck-metrics.example/\n", mode: "100755" },
};
const PATCH_REF = (component: string): string => `patch/${component}/${"c".repeat(64)}`;

/** A node whose fork of the demo plugin is ready for a patch commit. */
async function nodeWithFork(): Promise<{ artifacts: FakeArtifacts; node: TestNode; pinned: string; fork: string }> {
  const artifacts = new FakeArtifacts();
  const node = nodeOver(artifacts);
  const pinned = await artifacts.push(UPSTREAM, "main", PLUGIN);
  await importCopy(node, artifacts, "main", pinned);
  return { artifacts, node, pinned, fork: await forkCopy(node, artifacts, pinned) };
}

describe("the changed files of a patch commit", () => {
  it("are the edited path with its mode and new blob hash", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const edited = { content: "echo sync is off\n", mode: "100755" };
    const commit = await artifacts.push(fork, PATCH_REF(pinned), { ...PLUGIN, "skills/sync/run.sh": edited }, pinned);

    expect(await answer(node.get(`patch?component=${pinned}&commit=${commit}`))).toEqual({
      status: 200,
      body: {
        commit,
        parent: pinned,
        changes: [{ path: "skills/sync/run.sh", mode: "100755", blob: await blobHash("echo sync is off\n") }],
      },
    });
  });

  it("carry the deletion marker for a deleted file", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const { "skills/sync/notes.md": _deleted, ...rest } = PLUGIN;
    const commit = await artifacts.push(fork, PATCH_REF(pinned), rest, pinned);

    expect(await answer(node.get(`patch?component=${pinned}&commit=${commit}`))).toEqual({
      status: 200,
      body: {
        commit,
        parent: pinned,
        changes: [
          { path: "skills/sync/notes.md", mode: "000000", blob: "0000000000000000000000000000000000000000" },
        ],
      },
    });
  });

  it("name every added, deleted and changed path, and a path whose mode alone changed", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const commit = await artifacts.push(
      fork,
      PATCH_REF(pinned),
      {
        // `README.md` keeps its content and becomes executable. `docs` is deleted with all it holds.
        "README.md": { content: "# Demo plugin\n", mode: "100755" },
        "skills/sync/notes.md": "Notes\n",
        "skills/sync/run.sh": { content: "curl https://collect.fellbeck-metrics.example/\n", mode: "100755" },
        "skills/sync/hooks/pre.sh": "true\n",
      },
      pinned,
    );

    const { status, body } = await answer(node.get(`patch?component=${pinned}&commit=${commit}`));
    const patch = body as { changes: { path: string }[] };
    patch.changes.sort((a, b) => (a.path < b.path ? -1 : 1));
    expect({ status, body: patch }).toEqual({
      status: 200,
      body: {
        commit,
        parent: pinned,
        changes: [
          { path: "README.md", mode: "100755", blob: await blobHash("# Demo plugin\n") },
          { path: "docs/guide.md", mode: "000000", blob: "0000000000000000000000000000000000000000" },
          { path: "skills/sync/hooks/pre.sh", mode: "100644", blob: await blobHash("true\n") },
        ],
      },
    });
  });

  it("are found without reading a folder that did not change", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const edited = { content: "echo sync is off\n", mode: "100755" };
    const commit = await artifacts.push(fork, PATCH_REF(pinned), { ...PLUGIN, "skills/sync/run.sh": edited }, pinned);
    const repo = await artifacts.get(fork);
    const root = await repo.readTree((await repo.readCommit(pinned))?.treeHash ?? "");
    const docs = root?.find((child) => child.name === "docs")?.hash;
    expect(docs).toMatch(/^[0-9a-f]{40}$/);

    await node.get(`patch?component=${pinned}&commit=${commit}`);
    expect(artifacts.treeReads(fork)).not.toContain(docs);
  });

  it("are not found for a commit the fork does not hold, or for a component with no fork", async () => {
    const { node, pinned } = await nodeWithFork();
    expect(await answer(node.get(`patch?component=${pinned}&commit=${COMPONENT}`))).toEqual(NOT_FOUND);
    expect(await answer(node.get(`patch?component=${COMPONENT}&commit=${pinned}`))).toEqual(NOT_FOUND);
  });
});

describe("a blob of a fork", () => {
  it("is served as bytes", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const edited = { content: "echo sync is off\n", mode: "100755" };
    await artifacts.push(fork, PATCH_REF(pinned), { ...PLUGIN, "skills/sync/run.sh": edited }, pinned);

    const response = await node.get(`blob?component=${pinned}&blob=${await blobHash("echo sync is off\n")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("echo sync is off\n");
  });

  it("is not found when the fork does not hold it", async () => {
    const { node, pinned } = await nodeWithFork();
    expect(await answer(node.get(`blob?component=${pinned}&blob=${COMPONENT}`))).toEqual(NOT_FOUND);
  });
});

describe("the public token route", () => {
  it("returns a read token for a fork, from a call that sets the scope and a lifetime of an hour at most", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const { status, body } = await answer(node.get(`read-token?component=${pinned}`));
    const minted = artifacts.tokens(fork).at(-1);
    expect(minted).toMatchObject({ scope: "read", state: "active", asked: { scope: "read" } });
    expect(minted?.asked.ttl).toBeGreaterThanOrEqual(60);
    expect(minted?.asked.ttl).toBeLessThanOrEqual(3600);
    expect({ status, body }).toEqual({
      status: 200,
      body: { remote: artifacts.remote(fork), token: minted?.plaintext, expires: minted?.expires },
    });
  });

  it("refuses the team repo and any write scope", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const team = await repoOf(node.admin("team-repo"));
    const queries = ["repo=team", `component=${pinned}&repo=team`, `component=${pinned}&scope=write`, "repo=team&scope=write"];
    for (const query of queries) {
      expect(await answer(node.get(`read-token?${query}`)), query).toEqual(BAD_REQUEST);
    }
    // Neither repo has a token but the one Artifacts returned, which is revoked.
    expect(artifacts.tokens(team).map((token) => token.state)).toEqual(["revoked"]);
    expect(artifacts.tokens(fork).map((token) => token.state)).toEqual(["revoked"]);
  });

  it("mints one token for fifty requests for one fork", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const answers: string[] = [];
    for (let request = 0; request < 50; request += 1) {
      const response = await node.get(`read-token?component=${pinned}`);
      expect(response.status).toBe(200);
      answers.push(await response.text());
    }
    expect(new Set(answers).size).toBe(1);
    expect(artifacts.tokens(fork).filter((token) => token.asked.scope === "read")).toHaveLength(1);
  });

  it("keeps the token only until shortly before it expires", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    await node.get(`read-token?component=${pinned}`);
    const expires = artifacts.tokens(fork).at(-1)?.expires ?? 0;
    const { keys } = await env.READ_TOKENS.list();
    expect(keys).toHaveLength(1);
    const dropped = keys[0]?.expiration ?? 0;
    expect(dropped).toBeGreaterThan(Date.now() / 1000);
    expect(dropped).toBeLessThan(expires);
  });

  it("keeps a token of its own for each fork", async () => {
    const artifacts = new FakeArtifacts();
    const node = nodeOver(artifacts);
    const first = await artifacts.push(UPSTREAM, "main", PLUGIN);
    const second = await artifacts.push(UPSTREAM, "main", { ...PLUGIN, "README.md": "# Demo plugin 2\n" });
    const remotes: unknown[] = [];
    for (const pinned of [first, second, first]) {
      await node.admin("import", { url: UPSTREAM, branch: "main", commit: pinned });
      artifacts.finish();
      const fork = await forkCopy(node, artifacts, pinned);
      const { body } = await answer(node.get(`read-token?component=${pinned}`));
      expect(body).toMatchObject({ remote: artifacts.remote(fork) });
      remotes.push(body);
    }
    expect(remotes[0]).not.toEqual(remotes[1]);
    expect(remotes[0]).toEqual(remotes[2]);
  });

  it("does not serve the token kept for a fork that was deleted and made again", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    const { body: before } = await answer(node.get(`read-token?component=${pinned}`));
    artifacts.remove(fork);
    await forkCopy(node, artifacts, pinned);

    const { body: after } = await answer(node.get(`read-token?component=${pinned}`));
    const minted = artifacts.tokens(fork).at(-1);
    expect(minted).toMatchObject({ scope: "read", state: "active" });
    expect(after).toEqual({ remote: artifacts.remote(fork), token: minted?.plaintext, expires: minted?.expires });
    expect(after).not.toEqual(before);
  });

  it("answers not found for a component with no fork, and not ready while the fork is made", async () => {
    const artifacts = new FakeArtifacts();
    const node = nodeOver(artifacts);
    const pinned = await artifacts.push(UPSTREAM, "main", PLUGIN);
    await importCopy(node, artifacts, "main", pinned);
    expect(await answer(node.get(`read-token?component=${pinned}`))).toEqual(NOT_FOUND);
    await node.admin("fork", { component: pinned });
    expect(await answer(node.get(`read-token?component=${pinned}`))).toEqual({
      status: 409,
      body: { error: "not-ready" },
    });
    expect(await env.READ_TOKENS.list()).toMatchObject({ keys: [] });
  });
});

describe("a query the contract does not allow", () => {
  const BAD_QUERIES: readonly (readonly [why: string, path: string])[] = [
    ["a file with no commit", `file?path=${FINDING}`],
    ["a file at a branch", `file?commit=main&path=${FINDING}`],
    ["a file path that is no record path", `file?commit=${COMPONENT}&path=README.md`],
    ["a file path that leaves the records folder", `file?commit=${COMPONENT}&path=records/../.dev.vars`],
    ["a file path given twice", `file?commit=${COMPONENT}&path=${FINDING}&path=${CLAIM}`],
    ["a file with a name the contract does not have", `file?commit=${COMPONENT}&path=${FINDING}&repo=team`],
    ["a patch with a component in upper case", `patch?component=${COMPONENT.toUpperCase()}&commit=${COMPONENT}`],
    ["a patch with no commit", `patch?component=${COMPONENT}`],
    ["a blob hash of 39 characters", `blob?component=${COMPONENT}&blob=${COMPONENT.slice(1)}`],
    ["a listing with a name the contract does not have", "records?since=1"],
  ];

  it.each(BAD_QUERIES)("is refused: %s", async (_why, path) => {
    const { node } = await nodeWithTeamRepo();
    expect(await answer(node.get(path))).toEqual(BAD_REQUEST);
  });
});

describe("a route the contract does not have", () => {
  it("is not found", async () => {
    const { node } = await nodeWithTeamRepo();
    expect(await answer(node.get(""))).toEqual(NOT_FOUND);
    expect(await answer(node.get("instructions"))).toEqual(NOT_FOUND);
  });
});
