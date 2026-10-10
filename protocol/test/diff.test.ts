import { describe, expect, it } from "vitest";
import { diffLines, hunksTouch } from "../src/diff.ts";
import type { Hunk } from "../src/diff.ts";
import { lines, utf8 } from "./fixtures.ts";

const NO_LIMIT = 10_000;
const diff = (before: string, after: string, max = NO_LIMIT) => diffLines(utf8(before), utf8(after), max);

/** Applies hunks to the old lines, taking added lines from the new lines. */
function apply(before: string[], after: string[], hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  let next = 1;
  for (const hunk of hunks) {
    out.push(...before.slice(next - 1, hunk.oldStart - 1));
    out.push(...after.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.added));
    next = hunk.oldStart + hunk.removed;
  }
  out.push(...before.slice(next - 1));
  return out;
}

/** The length of the longest common subsequence, by the textbook table. */
function longestCommon(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1] ?? 0);
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

describe("line diff", () => {
  it("finds no change between equal content", () => {
    expect(diff(lines(5), lines(5))).toEqual({ hunks: [], removed: 0, added: 0 });
    expect(diff("", "")).toEqual({ hunks: [], removed: 0, added: 0 });
  });

  it("reports one deleted line", () => {
    expect(diff("a\nb\nc\nd\n", "a\nb\nd\n")).toEqual({
      hunks: [{ oldStart: 3, removed: 1, newStart: 3, added: 0 }],
      removed: 1,
      added: 0,
    });
  });

  it("reports one changed line as one removed and one added", () => {
    expect(diff("a\nb\nc\n", "a\nB\nc\n")).toEqual({
      hunks: [{ oldStart: 2, removed: 1, newStart: 2, added: 1 }],
      removed: 1,
      added: 1,
    });
  });

  it("reports an inserted line at the old line it goes in front of", () => {
    expect(diff("a\nb\nc\n", "a\nb\nx\nc\n")).toEqual({
      hunks: [{ oldStart: 3, removed: 0, newStart: 3, added: 1 }],
      removed: 0,
      added: 1,
    });
  });

  it("reports lines added at the end one past the last old line", () => {
    expect(diff("a\nb\n", "a\nb\nx\ny\n")).toEqual({
      hunks: [{ oldStart: 3, removed: 0, newStart: 3, added: 2 }],
      removed: 0,
      added: 2,
    });
  });

  it("reports separate changes as separate hunks", () => {
    const before = lines(10);
    const after = lines(10, (line) => (line === 2 || line === 8 ? `changed ${line}` : `line ${line}`));
    expect(diff(before, after)).toEqual({
      hunks: [
        { oldStart: 2, removed: 1, newStart: 2, added: 1 },
        { oldStart: 8, removed: 1, newStart: 8, added: 1 },
      ],
      removed: 2,
      added: 2,
    });
  });

  it("handles an empty side", () => {
    expect(diff("", "a\nb\n")).toEqual({
      hunks: [{ oldStart: 1, removed: 0, newStart: 1, added: 2 }],
      removed: 0,
      added: 2,
    });
    expect(diff("a\nb\n", "")).toEqual({
      hunks: [{ oldStart: 1, removed: 2, newStart: 1, added: 0 }],
      removed: 2,
      added: 0,
    });
  });

  it("counts a line break added to the last line as a change to that line", () => {
    expect(diff("a\nb", "a\nb\n")).toMatchObject({ removed: 1, added: 1 });
  });

  it("counts a changed line ending as a change", () => {
    expect(diff("a\nb\n", "a\r\nb\n")).toMatchObject({ removed: 1, added: 1 });
  });

  it("compares bytes, so two lines that are not UTF-8 still differ", () => {
    const before = new Uint8Array([0xff, 0x0a, 0x61, 0x0a]);
    const after = new Uint8Array([0xfe, 0x0a, 0x61, 0x0a]);
    expect(diffLines(before, after, NO_LIMIT)).toMatchObject({ removed: 1, added: 1 });
    expect(diffLines(before, before.slice(), NO_LIMIT)).toMatchObject({ removed: 0, added: 0 });
  });

  it("gives nothing when the changes pass the limit, and the diff at the limit", () => {
    const before = lines(40);
    const after = lines(40, (line) => (line <= 3 ? `changed ${line}` : `line ${line}`));
    expect(diff(before, after, 6)).toMatchObject({ removed: 3, added: 3 });
    expect(diff(before, after, 5)).toBeUndefined();
    expect(diff(lines(61), "", 60)).toBeUndefined();
    expect(diff(lines(60), "", 60)).toMatchObject({ removed: 60, added: 0 });
    expect(diff(lines(5), lines(5), 0)).toEqual({ hunks: [], removed: 0, added: 0 });
  });

  it("finds the smallest change and hunks that rebuild the new content", () => {
    // A fixed sequence, so the run is the same every time.
    let seed = 20261006;
    const random = (below: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % below;
    };
    const words = ["alpha", "beta", "gamma", "delta"];
    for (let round = 0; round < 300; round++) {
      const before = Array.from({ length: random(9) }, () => `${words[random(words.length)]}\n`);
      const after = Array.from({ length: random(9) }, () => `${words[random(words.length)]}\n`);
      const result = diff(before.join(""), after.join(""));
      if (result === undefined) throw new Error("the diff gave nothing under a wide limit");
      const common = longestCommon(before, after);
      expect(result.removed).toBe(before.length - common);
      expect(result.added).toBe(after.length - common);
      expect(result.hunks.reduce((sum, hunk) => sum + hunk.removed, 0)).toBe(result.removed);
      expect(result.hunks.reduce((sum, hunk) => sum + hunk.added, 0)).toBe(result.added);
      expect(apply(before, after, result.hunks)).toEqual(after);
      expect(diff(before.join(""), after.join(""))).toEqual(result);
      // A run that only removes or only adds sits at the last place that gives this content:
      // one line down, its first line would have to equal the line after it.
      for (const hunk of result.hunks) {
        if (hunk.added === 0) expect(before[hunk.oldStart - 1 + hunk.removed]).not.toBe(before[hunk.oldStart - 1]);
        if (hunk.removed === 0) expect(after[hunk.newStart - 1 + hunk.added]).not.toBe(after[hunk.newStart - 1]);
      }
    }
  });
});

