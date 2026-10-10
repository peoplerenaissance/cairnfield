// How the command bounds what Git gives back. What Git lists and reads may come from a
// repo the command does not trust, so no call keeps more output than it was allowed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTree, runGit, said, withScratch } from "../src/git.ts";
import { EXIT, outcomeOf } from "../src/outcome.ts";
import { bench } from "./support.ts";
import type { Bench } from "./support.ts";

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const env = { PATH: process.env["PATH"] ?? "" };

describe("a Git call", () => {
  it("keeps what Git wrote when it stays under its limit", async () => {
    const run = await runGit(["--version"], { env, maxOutput: 1024 });
    expect(run).toMatchObject({ code: 0, overflowed: false });
    expect(said(run)).toMatch(/^git version /);
  });

  it("is stopped when Git writes more than its limit, and keeps none of the rest", async () => {
    const run = await runGit(["help", "--all"], { env, maxOutput: 64 });
    expect(run.overflowed).toBe(true);
    expect(run.stdout.length).toBeLessThanOrEqual(64);
  });
});

describe("a Git call that is ended through its signal", () => {
  it("comes back as a run that failed, and never as an error", async () => {
    const ending = new AbortController();
    ending.abort();

    const run = await runGit(["--version"], { env, maxOutput: 1024, signal: ending.signal });

    expect(run.code).not.toBe(0);
  });
});

describe("the listing of a commit's tree", () => {
  it("ends the command with the caller's code when it is larger than the caller allows", async () => {
    const listed = await outcomeOf(() =>
      withScratch(on.io, async (scratch) => {
        const index = `${scratch.dir}/index`;
        const blob = said(await scratch.git("hash-object", ["hash-object", "-w", "--stdin"], { input: new TextEncoder().encode("x\n") }));
        const entries = Array.from({ length: 50 }, (_, at) => `100644 blob ${blob}\tfolder/file-${at}.txt\n`).join("");
        await scratch.git("update-index", ["update-index", "--add", "--index-info"], { index, input: new TextEncoder().encode(entries) });
        const tree = said(await scratch.git("write-tree", ["write-tree"], { index }));
        const commit = said(await scratch.git("commit-tree", ["commit-tree", tree, "-m", "a test commit"]));

        const all = await listTree(scratch, commit, { bytes: 1024 * 1024, error: "component-too-large" });
        expect(all.map((entry) => entry.size)).toEqual(Array.from({ length: 50 }, () => 2));

        await listTree(scratch, commit, { bytes: 500, error: "component-too-large" });
        return { code: EXIT.ok, output: {} };
      }),
    );
    expect(listed).toEqual({ code: EXIT.failed, output: { error: "component-too-large" } });
  });
});
