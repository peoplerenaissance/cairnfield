// The patch checks of R11, KTD4 and KTD6, as pure functions over a base file set and a
// patched file set. The index runs them on a synced patch commit, and assembly runs them
// again on what it fetched (KTD23). A patch is a set of content replacements. Its
// identity, kind, size and changed lines are computed here and never declared (KTD5).

import { compare } from "./compare.ts";
import { diffLines } from "./diff.ts";
import type { Hunk } from "./diff.ts";
import { DELETED_BLOB, DELETED_MODE, isFileMode } from "./enums.ts";
import type { PatchKind, RejectionReason } from "./enums.ts";
import type { FileEntry, FileListing } from "./files.ts";
import { gitBlobHash, sha256Hex } from "./hash.ts";
import { MAX_BLOB_BYTES, MAX_PATCH_ADDED_BYTES, MAX_PATCH_LINES, MAX_PATCH_REPLACEMENTS } from "./limits.ts";
import { linesOf, splitLines } from "./lines.ts";
import type { LineRange } from "./lines.ts";

/** The files of one commit, with the content of the blobs a check must read, by blob hash. */
export interface FileSet {
  readonly files: FileListing;
  readonly content: ReadonlyMap<string, Uint8Array>;
}

/**
 * The lines of one content that a finding cites. `blob` is the finding's cited content
 * (KTD5). Lines count from 1 and the range includes both ends.
 */
export interface CitedRange {
  readonly blob: string;
  readonly start: number;
  readonly end: number;
}

/** One path a patch commit changes, as a node reports it (KTD7). A deletion carries the deletion marker. */
export type ChangedFile = FileEntry;

/**
 * One content replacement (KTD4): the old blob and mode, and the new blob and mode.
 * A deletion has `DELETED_BLOB` and `DELETED_MODE` as its new side. It names no path
 * and no commit, so it is the same on every copy and on every version.
 */
export interface Replacement {
  readonly oldBlob: string;
  readonly oldMode: string;
  readonly newBlob: string;
  readonly newMode: string;
}

/** A path whose entry differs between the base and the patched file set. */
export interface PathChange {
  readonly path: string;
  /** Missing when the patch adds the path. */
  readonly old?: { readonly blob: string; readonly mode: string };
  /** Missing when the patch deletes the path. */
  readonly new?: { readonly blob: string; readonly mode: string };
}

/** The changed lines of one replaced content, in the old content's line numbers. */
export interface ContentChange {
  readonly blob: string;
  readonly hunks: readonly Hunk[];
}

export interface PatchFacts {
  readonly patchId: string;
  /** In sorted order. */
  readonly replacements: readonly Replacement[];
  readonly kind: PatchKind;
  /** Lines removed plus lines added, summed over the replaced contents. */
  readonly size: number;
  /** One entry per replacement, in the same order. */
  readonly changes: readonly ContentChange[];
  /** Every path the patch changes, sorted. */
  readonly paths: readonly string[];
}

export type PatchVerdict = ({ readonly ok: true } & PatchFacts) | { readonly ok: false; readonly reason: RejectionReason };

function refuse(reason: RejectionReason): { readonly ok: false; readonly reason: RejectionReason } {
  return { ok: false, reason };
}

function byPath(a: { readonly path: string }, b: { readonly path: string }): number {
  return compare(a.path, b.path);
}

/** The patched listing: the base listing with a node's changed files applied. */
export function applyChanges(base: FileListing, changes: readonly ChangedFile[]): FileListing {
  const entries = new Map(base.map((entry) => [entry.path, entry]));
  for (const change of changes) {
    if (change.mode === DELETED_MODE) entries.delete(change.path);
    else entries.set(change.path, { path: change.path, mode: change.mode, blob: change.blob });
  }
  return [...entries.values()].sort(byPath);
}

/** Every path whose blob or mode differs between the two listings, sorted. A mode change counts as a change. */
export function changedPaths(base: FileListing, patched: FileListing): PathChange[] {
  const before = new Map(base.map((entry) => [entry.path, entry]));
  const after = new Map(patched.map((entry) => [entry.path, entry]));
  const changes: PathChange[] = [];
  for (const [path, old] of before) {
    const now = after.get(path);
    if (now === undefined) {
      changes.push({ path, old: { blob: old.blob, mode: old.mode } });
    } else if (now.blob !== old.blob || now.mode !== old.mode) {
      changes.push({ path, old: { blob: old.blob, mode: old.mode }, new: { blob: now.blob, mode: now.mode } });
    }
  }
  for (const [path, now] of after) {
    if (!before.has(path)) changes.push({ path, new: { blob: now.blob, mode: now.mode } });
  }
  return changes.sort(byPath);
}

