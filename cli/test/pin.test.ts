// `pin`: the node imports the component, and the command makes the local checkout that
// agents and validation read (KTD16, KTD36, KTD40).

import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_KEY_HEADER, REGISTRATION_KEY_HEADER } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import {
  ADMIN_KEY,
  FIXTURES,
  INDEX,
  NODE,
  REGISTRATION_KEY,
  bench,
  demoPlugin,
  pinTree as pin,
} from "./support.ts";
import type { Bench, Entry } from "./support.ts";

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const checkout = (commit: string): string => join(on.home, ".cairnfield/checkouts", commit);

/** Every entry of a folder, files and links alike, by its path in the folder. */
function entries(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

const pinTree = (tree: readonly Entry[]) => pin(on, tree);

describe("pin", () => {
  it("has the node import the component, waits until the copy is ready and makes the checkout", async () => {
    const plugin = demoPlugin(on);
    on.node.notReadyFor = 2;

    const outcome = await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);

    expect(outcome).toEqual({
      code: EXIT.ok,
      output: {
        component: plugin.first,
        checkout: `.cairnfield/checkouts/${plugin.first}`,
        files: 5,
        leftOut: [],
        registered: false,
      },
    });
    const imports = on.requests.filter((seen) => seen.url === `${NODE}/admin/import`);
    expect(imports).toHaveLength(3);
    expect(imports[0]?.body).toEqual({ url: plugin.url, branch: plugin.branch, commit: plugin.first });
    expect(imports[0]?.headers.get(ADMIN_KEY_HEADER)).toBe(ADMIN_KEY);
    expect(on.sleeps).toHaveLength(2);

    const dir = checkout(plugin.first);
    expect(entries(dir)).toEqual(["README.md", "plugin.json", "scripts/export.sh", "scripts/sync.sh", "skills/sync/SKILL.md"]);
    for (const path of entries(dir)) {
      expect(readFileSync(join(dir, path)), path).toEqual(readFileSync(`${FIXTURES}demo-plugin/first/${path}`));
    }
    expect(statSync(join(dir, "scripts/sync.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(dir, "README.md")).mode & 0o111).toBe(0);
  });

  it("asks for the pinned commit alone, and never for a submodule", async () => {
    const plugin = demoPlugin(on);
    await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);

    const fetches = on.gitCalls.filter(([command]) => command === "fetch");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toEqual(expect.arrayContaining(["--depth=1", "--no-tags", "--no-recurse-submodules", plugin.first]));
  });

  it("fails with a code of its own when the imported copy does not hold the commit", async () => {
    const plugin = demoPlugin(on);
    on.node.importRefusal = "not-found";

    const outcome = await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);

    expect(outcome).toEqual({ code: EXIT.notHeld, output: { error: "not-held", component: plugin.first } });
    expect(existsSync(checkout(plugin.first))).toBe(false);
    expect(on.gitCalls).toEqual([]);
  });

  it("leaves a link, a submodule entry and a refused path out of the checkout, and reports each by its reason", async () => {
    const { commit, outcome } = await pinTree([
      { path: "README.md", content: "# A plugin\n" },
      { path: "outside", content: "../../../outside-the-checkout", mode: "120000" },
      { path: "vendor/tool", hash: "12".repeat(20), mode: "160000" },
      { path: "notes/a name with spaces.md", content: "a note\n" },
    ]);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output).toMatchObject({
      files: 1,
      leftOut: [
        { path: "notes/a name with spaces.md", reason: "refused-path" },
        { path: "outside", reason: "symbolic-link" },
        { path: "vendor/tool", reason: "submodule" },
      ],
    });
    expect(entries(checkout(commit))).toEqual(["README.md"]);
  });

  it("leaves out a path that starts with a byte order mark, and does not write it under the name without one", async () => {
    // A text decoder drops the mark unless it is told to keep it. The path would then read as `plugin.json`.
    const { commit, outcome } = await pinTree([
      { path: "README.md", content: "# A plugin\n" },
      { path: "\ufeffplugin.json", content: "{}\n" },
    ]);

    expect(outcome.code).toBe(EXIT.ok);
    expect(outcome.output).toMatchObject({ files: 1, leftOut: [{ path: "\ufeffplugin.json", reason: "refused-path" }] });
    expect(entries(checkout(commit))).toEqual(["README.md"]);
  });

  it("leaves out paths that a disk without letter case could not hold apart, and writes none over another", async () => {
    const { commit, outcome } = await pinTree([
      { path: "README.md", content: "# A plugin\n" },
      { path: "A/x.js", content: "one\n" },
      { path: "a/x.js", content: "two\n" },
      { path: "Docs", content: "a file\n" },
      { path: "docs/guide.md", content: "under a folder of the same name\n" },
      { path: "src/main.js", content: "kept\n" },
    ]);

    expect(outcome.code).toBe(EXIT.ok);
    const { files, leftOut } = outcome.output as { files: number; leftOut: { path: string; reason: string }[] };
    expect(files).toBe(2);
    expect(leftOut.map(({ path }) => path).sort()).toEqual(["A/x.js", "Docs", "a/x.js", "docs/guide.md"]);
    expect(new Set(leftOut.map(({ reason }) => reason))).toEqual(new Set(["path-collision"]));
    expect(entries(checkout(commit))).toEqual(["README.md", "src/main.js"]);
  });

  it("reads a large component from Git a part at a time", async () => {
    const megabyte = 1024 * 1024;
    const sizes = [22 * megabyte, 22 * megabyte + 1, 22 * megabyte + 2];
    const { commit, outcome } = await pinTree(sizes.map((size, at) => ({ path: `assets/${at}.bin`, content: new Uint8Array(size) })));

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { files: 3 } });
    for (const [at, size] of sizes.entries()) expect(statSync(join(checkout(commit), `assets/${at}.bin`)).size).toBe(size);
    // 66 MB of files, read at most 64 MB at a time.
    expect(on.gitCalls.filter(([command, flag]) => command === "cat-file" && flag === "--batch")).toHaveLength(2);
  });

  it("does not pin a component with a file larger than a checkout may hold", async () => {
    const { commit, outcome } = await pinTree([
      { path: "README.md", content: "# A plugin\n" },
      { path: "assets/huge.bin", content: new Uint8Array(32 * 1024 * 1024 + 1) },
    ]);

    expect(outcome).toEqual({ code: EXIT.failed, output: { error: "component-too-large" } });
    expect(existsSync(checkout(commit))).toBe(false);
    expect(on.gitCalls.filter(([command]) => command === "cat-file")).toEqual([]);
  });

  it("makes a checkout with no `.git` folder and no link", async () => {
    const { commit } = await pinTree([
      { path: "README.md", content: "# A plugin\n" },
      { path: "docs/link", content: "/etc/hosts", mode: "120000" },
    ]);

    const dir = checkout(commit);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    for (const path of entries(dir)) expect(lstatSync(join(dir, path)).isSymbolicLink(), path).toBe(false);
    expect(entries(dir)).toEqual(["README.md"]);
  });

  it("writes each file's stored bytes, whatever the component's Git attributes say", async () => {
    const windows = "one\r\ntwo\r\n";
    const { commit } = await pinTree([
      { path: ".gitattributes", content: "hidden.txt export-ignore\nlegacy.txt working-tree-encoding=UTF-16\nwindows.txt text eol=lf\n" },
      { path: "hidden.txt", content: "kept all the same\n" },
      { path: "legacy.txt", content: "plain text\n" },
      { path: "windows.txt", content: windows },
    ]);

    const dir = checkout(commit);
    expect(readFileSync(join(dir, "hidden.txt"), "utf8")).toBe("kept all the same\n");
    expect(readFileSync(join(dir, "legacy.txt"), "utf8")).toBe("plain text\n");
    expect(readFileSync(join(dir, "windows.txt"), "utf8")).toBe(windows);
  });

  it("registers nothing when the config names no index", async () => {
    const plugin = demoPlugin(on);
    await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);
    expect(on.requests.filter((seen) => seen.url.startsWith(INDEX))).toEqual([]);
  });

  it("registers the node and the commit with a configured index", async () => {
    on.configure({ node: NODE, index: INDEX });
    const plugin = demoPlugin(on);

    const outcome = await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);

    expect(outcome.output).toMatchObject({ registered: true });
    expect(on.index.nodes).toEqual([NODE]);
    expect(on.index.components).toEqual([{ url: plugin.url, branch: plugin.branch, commit: plugin.first }]);
    const sent = on.requests.filter((seen) => seen.url.startsWith(INDEX));
    for (const seen of sent) expect(seen.headers.get(REGISTRATION_KEY_HEADER)).toBe(REGISTRATION_KEY);
  });

  it("registers a commit that is already pinned once an index is added, and changes nothing else", async () => {
    const plugin = demoPlugin(on);
    await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);
    const made = statSync(join(checkout(plugin.first), "README.md")).mtimeMs;
    const gitCalls = on.gitCalls.length;
    on.index.nodes.push(NODE);

    on.configure({ node: NODE, index: INDEX });
    const outcome = await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { files: 5, registered: true } });
    expect(on.index.components).toEqual([{ url: plugin.url, branch: plugin.branch, commit: plugin.first }]);
    expect(on.gitCalls).toHaveLength(gitCalls);
    expect(statSync(join(checkout(plugin.first), "README.md")).mtimeMs).toBe(made);
  });

  it("makes a checkout again when its listing cannot be read as one, where every other command stops", async () => {
    const tree = [{ path: "README.md", content: "# A plugin\n" }];
    const { commit } = await pinTree(tree);
    const file = `${checkout(commit)}.json`;
    const { url, ...written } = JSON.parse(readFileSync(file, "utf8")) as { url: string; component: string };
    // A listing as an earlier version wrote it, with no URL, and a file someone changed since.
    writeFileSync(file, JSON.stringify(written));
    writeFileSync(join(checkout(commit), "README.md"), "# Changed\n");

    expect(await on.run("decide", commit, "--verdict", "approved")).toEqual({ code: EXIT.failed, output: { error: "bad-checkout", component: commit } });

    const again = await pinTree(tree);

    expect(again.outcome).toMatchObject({ code: EXIT.ok, output: { component: commit, files: 1 } });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ component: commit, url });
    expect(readFileSync(join(checkout(commit), "README.md"), "utf8")).toBe("# A plugin\n");
  });

  it("refuses to pin a commit again from another URL, before any call, and keeps the first", async () => {
    const tree = [{ path: "README.md", content: "# A plugin\n" }];
    const { commit } = await pinTree(tree);
    const requests = on.requests.length;

    const again = await pin(on, tree, "https://git.fellbeck-tools.example/a-mirror.git");

    expect(again.outcome).toEqual({
      code: EXIT.invalid,
      output: { error: "pinned-from-another-url", component: commit, url: "https://git.fellbeck-tools.example/plugin.git" },
    });
    expect(on.requests).toHaveLength(requests);
  });

  it("refuses a remote that is not HTTPS, or not on an Artifacts host, before Git runs", async () => {
    const plugin = demoPlugin(on);
    const wrong = ["http://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/a-team/copy.git", "https://git.other-host.example/git/a-team/copy.git"];
    for (const remote of wrong) {
      on.node.remote = () => remote;
      const outcome = await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);
      expect(outcome, remote).toEqual({ code: EXIT.node, output: { error: "node-bad-answer" } });
    }
    expect(on.gitCalls).toEqual([]);
  });

  it("stops before any call when the admin key is not in the environment", async () => {
    const plugin = demoPlugin(on);
    delete on.env["CAIRNFIELD_ADMIN_KEY"];
    const outcome = await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);
    expect(outcome).toEqual({ code: EXIT.usage, output: { error: "no-key", key: "CAIRNFIELD_ADMIN_KEY" } });
    expect(on.requests).toEqual([]);
  });

  it("says what the node refused", async () => {
    const plugin = demoPlugin(on);
    on.node.importRefusal = "refused";
    const outcome = await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);
    expect(outcome).toEqual({ code: EXIT.node, output: { error: "node-refused", reason: "refused" } });
  });

  it.each([
    ["no commit", ["pin", "https://git.fellbeck-tools.example/plugin.git", "--branch", "main"]],
    ["a short commit", ["pin", "https://git.fellbeck-tools.example/plugin.git", "--branch", "main", "--commit", "f7bea8e"]],
    ["no branch", ["pin", "https://git.fellbeck-tools.example/plugin.git", "--commit", "1f".repeat(20)]],
    ["a Git URL that is not HTTPS", ["pin", "git@git.fellbeck-tools.example:plugin.git", "--branch", "main", "--commit", "1f".repeat(20)]],
    ["an option it does not know", ["pin", "https://git.fellbeck-tools.example/plugin.git", "--branch", "main", "--commit", "1f".repeat(20), "--force"]],
  ])("refuses %s", async (_why, argv) => {
    expect(await on.run(...argv)).toEqual({ code: EXIT.usage, output: { error: "usage" } });
    expect(on.requests).toEqual([]);
  });
});
