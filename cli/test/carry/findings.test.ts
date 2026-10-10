// `carry`: which of a team's own findings move to a newer commit of a component (R37,
// KTD39). A finding is tied to the content it cites, so it carries when the newer commit
// still holds that content, at the same path or at another.

import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordId } from "@cairnfield/protocol";
import { EXIT } from "../../src/outcome.ts";
import { NARROWED, bothRules, pinnedWith } from "../assemble/team.ts";
import { NODE, bench, finding, holdRecords } from "../support.ts";
import type { Bench } from "../support.ts";
import { carry, findingsSaid, patchCiting, patchesSaid, recordOf, recordsAt, release, tree } from "./release.ts";

vi.setConfig({ testTimeout: 60_000 });

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const NOTES = "# Notes\n\nNothing here.\n";
const OTHER_NOTES = "# Notes\n\nSomething new.\n";

describe("carry, for a finding", () => {
  it("carries a finding whose file is unchanged with the same path and lines, under a new record ID and with no claim", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    // The content sits at two paths. The finding names the second in sorted order, and stays there.
    const cited = finding(older, { location: { path: "docs/rules.txt", start: 2, end: 4 } });
    const [id = ""] = await holdRecords(on, [{ ...cited, claim: "c1".repeat(32) }]);
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    const written = { ...cited, component: newer };
    const as = await recordId(written);
    expect(outcome.code).toBe(EXIT.ok);
    expect(findingsSaid(outcome)).toEqual([{ finding: id, carried: true, reason: "content-unchanged", as, path: "docs/rules.txt" }]);
    expect(as).not.toBe(id);
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${as}.json`]);
    expect(recordOf(on, newer, "finding", as)).toEqual(written);
  });

  it("carries a finding whose content moved to the first path in sorted order that holds it, and places a second location by the same rule", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const moved = finding(older, { location: { path: "notes.md", start: 3, end: 3 } });
    const contradicted = finding(older, { location: { path: "config/rules.txt", start: 3, end: 3 }, contradicts: { path: "notes.md", start: 1, end: 1 } });
    const [movedId = "", contradictedId = ""] = await holdRecords(on, [moved, contradicted]);
    const newer = release(on, older, tree({ "notes.md": undefined, "zz/notes.md": NOTES, "archive/notes.md": NOTES }));

    const outcome = await carry(on, older, newer);

    const movedTo = { ...moved, component: newer, location: { path: "archive/notes.md", start: 3, end: 3 } };
    const contradictedAt = { ...contradicted, component: newer, contradicts: { path: "archive/notes.md", start: 1, end: 1 } };
    expect(outcome.code).toBe(EXIT.ok);
    expect(findingsSaid(outcome)).toEqual(
      [
        { finding: movedId, carried: true, reason: "content-moved", as: await recordId(movedTo), path: "archive/notes.md" },
        { finding: contradictedId, carried: true, reason: "content-moved", as: await recordId(contradictedAt), path: "config/rules.txt" },
      ].sort((a, b) => (a.finding < b.finding ? -1 : 1)),
    );
    expect(recordOf(on, newer, "finding", await recordId(movedTo))).toEqual(movedTo);
    expect(recordOf(on, newer, "finding", await recordId(contradictedAt))).toEqual(contradictedAt);
  });

  it("reports a finding whose content changed as not carried, and writes no record for it", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const [id = ""] = await holdRecords(on, [finding(older, { location: { path: "notes.md", start: 3, end: 3 } })]);
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(findingsSaid(outcome)).toEqual([{ finding: id, carried: false, reason: "content-changed" }]);
    expect(recordsAt(on, newer)).toEqual([]);
  });

  it("reports a finding whose second location sits in a file that changed as not carried", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    // The cited line is in a file the newer commit leaves alone. The line it contradicts is not.
    const cited = finding(older, { location: { path: "config/rules.txt", start: 3, end: 3 }, contradicts: { path: "notes.md", start: 3, end: 3 } });
    const [id = ""] = await holdRecords(on, [cited]);
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(findingsSaid(outcome)).toEqual([{ finding: id, carried: false, reason: "second-location-changed" }]);
    expect(recordsAt(on, newer)).toEqual([]);
  });

  it("reports a finding that does not pass the checks at the older commit as refused, with the check's code, and carries the rest", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const valid = finding(older, { location: { path: "notes.md", start: 3, end: 3 } });
    // The file has three lines. A push by hand put this record in the team repo, and no publish would have.
    const pastTheEnd = finding(older, { location: { path: "notes.md", start: 9, end: 9 } });
    const [validId = "", refusedId = ""] = await holdRecords(on, [valid, pastTheEnd]);
    const newer = release(on, older, tree({ "run.sh": "#!/bin/sh\nexec sync --once\n" }));

    const outcome = await carry(on, older, newer);

    const as = await recordId({ ...valid, component: newer });
    expect(outcome.code).toBe(EXIT.ok);
    expect(findingsSaid(outcome)).toEqual(
      [
        { finding: validId, carried: true, reason: "content-unchanged", as, path: "notes.md" },
        { finding: refusedId, carried: false, reason: "refused", check: "lines-out-of-range" },
      ].sort((a, b) => (a.finding < b.finding ? -1 : 1)),
    );
    expect(recordsAt(on, newer)).toEqual([`records/${newer}/finding/${as}.json`]);
  });

  it("reports a finding the node lists and does not serve as refused, and carries no patch that cites it", async () => {
    const older = await pinnedWith(on, { patchLevel: 1 });
    const made = await patchCiting(on, older, [finding(older, { location: { path: "config/rules.txt", start: 3, end: 3 } })], bothRules(NARROWED));
    const [id = ""] = made.findings;
    const newer = release(on, older, tree({ "notes.md": OTHER_NOTES }));
    // The listing names the file, and the node answers for it as for a file it does not hold.
    const unserved = `records/${older}/finding/${id}.json`;
    on.respond = (seen) => {
      const { origin, pathname, searchParams } = new URL(seen.url);
      return origin === NODE && pathname === "/file" && searchParams.get("path") === unserved ? Response.json({ error: "not-found" }, { status: 404 }) : undefined;
    };

    const outcome = await carry(on, older, newer);

    expect(outcome.code).toBe(EXIT.ok);
    expect(findingsSaid(outcome)).toEqual([{ finding: id, carried: false, reason: "refused", check: "unresolved-reference" }]);
    // The patch is read as assembly reads one. The node serves that read no finding either, so the patch is refused as citing a record that is not there, with no patch ID.
    expect(patchesSaid(outcome)).toEqual([{ patch: made.id, carried: false, reason: "refused", check: "unresolved-reference" }]);
    expect(existsSync(on.repo(`fork-${newer}`))).toBe(false);
    expect(recordsAt(on, newer)).toEqual([]);
  });
});