/** File mode (KTD6): every path a patch changes is a regular file before and after. */
export function modesAreRegular(changes: readonly PathChange[]): boolean {
  return changes.every(
    (change) =>
      (change.old === undefined || isFileMode(change.old.mode)) &&
      (change.new === undefined || isFileMode(change.new.mode)),
  );
}

/**
 * Scope by file (R11): a patch changes only content its findings cite. An added path is
 * out of scope, because no finding can cite content that was not in the pinned commit.
 */
export function isInScope(changes: readonly PathChange[], cited: readonly CitedRange[]): boolean {
  const allowed = new Set(cited.map((range) => range.blob));
  return changes.every((change) => change.old !== undefined && allowed.has(change.old.blob));
}

// The ranges in order. Ranges that overlap or adjoin count as one.
function mergedRanges(cited: readonly LineRange[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const { start, end } of [...cited].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

const NO_CONTENT: Uint8Array = new Uint8Array(0);

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Where `stretch` first lies whole in `lines`, from index `from` and before index `to`,
 * or nothing. This is the search of Knuth, Morris and Pratt, so its time grows with the
 * lines it reads and not with their product, whatever a hostile content repeats.
 */
function findStretch(lines: readonly Uint8Array[], stretch: readonly Uint8Array[], from: number, to: number): number | undefined {
  // A stretch with no line lies anywhere.
  if (stretch.length === 0) return from;
  const same = (line: Uint8Array | undefined, at: number): boolean => sameBytes(line ?? NO_CONTENT, stretch[at] ?? NO_CONTENT);
  // For the stretch up to each line: the longest start of it, short of the whole, that is also its end.
  const fallback = new Int32Array(stretch.length);
  for (let at = 1, held = 0; at < stretch.length; at++) {
    while (held > 0 && !same(stretch[at], held)) held = fallback[held - 1] ?? 0;
    if (same(stretch[at], held)) held += 1;
    fallback[at] = held;
  }
  for (let at = from, held = 0; at < to; at++) {
    while (held > 0 && !same(lines[at], held)) held = fallback[held - 1] ?? 0;
    if (same(lines[at], held)) held += 1;
    if (held === stretch.length) return at + 1 - held;
  }
  return undefined;
}

/**
 * Scope by line (R11, KTD37) for one content: a patch changes only the lines its findings
 * cite. `cited` holds the ranges cited on the old content. They divide it into stretches
 * of lines that no finding cites, and the new content must hold every stretch whole and
 * in order, the first at its start and the last at its end. What stands where a cited
 * range stood may be anything, or nothing. So every removed line is a cited line, and
 * added lines go in front of a cited line or straight after the last one. A deleted file
 * has an empty new content, so every line of it must be cited. The check reads the two
 * contents and no diff, so it does not depend on which of two smallest diffs is reported.
 */
export function linesAreInScope(before: Uint8Array, after: Uint8Array, cited: readonly LineRange[]): boolean {
  const old = splitLines(before);
  const now = splitLines(after);
  // A range that holds no line of the old content cites nothing, and gives a patch no room.
  const ranges = mergedRanges(cited.filter(({ start, end }) => start >= 1 && start <= end && start <= old.length));
  // The stretches of uncited lines: above the first range, between each two, and under the last.
  const stretches: Uint8Array[][] = [];
  let next = 0;
  for (const { start, end } of ranges) {
    stretches.push(old.slice(next, start - 1));
    next = end;
  }
  const last = old.slice(next);
  const holdsAt = (stretch: readonly Uint8Array[], at: number): boolean =>
    stretch.every((line, i) => sameBytes(line, now[at + i] ?? NO_CONTENT));
  const [first, ...between] = stretches;
  // With no cited range the whole content is one stretch, and nothing may change.
  if (first === undefined) return now.length === last.length && holdsAt(last, 0);
  const under = now.length - last.length;
  if (under < first.length || !holdsAt(first, 0) || !holdsAt(last, under)) return false;
  // Each stretch between two ranges is looked for after the one before it.
  let from = first.length;
  for (const stretch of between) {
    const found = findStretch(now, stretch, from, under);
    if (found === undefined) return false;
    from = found + stretch.length;
  }
  return true;
}

function serialize(replacement: Replacement): string {
  return `${replacement.oldBlob} ${replacement.oldMode} ${replacement.newBlob} ${replacement.newMode}\n`;
}

/**
 * The replacements a set of changes amounts to, in sorted order, or nothing when the
 * patch is incomplete (R24). A patch is complete when every path that holds a replaced
 * content is rewritten, and every copy is rewritten the same way. A replacement that
 * changes only the mode covers the copies with that mode, because a copy with another
 * mode has nothing to change. An added path has no old side and replaces nothing, so it
 * also gives nothing. The scope check names it first.
 */
export function replacementsOf(base: FileListing, changes: readonly PathChange[]): Replacement[] | undefined {
  const byOld = new Map<string, Replacement>();
  const newBlobOf = new Map<string, string>();
  const changed = new Set<string>();
  for (const change of changes) {
    if (change.old === undefined) return undefined;
    changed.add(change.path);
    const replacement: Replacement = {
      oldBlob: change.old.blob,
      oldMode: change.old.mode,
      newBlob: change.new?.blob ?? DELETED_BLOB,
      newMode: change.new?.mode ?? DELETED_MODE,
    };
    // One old blob and mode has one new blob and mode.
    const key = `${replacement.oldBlob} ${replacement.oldMode}`;
    const seen = byOld.get(key);
    if (seen !== undefined && serialize(seen) !== serialize(replacement)) return undefined;
    byOld.set(key, replacement);
    // One old content has one new content, whatever the modes of its copies.
    const newBlob = newBlobOf.get(replacement.oldBlob);
    if (newBlob !== undefined && newBlob !== replacement.newBlob) return undefined;
    newBlobOf.set(replacement.oldBlob, replacement.newBlob);
  }
  // No path is left unchanged when its content is replaced, or when its blob and mode are.
  for (const entry of base) {
    if (changed.has(entry.path)) continue;
    const newBlob = newBlobOf.get(entry.blob);
    if (newBlob !== undefined && newBlob !== entry.blob) return undefined;
    if (byOld.has(`${entry.blob} ${entry.mode}`)) return undefined;
  }
  // A patch that changes nothing replaces nothing.
  if (byOld.size === 0) return undefined;
  return [...byOld.values()]
    .map((replacement) => [serialize(replacement), replacement] as const)
    .sort(([a], [b]) => compare(a, b))
    .map(([, replacement]) => replacement);
}

/**
 * The patch ID (KTD4): the SHA-256 over the replacements in sorted order. Each
 * replacement is one line, `<old blob> <old mode> <new blob> <new mode>`, ended by a
 * line feed. No commit and no path goes in, so the same patch on a later version has
 * the same ID, and so do identical patches from two teams.
 */
export async function patchId(replacements: readonly Replacement[]): Promise<string> {
  const text = replacements.map(serialize).sort().join("");
  return sha256Hex(new TextEncoder().encode(text));
}

// Content counts only when it hashes to the blob it is listed under (KTD7).
async function verified(set: FileSet, blob: string): Promise<Uint8Array | undefined> {
  const content = set.content.get(blob);
  if (content === undefined || (await gitBlobHash(content)) !== blob) return undefined;
  return content;
}

const LINE_FEED = 10;

// A line without the line feed that ends it.
function body(line: Uint8Array): Uint8Array {
  return line[line.length - 1] === LINE_FEED ? line.subarray(0, -1) : line;
}

/**
 * Whether every line of the new content is a line of the old content, in the same order.
 * The line feed that ends a line is left out of the comparison, so a patch that deletes
 * the last line of a file with no line feed at its end adds no line.
 */
function addsNoLine(before: Uint8Array, after: Uint8Array): boolean {
  const old = splitLines(before).map(body);
  let at = 0;
  for (const line of splitLines(after).map(body)) {
    while (at < old.length && !sameBytes(old[at] ?? line, line)) at += 1;
    if (at === old.length) return false;
    at += 1;
  }
  return true;
}

/**
 * Size, kind and changed lines. Size is lines removed plus lines added, summed over the
 * replaced contents. The bytes of the added lines have a limit of their own, so one long
 * line cannot carry what sixty lines may not. A content counts once, however many copies
 * it rewrites and whatever their modes. Kind is `removes-only` when the patch adds no
 * line and changes no mode.
 */
export async function measurePatch(
  base: FileSet,
  patched: FileSet,
  replacements: readonly Replacement[],
): Promise<
  | { readonly ok: true; readonly kind: PatchKind; readonly size: number; readonly changes: readonly ContentChange[] }
  | { readonly ok: false; readonly reason: RejectionReason }
> {
  const changes: ContentChange[] = [];
  // Copies with two modes give two replacements and one content change.
  const measured = new Map<string, readonly Hunk[]>();
  let size = 0;
  let addedBytes = 0;
  let addsLine = false;
  let modeChanged = false;
  for (const replacement of replacements) {
    const deleted = replacement.newMode === DELETED_MODE;
    if (!deleted && replacement.newMode !== replacement.oldMode) modeChanged = true;
    if (replacement.newBlob === replacement.oldBlob) {
      changes.push({ blob: replacement.oldBlob, hunks: [] });
      continue;
    }
    const content = `${replacement.oldBlob} ${replacement.newBlob}`;
    const known = measured.get(content);
    if (known !== undefined) {
      changes.push({ blob: replacement.oldBlob, hunks: known });
      continue;
    }
    const before = await verified(base, replacement.oldBlob);
    if (before === undefined) return refuse("blob-mismatch");
    let after: Uint8Array = NO_CONTENT;
    if (!deleted) {
      const served = patched.content.get(replacement.newBlob);
      if (served !== undefined && served.length > MAX_BLOB_BYTES) return refuse("too-large");
      const checked = await verified(patched, replacement.newBlob);
      if (checked === undefined) return refuse("blob-mismatch");
      after = checked;
    }
    // The diff stops as soon as the patch passes the size limit.
    const diff = diffLines(before, after, MAX_PATCH_LINES - size);
    if (diff === undefined) return refuse("patch-too-large");
    size += diff.removed + diff.added;
    for (const hunk of diff.hunks) {
      if (hunk.added > 0) addedBytes += linesOf(after, hunk.newStart, hunk.newStart + hunk.added - 1)?.length ?? 0;
    }
    if (addedBytes > MAX_PATCH_ADDED_BYTES) return refuse("patch-too-large");
    if (diff.added > 0 && !addsNoLine(before, after)) addsLine = true;
    measured.set(content, diff.hunks);
    changes.push({ blob: replacement.oldBlob, hunks: diff.hunks });
  }
  const kind: PatchKind = !addsLine && !modeChanged ? "removes-only" : "adds-or-changes";
  return { ok: true, kind, size, changes };
}

/**
 * Runs every patch check in a fixed order and returns the first failure, or the computed
 * facts. The order is file mode, scope by file, completeness, number of replacements,
 * served content, size, then scope by line. `cited` holds the lines that the patch's
 * findings cite.
 */
export async function checkPatch(input: {
  readonly base: FileSet;
  readonly patched: FileSet;
  readonly cited: readonly CitedRange[];
}): Promise<PatchVerdict> {
  const { base, patched, cited } = input;
  const changes = changedPaths(base.files, patched.files);
  if (!modesAreRegular(changes)) return refuse("bad-mode");
  if (!isInScope(changes, cited)) return refuse("patch-out-of-scope");
  const replacements = replacementsOf(base.files, changes);
  if (replacements === undefined) return refuse("patch-incomplete");
  if (replacements.length > MAX_PATCH_REPLACEMENTS) return refuse("patch-too-large");
  const measured = await measurePatch(base, patched, replacements);
  if (!measured.ok) return measured;
  // The contents were read and checked against their hashes when the patch was measured.
  const outOfScope = replacements.some(({ oldBlob, newBlob, newMode }) => {
    if (newBlob === oldBlob) return false;
    const before = base.content.get(oldBlob) ?? NO_CONTENT;
    const after = newMode === DELETED_MODE ? NO_CONTENT : (patched.content.get(newBlob) ?? NO_CONTENT);
    return !linesAreInScope(before, after, cited.filter((range) => range.blob === oldBlob));
  });
  if (outOfScope) return refuse("patch-out-of-scope");
  return {
    ok: true,
    patchId: await patchId(replacements),
    replacements,
    kind: measured.kind,
    size: measured.size,
    changes: measured.changes,
    paths: changes.map((change) => change.path),
  };
}
