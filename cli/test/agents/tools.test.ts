// The agent's tools (KTD16): three that read one checkout and one that gives the target.
// A tool answers with a file's text or with a code, and never reads outside the checkout.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutTools } from "../../src/agents/tools.ts";
import type { Toolbox } from "../../src/agents/tools.ts";
import { checkoutDir, readListing } from "../../src/checkout.ts";
import { loadHome } from "../../src/config.ts";
import { bench, pinTree, pinned } from "../support.ts";
import type { Bench } from "../support.ts";

const TARGET = { path: "plugin.json", start: 12, end: 12, observation: "network-access-any-host" };
const OUTSIDE = "kept outside the checkout";

let on: Bench;
let tools: Toolbox;
let checkout: string;
beforeEach(async () => {
  on = bench();
  const { first } = await pinned(on);
  const home = await loadHome(on.io, undefined);
  const listing = await readListing(home, first);
  if (!listing) throw new Error("the commit is not pinned");
  checkout = checkoutDir(home, first);
  tools = checkoutTools(home, listing, TARGET);
  writeFileSync(join(on.home, "outside.txt"), `${OUTSIDE}\n`);
});
afterEach(() => {
  on.dispose();
});

describe("the agent's tools", () => {
  it("gives the target: the path, the lines and the observation of one finding", async () => {
    const answer = await tools.call("get_target", {});
    expect(answer.isError).toBe(false);
    expect(JSON.parse(answer.content)).toEqual(TARGET);
  });

  it("lists the files of the checkout", async () => {
    const answer = await tools.call("list_files", {});
    expect(answer).toEqual({
      isError: false,
      content: ["README.md", "plugin.json", "scripts/export.sh", "scripts/sync.sh", "skills/sync/SKILL.md"].join("\n"),
    });
  });

  it("reads a file from a line on, with the number of each line", async () => {
    const answer = await tools.call("read_file", { path: "plugin.json", from: 12 });
    expect(answer.isError).toBe(false);
    expect(answer.content).toContain('12\t    "network": { "hosts": ["*"] },');
    expect(answer.content).toContain('13\t    "env": { "read": ["*"] }');
    expect(answer.content).not.toContain('"files"');
  });

  it("finds the lines that hold a piece of text", async () => {
    const answer = await tools.call("search_files", { text: '"hosts"' });
    expect(answer).toEqual({ isError: false, content: 'plugin.json:12:    "network": { "hosts": ["*"] },' });
  });

  it.each([["../../../outside.txt"], ["/etc/hosts"], ["scripts/../../../../outside.txt"], [".git/config"]])(
    "refuses the path %s, which is not in the checkout",
    async (path) => {
      expect(await tools.call("read_file", { path, from: 1 })).toEqual({ isError: true, content: "not-in-checkout" });
    },
  );

  it("refuses a file that has become a symbolic link", async () => {
    rmSync(join(checkout, "plugin.json"));
    symlinkSync(join(on.home, "outside.txt"), join(checkout, "plugin.json"));

    expect(await tools.call("read_file", { path: "plugin.json", from: 1 })).toEqual({ isError: true, content: "outside-checkout" });
    expect((await tools.call("search_files", { text: OUTSIDE })).content).toBe("no-match");
  });

  it("refuses a file under a folder that has become a symbolic link", async () => {
    const elsewhere = join(on.home, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "sync.sh"), `${OUTSIDE}\n`);
    rmSync(join(checkout, "scripts"), { recursive: true });
    symlinkSync(elsewhere, join(checkout, "scripts"));

    expect(await tools.call("read_file", { path: "scripts/sync.sh", from: 1 })).toEqual({ isError: true, content: "outside-checkout" });
  });

  it("answers with a code for a file that is gone", async () => {
    rmSync(join(checkout, "plugin.json"));
    expect(await tools.call("read_file", { path: "plugin.json", from: 1 })).toEqual({ isError: true, content: "not-found" });
  });

  it("shows a long line cut short, with a mark", async () => {
    const { commit } = await pinTree(on, [{ path: "min.json", content: `{"hosts":"${"h".repeat(3000)}"}\n` }]);
    const home = await loadHome(on.io, undefined);
    const listing = await readListing(home, commit);
    if (!listing) throw new Error("the commit is not pinned");

    const answer = await checkoutTools(home, listing, TARGET).call("read_file", { path: "min.json", from: 1 });

    expect(answer.content).toBe(`lines 1-1 of 1\n1\t{"hosts":"${"h".repeat(1990)}[cut]`);
  });

  it.each([
    ["a tool it does not have", "run_command", { command: "ls" }, "unknown-tool"],
    ["a path that is no text", "read_file", { path: 5, from: 1 }, "bad-input"],
    ["a line below the first", "read_file", { path: "plugin.json", from: 0 }, "bad-input"],
    ["a line past the last", "read_file", { path: "plugin.json", from: 400 }, "lines-out-of-range"],
    ["a search for nothing", "search_files", { text: "" }, "bad-input"],
  ])("answers %s with a code", async (_what, name, input, code) => {
    expect(await tools.call(name, input)).toEqual({ isError: true, content: code });
  });
});
