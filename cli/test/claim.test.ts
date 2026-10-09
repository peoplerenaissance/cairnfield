// `claim`: the command writes a claim record and publishes it through the outbox (R15).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordId, validateRecordFile } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import { NODE, OUTBOX, bench, finding, pinned, published, putFile, putRecord } from "./support.ts";
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

  it("publishes its own record and leaves the rest of the outbox waiting", async () => {
    const { first } = await pinned(on);
    const waiting = await putRecord(on, finding(first));
    putFile(on, "notes.txt", "not a record, and not this command's to refuse\n");

    const outcome = await on.run("claim", first, "--kind", "review", "--check", "code");

    const path = `records/${first}/claim/${String(outcome.output["claim"])}.json`;
    expect(outcome).toMatchObject({ code: EXIT.ok, output: { records: 1, published: [path] } });
    expect(published(on)).toEqual([path]);
    expect(published(on)).not.toContain(waiting);
  });

  it("leaves nothing in the outbox when the admin key is not in the environment", async () => {
    const { first } = await pinned(on);
    delete on.env["CAIRNFIELD_ADMIN_KEY"];

    const outcome = await on.run("claim", first, "--kind", "review", "--check", "code");

    expect(outcome).toEqual({ code: EXIT.usage, output: { error: "no-key", key: "CAIRNFIELD_ADMIN_KEY" } });
    expect(await on.run("validate")).toEqual({ code: EXIT.ok, output: { records: 0, rejected: [] } });
  });

  it("names the claim and its number when publishing stops, so the same claim can be published later", async () => {
    const { first } = await pinned(on);
    on.nextRandom = 12;
    on.respond = (seen) => {
      if (seen.url === `${NODE}/admin/team-repo`) throw new TypeError("fetch failed");
      return undefined;
    };

    const stopped = await on.run("claim", first, "--kind", "review", "--check", "code");

    const record = { version: "1", type: "claim", component: first, kind: "review", number: 12, check: "code" };
    const id = await recordId(record);
    expect(stopped).toEqual({ code: EXIT.node, output: { claim: id, number: 12, error: "node-unreachable" } });

    on.respond = undefined;
    expect(await on.run("publish")).toMatchObject({ code: EXIT.ok, output: { published: [`records/${first}/claim/${id}.json`] } });
  });

  it.each([
    ["no kind", ["--check", "code"], { reason: "unknown-value", field: "kind" }],
    ["a review claim with no check", ["--kind", "review"], { reason: "unknown-value", field: "check" }],
    [
      "a review claim that names findings",
      ["--kind", "review", "--check", "code", "--findings", sha("a")],
      { reason: "unknown-field", field: "findings" },
    ],
    ["a patch claim with no intent", ["--kind", "patch", "--findings", sha("a")], { reason: "unknown-value", field: "intent" }],
    ["a check that is not on the list", ["--kind", "review", "--check", "vibes"], { reason: "unknown-value", field: "check" }],
    ["a number that is no whole number", ["--kind", "review", "--check", "code", "--number", "1.5"], {}],
    ["a number below zero", ["--kind", "review", "--check", "code", "--number", "-1"], {}],
  ])("refuses %s, and says which field when the protocol names one", async (_why, argv, detail) => {
    const { first } = await pinned(on);
    expect(await on.run("claim", first, ...argv)).toEqual({ code: EXIT.usage, output: { error: "usage", ...detail } });
    expect(await on.run("validate")).toEqual({ code: EXIT.ok, output: { records: 0, rejected: [] } });
  });
});
