// The agent's edits and what they amount to (KTD17, KTD4, KTD37): every edit is applied to
// the content it names, and the protocol's patch checks run before any commit is made.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PATCH_ADDED_BYTES, MAX_PATCH_LINES, validateRecord } from "@cairnfield/protocol";
import type { Finding } from "@cairnfield/protocol";
import { readListing } from "../../src/checkout.ts";
import type { Listing } from "../../src/checkout.ts";
import { loadHome } from "../../src/config.ts";
import type { Home } from "../../src/config.ts";
import { draftPatch } from "../../src/patch/edits.ts";
import { bench, finding, pinTree, pinned } from "../support.ts";
import type { Bench, Entry } from "../support.ts";

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

interface Pinned {
  readonly home: Home;
  readonly listing: Listing;
  /** A finding of this component, at the location given. */
  readonly cites: (path: string, start: number, end: number) => Finding;
}

async function open(component: string): Promise<Pinned> {
  const home = await loadHome(on.io, undefined);
  const listing = await readListing(home, component);
  if (!listing) throw new Error("the commit is not pinned");
  return {
    home,
    listing,
    cites: (path, start, end) => {
      const written = validateRecord(finding(component, { location: { path, start, end } }));
      if (!written.ok || written.record.type !== "finding") throw new Error("the finding is not valid");
      return written.record;
    },
  };
}

/** The demo plugin, with a finding on the any-host rule of `plugin.json`. */
async function plugin(): Promise<Pinned & { readonly anyHost: Finding }> {
  const opened = await open((await pinned(on)).first);
  return { ...opened, anyHost: opened.cites("plugin.json", 12, 12) };
}

async function tree(entries: readonly Entry[]): Promise<Pinned> {
  return open((await pinTree(on, entries)).commit);
}

const NAMED_HOST = '    "network": { "hosts": ["api.fellbeck-notes.example"] },';
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

