// The protocol's own line diff. The index uses it for patch size, kind and changed
// lines (R11), and assembly uses it to apply patches as line edits (KTD22).
//
// It is the greedy shortest-edit search of Myers. The count of removed and added lines
// is the smallest possible, so it does not depend on this implementation. Where two
// smallest diffs exist, such as which of two equal neighbours was removed, the choice
// made here is fixed, and every caller uses this function. A run of lines that is only
// removed, or only added, is reported at the last place that gives the new content. The
// line scope check relies on that (KTD37).

import { splitLines } from "./lines.ts";

/**
 * One run of changed lines. `oldStart` is the first old line removed. When no line is
 * removed, it is the old line the added lines go in front of, or one past the last line.
 * `newStart` is the first new line added, or where the removed lines would have been.
 * Lines count from 1.
 */
export interface Hunk {
  readonly oldStart: number;
  readonly removed: number;
  readonly newStart: number;
  readonly added: number;
}

export interface LineDiff {
  readonly hunks: readonly Hunk[];
  readonly removed: number;
  readonly added: number;
}

/**
 * Whether two hunks on the same old content overlap or adjoin (R16, KTD22): they share a
 * line, or no unchanged line lies between them.
 */
export function hunksTouch(a: Hunk, b: Hunk): boolean {
  return a.oldStart <= b.oldStart + b.removed && b.oldStart <= a.oldStart + a.removed;
}

// Lines are compared as bytes. Each distinct line gets a number, and the search compares numbers.
function numberLines(lines: readonly Uint8Array[], known: Map<string, number>): Int32Array {
  const numbers = new Int32Array(lines.length);
  lines.forEach((line, i) => {
    let key = "";
    for (let at = 0; at < line.length; at += 4096) {
      key += String.fromCharCode(...line.subarray(at, at + 4096));
    }
    let id = known.get(key);
    if (id === undefined) {
      id = known.size;
      known.set(key, id);
    }
    numbers[i] = id;
  });
  return numbers;
}

// The search and the walk back must make the same choice on each diagonal.
function goesDown(k: number, d: number, reach: (k: number) => number): boolean {
  return k === -d || (k !== d && reach(k - 1) < reach(k + 1));
}

interface Edit {
  readonly insert: boolean;
  /** Old lines consumed before this edit. */
  readonly x: number;
  /** New lines produced before this edit. */
  readonly y: number;
}

/**
 * The smallest set of line changes that turns the old content into the new content.
 * Returns nothing when that takes more than `maxChanges` removed and added lines.
 * The limit bounds the work: time grows with the file size times the limit, and memory
 * with the limit squared. Pass a small limit for content from another team.
 */
export function diffLines(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  maxChanges: number,
): LineDiff | undefined {
  const known = new Map<string, number>();
  const a = numberLines(splitLines(oldContent), known);
  const b = numberLines(splitLines(newContent), known);
  const n = a.length;
  const m = b.length;
  if (!(maxChanges >= Math.abs(n - m))) return undefined;
  const limit = Math.min(n + m, Math.floor(maxChanges));

  // furthest[offset + k] is the furthest old line reached on diagonal k, where k = x - y.
  const offset = limit + 1;
  const furthest = new Int32Array(2 * limit + 3);
  const reach = (k: number): number => furthest[offset + k] ?? 0;
  const snapshots: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    // Keep what the walk back needs: diagonals -d-1 to d+1 as they stood before this round.
    snapshots.push(furthest.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = goesDown(k, d, reach);
      let x = down ? reach(k + 1) : reach(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) return toDiff(walkBack(snapshots, d, n, m));
    }
  }
  return undefined;
}

// Walks from the end to the start through the saved rounds, and returns the edits in order.
function walkBack(snapshots: readonly Int32Array[], rounds: number, n: number, m: number): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = rounds; d > 0; d--) {
    const before = snapshots[d];
    const reach = (k: number): number => before?.[d + 1 + k] ?? 0;
    const k = x - y;
    const down = goesDown(k, d, reach);
    const previousK = down ? k + 1 : k - 1;
    x = reach(previousK);
    y = x - previousK;
    edits.push({ insert: down, x, y });
  }
  return edits.reverse();
}

function toDiff(edits: readonly Edit[]): LineDiff {
  const hunks: Hunk[] = [];
  let open: { oldStart: number; removed: number; newStart: number; added: number } | undefined;
  let nextX = -1;
  let nextY = -1;
  let removed = 0;
  let added = 0;
  for (const edit of edits) {
    // An edit continues the open hunk when no unchanged line lies between them.
    if (open === undefined || edit.x !== nextX || edit.y !== nextY) {
      if (open !== undefined) hunks.push(open);
      open = { oldStart: edit.x + 1, removed: 0, newStart: edit.y + 1, added: 0 };
    }
    if (edit.insert) {
      open.added += 1;
      added += 1;
      nextX = edit.x;
      nextY = edit.y + 1;
    } else {
      open.removed += 1;
      removed += 1;
      nextX = edit.x + 1;
      nextY = edit.y;
    }
  }
  if (open !== undefined) hunks.push(open);
  return { hunks, removed, added };
}
