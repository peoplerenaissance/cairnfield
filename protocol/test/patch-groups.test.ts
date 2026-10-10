import { describe, expect, it } from "vitest";
import { patchGroups, patchesTouch } from "../src/patch-groups.ts";
import type { ChangedLines } from "../src/patch-groups.ts";

const BLOB_SETTINGS = "aa".repeat(20);
const BLOB_SKILL = "bb".repeat(20);

interface Named extends ChangedLines {
  readonly name: string;
}

/** A patch that replaces lines `start` to `end` of one content, each with one new line. */
function replaces(name: string, blob: string, start: number, end: number): Named {
  const lines = end - start + 1;
  return { name, changes: [{ blob, hunks: [{ oldStart: start, removed: lines, newStart: start, added: lines }] }] };
}

const names = (groups: readonly (readonly Named[])[]): string[][] => groups.map((group) => group.map(({ name }) => name));

describe("patches side by side (R16)", () => {
  it("touch when they change adjoining lines of one content, and not when a line lies between them", () => {
    expect(patchesTouch(replaces("a", BLOB_SETTINGS, 12, 12), replaces("b", BLOB_SETTINGS, 13, 13))).toBe(true);
    expect(patchesTouch(replaces("a", BLOB_SETTINGS, 12, 12), replaces("b", BLOB_SETTINGS, 14, 14))).toBe(false);
  });

  it("do not touch on the same lines of two contents", () => {
    expect(patchesTouch(replaces("a", BLOB_SETTINGS, 12, 12), replaces("b", BLOB_SKILL, 12, 12))).toBe(false);
  });

  it("sit in one group when they touch, and each in a group of its own when they do not", () => {
    const groups = patchGroups([
      replaces("any-host", BLOB_SETTINGS, 12, 12),
      replaces("hidden-line", BLOB_SKILL, 41, 41),
      replaces("every-variable", BLOB_SETTINGS, 13, 13),
    ]);
    expect(names(groups)).toEqual([["hidden-line"], ["any-host", "every-variable"]]);
  });

  it("join two groups through a patch that touches both", () => {
    const groups = patchGroups([
      replaces("first", BLOB_SETTINGS, 1, 2),
      replaces("last", BLOB_SETTINGS, 9, 10),
      replaces("between", BLOB_SETTINGS, 3, 8),
    ]);
    expect(names(groups)).toEqual([["first", "last", "between"]]);
  });

  it("leave a patch that changes no line, such as a change of mode, in a group of its own", () => {
    const modeOnly: Named = { name: "mode", changes: [{ blob: BLOB_SETTINGS, hunks: [] }] };
    expect(names(patchGroups([modeOnly, replaces("line", BLOB_SETTINGS, 1, 1)]))).toEqual([["mode"], ["line"]]);
  });
});
