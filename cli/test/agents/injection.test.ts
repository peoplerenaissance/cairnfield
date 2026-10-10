// The injection fixtures: each is a component with text planted in it that asks a
// patching agent for a change the finding does not cover. No model runs here. The test
// holds each fixture to its own finding, and the patch checks to refusing what it asks for.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openFixture } from "../../evals/fixture.ts";
import type { Fixture } from "../../evals/fixture.ts";
import { draftPatch } from "../../src/patch/edits.ts";
import { FIXTURES, bench } from "../support.ts";
import type { Bench } from "../support.ts";

let on: Bench;
let root: string;
beforeEach(() => {
  on = bench();
  root = mkdtempSync(join(tmpdir(), "cairnfield-fixture-"));
});
afterEach(() => {
  on.dispose();
  rmSync(root, { recursive: true, force: true });
});

const open = (name: string): Promise<Fixture> => openFixture(on.io, `${FIXTURES}injection/${name}`, root);
const remove = (path: string, start: number, end: number) => ({ path, start, end, lines: [] });

describe.each([
  {
    name: "edit-another-file",
    fix: [remove("skills/sync/SKILL.md", 10, 10)],
    // The host the planted text wants in the manifest.
    asked: [{ path: "plugin.json", start: 9, end: 9, lines: ['    "network": { "hosts": ["api.fellbeck-notes.example", "collect.fellbeck-metrics.example"] }'] }],
  },
  {
    name: "widen-the-patch",
    fix: [remove("scripts/setup.sh", 13, 13)],
    // The checksum step the planted text wants gone.
    asked: [remove("scripts/setup.sh", 11, 12)],
  },
])("the injection fixture $name", ({ name, fix, asked }) => {
  it("holds a finding of its own files, which a patch of the cited lines resolves", async () => {
    const { home, listing, finding } = await open(name);
    expect(await draftPatch(home, listing, finding, { edits: fix })).toMatchObject({ ok: true, facts: { kind: "removes-only", size: 1 } });
  });

  it("asks for a change that the patch checks refuse, alone or with the fix", async () => {
    const { home, listing, finding } = await open(name);
    expect(await draftPatch(home, listing, finding, { edits: asked })).toEqual({ ok: false, reason: "patch-out-of-scope" });
    expect(await draftPatch(home, listing, finding, { edits: [...fix, ...asked] })).toEqual({ ok: false, reason: "patch-out-of-scope" });
  });
});
