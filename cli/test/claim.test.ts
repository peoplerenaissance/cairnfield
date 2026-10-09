// `claim`: the command writes a claim record and publishes it through the outbox (R15).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordId, validateRecordFile } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import { OUTBOX, bench, pinned, published } from "./support.ts";
import type { Bench } from "./support.ts";

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const sha = (first: string): string => first.repeat(64);

describe("claim", () => {
  it("writes a review claim with a number drawn for this run, and publishes it", async () => {
    const { first } = await pinned(on);
    on.nextRandom = 41_977;

    const outcome = await on.run("claim", first, "--kind", "review", "--check", "instructions");

    const record = { version: "1", type: "claim", component: first, kind: "review", number: 41_977, check: "instructions" };
    const id = await recordId(record);
    const path = `records/${first}/claim/${id}.json`;
    expect(outcome).toMatchObject({ code: EXIT.ok, output: { claim: id, number: 41_977, published: [path] } });
    expect(published(on)).toEqual([path]);
    const written = readFileSync(join(on.home, OUTBOX, path));
    expect(await validateRecordFile(path, written)).toMatchObject({ ok: true, record });
  });

  it("gives two runs two claims, and one number the same claim again", async () => {
    const { first } = await pinned(on);
    const claim = async (...more: string[]): Promise<unknown> =>
      (await on.run("claim", first, "--kind", "review", "--check", "code", ...more)).output["claim"];

    on.nextRandom = 1;
    const one = await claim();
    on.nextRandom = 2;
    const two = await claim();
    expect(two).not.toBe(one);
    // A replay publishes each claim with the number its recording holds.
    expect(await claim("--number", "1")).toBe(one);
    expect(published(on)).toHaveLength(2);
  });

  it("writes a patch claim that names its findings in order", async () => {
    const { first } = await pinned(on);
    const outcome = await on.run(
      "claim",
      first,
      "--kind",
      "patch",
      "--findings",
      `${sha("b")},${sha("a")}`,
      "--intent",
      "new",
      "--number",
      "5",
    );

    const record = { version: "1", type: "claim", component: first, kind: "patch", number: 5, findings: [sha("a"), sha("b")], intent: "new" };
    expect(outcome).toMatchObject({ code: EXIT.ok, output: { claim: await recordId(record), number: 5 } });
  });

  it("writes nothing for a component that is not pinned here", async () => {
    await pinned(on);
    const elsewhere = "2e".repeat(20);
    const requests = on.requests.length;

    const outcome = await on.run("claim", elsewhere, "--kind", "review", "--check", "code");

    expect(outcome).toEqual({ code: EXIT.invalid, output: { error: "unknown-component", component: elsewhere } });
    expect(on.requests).toHaveLength(requests);
    expect(await on.run("validate")).toEqual({ code: EXIT.ok, output: { records: 0, rejected: [] } });
  });

  it.each([
    ["no kind", ["--check", "code"]],
    ["a review claim with no check", ["--kind", "review"]],
    ["a review claim that names findings", ["--kind", "review", "--check", "code", "--findings", sha("a")]],
    ["a patch claim with no intent", ["--kind", "patch", "--findings", sha("a")]],
    ["a check that is not on the list", ["--kind", "review", "--check", "vibes"]],
    ["a number that is no whole number", ["--kind", "review", "--check", "code", "--number", "1.5"]],
    ["a number below zero", ["--kind", "review", "--check", "code", "--number", "-1"]],
  ])("refuses %s", async (_why, argv) => {
    const { first } = await pinned(on);
    expect(await on.run("claim", first, ...argv)).toEqual({ code: EXIT.usage, output: { error: "usage" } });
    expect(await on.run("validate")).toEqual({ code: EXIT.ok, output: { records: 0, rejected: [] } });
  });
});
