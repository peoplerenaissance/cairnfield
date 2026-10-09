// `validate`: both layers of the protocol's validation on every file of the outbox,
// against the checkout (R3, R21). It needs no key and makes no call.

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordId } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import { bench, finding, pinned, putFile, putRecord, saveOutbox } from "./support.ts";
import type { Bench } from "./support.ts";

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

describe("validate", () => {
  it("accepts the saved findings of both demo teams against the plugin's checkout", async () => {
    await pinned(on);
    saveOutbox(on, "team-a");
    saveOutbox(on, "team-b");
    // Both teams saved the finding on the hidden instruction, byte for byte, so five files are there.
    expect(await on.run("validate")).toEqual({ code: EXIT.ok, output: { records: 5, rejected: [] } });
  });

  it("needs no key and no token, and makes no call", async () => {
    await pinned(on);
    saveOutbox(on, "team-a");
    const requests = on.requests.length;
    const gitCalls = on.gitCalls.length;
    delete on.env["CAIRNFIELD_ADMIN_KEY"];
    delete on.env["CAIRNFIELD_REGISTRATION_KEY"];

    expect(await on.run("validate")).toMatchObject({ code: EXIT.ok, output: { records: 4 } });
    expect(on.requests).toHaveLength(requests);
    expect(on.gitCalls).toHaveLength(gitCalls);
  });

  it("fails on one bad record, and names the record and the reason", async () => {
    const { first } = await pinned(on);
    saveOutbox(on, "team-a");
    const bad = await putRecord(on, finding(first, { observation: "is-suspicious" }));

    expect(await on.run("validate")).toEqual({
      code: EXIT.invalid,
      output: { records: 4, rejected: [{ record: bad, reason: "unknown-value", field: "observation" }] },
    });
  });

  it("refuses a finding written against another commit, whose lines the pinned one does not have", async () => {
    const { first } = await pinned(on);
    // The later commit's sync script has 23 lines, and the pinned one has 21.
    const late = await putRecord(on, finding(first, { location: { path: "scripts/sync.sh", start: 22, end: 23 } }));

    expect(await on.run("validate")).toEqual({
      code: EXIT.invalid,
      output: { records: 0, rejected: [{ record: late, reason: "lines-out-of-range", field: "location" }] },
    });
  });

  it("refuses a finding that names a host its lines do not hold", async () => {
    const { first } = await pinned(on);
    const wrong = await putRecord(
      on,
      finding(first, {
        location: { path: "scripts/sync.sh", start: 14, end: 17 },
        observation: "sends-data-to-host",
        host: "collect.fellbeck-metrics.example",
      }),
    );
    expect(await on.run("validate")).toMatchObject({
      code: EXIT.invalid,
      output: { rejected: [{ record: wrong, reason: "host-not-in-lines", field: "host" }] },
    });
  });

  it("refuses a record of a component that is not pinned here", async () => {
    await pinned(on);
    const elsewhere = await putRecord(on, finding("2e".repeat(20)));
    expect(await on.run("validate")).toEqual({
      code: EXIT.invalid,
      output: { records: 0, rejected: [{ record: elsewhere, reason: "unknown-component" }] },
    });
  });

  it("names the path a record belongs at when its file has another name", async () => {
    const { first } = await pinned(on);
    const record = finding(first);
    const id = await recordId(record);
    const misnamed = `records/${first}/finding/${"0".repeat(64)}.json`;
    putFile(on, misnamed, JSON.stringify(record));

    expect(await on.run("validate")).toEqual({
      code: EXIT.invalid,
      output: {
        records: 0,
        rejected: [{ record: misnamed, reason: "hash-mismatch", expected: `records/${first}/finding/${id}.json` }],
      },
    });
  });

  it("tells a record that was saved under a name of the writer's own where it belongs", async () => {
    const { first } = await pinned(on);
    const record = finding(first);
    putFile(on, "my-finding.json", JSON.stringify(record, null, 2));

    expect(await on.run("validate")).toEqual({
      code: EXIT.invalid,
      output: {
        records: 0,
        rejected: [{ record: "my-finding.json", reason: "bad-path", expected: `records/${first}/finding/${await recordId(record)}.json` }],
      },
    });
  });

  it("refuses a file that is no record file, and one that is too large to be a record", async () => {
    const { first } = await pinned(on);
    putFile(on, "notes.txt", "remember to look at the export script\n");
    const large = `records/${first}/finding/${"1".repeat(64)}.json`;
    putFile(on, large, " ".repeat(5000));

    expect(await on.run("validate")).toEqual({
      code: EXIT.invalid,
      output: {
        records: 0,
        rejected: [
          { record: "notes.txt", reason: "bad-path" },
          { record: large, reason: "too-large" },
        ],
      },
    });
  });

  it("stops when a cited file of the checkout is no longer what was exported", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    appendFileSync(join(on.home, ".cairnfield/checkouts", first, "plugin.json"), "\n");

    expect(await on.run("validate")).toEqual({ code: EXIT.failed, output: { error: "bad-checkout", component: first } });
  });

  it("stops when the listing of a checkout cannot be read", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    writeFileSync(join(on.home, ".cairnfield/checkouts", `${first}.json`), '{ "component": "');

    expect(await on.run("validate")).toEqual({ code: EXIT.failed, output: { error: "bad-checkout", component: first } });
  });

  it("fails when the outbox is there and cannot be read, and does not call it empty", async () => {
    await pinned(on);
    writeFileSync(join(on.home, ".cairnfield/outbox"), "a file where the folder should be\n");

    expect(await on.run("validate")).toEqual({ code: EXIT.failed, output: { error: "outbox-unreadable" } });
    expect(await on.run("publish")).toEqual({ code: EXIT.failed, output: { error: "outbox-unreadable" } });
  });

  it("finds nothing wrong with an outbox that does not exist yet", async () => {
    expect(await on.run("validate")).toEqual({ code: EXIT.ok, output: { records: 0, rejected: [] } });
  });
});