describe("hunks that overlap or adjoin", () => {
  const removal = (oldStart: number, removed: number): Hunk => ({ oldStart, removed, newStart: oldStart, added: 0 });
  const insertion = (oldStart: number): Hunk => ({ oldStart, removed: 0, newStart: oldStart, added: 1 });

  it("touch when they share a line", () => {
    expect(hunksTouch(removal(10, 11), removal(18, 8))).toBe(true);
    expect(hunksTouch(removal(18, 8), removal(10, 11))).toBe(true);
  });

  it("touch when one ends on the line before the other starts", () => {
    expect(hunksTouch(removal(10, 11), removal(21, 5))).toBe(true);
    expect(hunksTouch(removal(21, 5), removal(10, 11))).toBe(true);
  });

  it("do not touch with an unchanged line between them", () => {
    expect(hunksTouch(removal(10, 11), removal(22, 5))).toBe(false);
  });

  it("treat an insertion as touching the lines on both sides of it", () => {
    expect(hunksTouch(insertion(21), removal(10, 11))).toBe(true);
    expect(hunksTouch(insertion(10), removal(10, 11))).toBe(true);
    expect(hunksTouch(insertion(22), removal(10, 11))).toBe(false);
    expect(hunksTouch(insertion(9), removal(10, 11))).toBe(false);
    expect(hunksTouch(insertion(5), insertion(5))).toBe(true);
    expect(hunksTouch(insertion(5), insertion(6))).toBe(false);
  });
});