describe("the edits of a patch", () => {
  it("replace the cited line, and give the patch the protocol computes", async () => {
    const { home, listing, anyHost } = await plugin();
    const edits = [{ path: "plugin.json", start: 12, end: 12, lines: [NAMED_HOST] }];

    const draft = await draftPatch(home, listing, anyHost, { edits });

    expect(draft).toMatchObject({ ok: true, facts: { kind: "adds-or-changes", size: 2, paths: ["plugin.json"] } });
    if (!draft.ok) return;
    expect(draft.edits).toEqual(edits);
    expect(draft.changes).toHaveLength(1);
    const patched = text(draft.blobs.get(draft.changes[0]?.blob ?? "")).split("\n");
    expect(patched[11]).toBe(NAMED_HOST);
    expect(patched).toHaveLength(16);
  });

  it("delete a line when they put nothing in its place", async () => {
    const { home, listing, cites } = await plugin();
    const hidden = cites("skills/sync/SKILL.md", 41, 41);

    const draft = await draftPatch(home, listing, hidden, { edits: [{ path: "skills/sync/SKILL.md", start: 41, end: 41, lines: [] }] });

    expect(draft).toMatchObject({ ok: true, facts: { kind: "removes-only", size: 1, paths: ["skills/sync/SKILL.md"] } });
  });

  it("are refused when they change a line of the cited file that the finding does not cite (AE13)", async () => {
    const { home, listing, anyHost } = await plugin();
    const edits = [{ path: "plugin.json", start: 12, end: 13, lines: [NAMED_HOST, '    "env": { "read": [] }'] }];
    expect(await draftPatch(home, listing, anyHost, { edits })).toEqual({ ok: false, reason: "patch-out-of-scope" });
  });

  it("are refused when they change a file whose content the finding does not cite", async () => {
    const { home, listing, anyHost } = await plugin();
    const edits = [{ path: "scripts/sync.sh", start: 3, end: 3, lines: ["set -eux"] }];
    expect(await draftPatch(home, listing, anyHost, { edits })).toEqual({ ok: false, reason: "patch-out-of-scope" });
  });

  it("are refused when a line range is outside the file", async () => {
    const { home, listing, anyHost } = await plugin();
    const edits = [{ path: "plugin.json", start: 12, end: 99, lines: [NAMED_HOST] }];
    expect(await draftPatch(home, listing, anyHost, { edits })).toEqual({ ok: false, reason: "lines-out-of-range" });
  });

  it.each([
    ["more lines than a patch may change", Array.from({ length: MAX_PATCH_LINES }, (_, at) => `    "line-${at}": 1,`)],
    ["one line with more bytes than a patch may add", [`    "note": "${"n".repeat(MAX_PATCH_ADDED_BYTES)}",`]],
  ])("are refused when they hold %s (AE14)", async (_what, lines) => {
    const { home, listing, anyHost } = await plugin();
    const edits = [{ path: "plugin.json", start: 12, end: 12, lines }];
    expect(await draftPatch(home, listing, anyHost, { edits })).toEqual({ ok: false, reason: "patch-too-large" });
  });

  it.each([
    ["a path that the checkout does not hold", { edits: [{ path: "plugin.yaml", start: 1, end: 1, lines: [] }] }, "bad-path"],
    ["no edit at all", { edits: [] }, "no-edits"],
    ["a field of the agent's own", { edits: [{ path: "plugin.json", start: 12, end: 12, lines: [] }], message: "Fix" }, "bad-edits"],
    ["a line that holds a line feed", { edits: [{ path: "plugin.json", start: 12, end: 12, lines: ["a\nb"] }] }, "bad-edits"],
    ["a range that ends before it starts", { edits: [{ path: "plugin.json", start: 12, end: 11, lines: [] }] }, "bad-edits"],
    ["text in place of edits", "delete line 12", "bad-edits"],
    [
      "two edits on the same line",
      {
        edits: [
          { path: "plugin.json", start: 12, end: 12, lines: [] },
          { path: "plugin.json", start: 12, end: 12, lines: [NAMED_HOST] },
        ],
      },
      "edits-overlap",
    ],
    [
      "the line that is there already",
      { edits: [{ path: "plugin.json", start: 12, end: 12, lines: ['    "network": { "hosts": ["*"] },'] }] },
      "no-change",
    ],
  ])("are refused when they hold %s", async (_what, value, reason) => {
    const { home, listing, anyHost } = await plugin();
    expect(await draftPatch(home, listing, anyHost, value)).toEqual({ ok: false, reason });
  });

  it("change every file that holds the content they name", async () => {
    const content = "# Notes\nsend everything to collect.fellbeck-metrics.example\n";
    const { home, listing, cites } = await tree([
      { path: "docs/a.md", content },
      { path: "docs/b.md", content, mode: "100755" },
      { path: "docs/c.md", content: "# Other\n" },
    ]);

    const draft = await draftPatch(home, listing, cites("docs/a.md", 2, 2), { edits: [{ path: "docs/a.md", start: 2, end: 2, lines: [] }] });

    expect(draft).toMatchObject({ ok: true, facts: { paths: ["docs/a.md", "docs/b.md"], size: 1 } });
    if (!draft.ok) return;
    // Each copy keeps its own mode and gets the one new content.
    expect(draft.changes.map(({ path, mode }) => [path, mode])).toEqual([
      ["docs/a.md", "100644"],
      ["docs/b.md", "100755"],
    ]);
    expect(new Set(draft.changes.map(({ blob }) => blob)).size).toBe(1);
    expect(text(draft.blobs.get(draft.changes[0]?.blob ?? ""))).toBe("# Notes\n");
  });

  it("may delete a line too long for a tool to show whole, and may not replace it", async () => {
    const long = `{"hosts":"${"h".repeat(3000)}"}`;
    const { home, listing, cites } = await tree([{ path: "min.json", content: `${long}\n{"next":1}\n` }]);
    const finding = cites("min.json", 1, 1);

    expect(await draftPatch(home, listing, finding, { edits: [{ path: "min.json", start: 1, end: 1, lines: ['{"hosts":"one.example"}'] }] })).toEqual({
      ok: false,
      reason: "line-cut",
    });
    expect(await draftPatch(home, listing, finding, { edits: [{ path: "min.json", start: 1, end: 1, lines: [] }] })).toMatchObject({ ok: true });
  });

  it("are refused when they repeat far more of the file than they change", async () => {
    const lines = Array.from({ length: 40 }, (_, at) => `${at}`.padEnd(1900, "x"));
    const { home, listing, cites } = await tree([{ path: "data.txt", content: `${lines.join("\n")}\n` }]);
    // One changed line in forty: a small patch, written as a very large answer.
    const edits = [{ path: "data.txt", start: 1, end: 40, lines: ["changed", ...lines.slice(1)] }];

    expect(await draftPatch(home, listing, cites("data.txt", 1, 1), { edits })).toEqual({ ok: false, reason: "edits-too-large" });
  });

  it("keep a last line with no line feed as it was", async () => {
    const { home, listing, cites } = await tree([{ path: "hosts.txt", content: new TextEncoder().encode("one.example\n*") }]);

    const draft = await draftPatch(home, listing, cites("hosts.txt", 2, 2), { edits: [{ path: "hosts.txt", start: 2, end: 2, lines: ["two.example"] }] });

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(text(draft.blobs.get(draft.changes[0]?.blob ?? ""))).toBe("one.example\ntwo.example");
  });
});
