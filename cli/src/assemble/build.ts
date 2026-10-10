// How the selected patches become one copy (KTD22), and the diff the operator reads (R25).
//
// A patch is applied as line edits, not as a Git merge. Each patch's changed lines are
// the hunks of the protocol's own diff against the old content, and every edit is
// applied against that old content. So patches on adjoining lines compose, and the copy
// does not depend on the order the patches come in. Two patches that change the same
// line of one content, or add lines at the same place, do not compose, and the selection
// is refused. The result goes to every path that holds the old content.

import { DELETED_BLOB, DELETED_MODE, MAX_PATCH_LINES, MAX_RECIPE_PATCHES, compare, diffLines, gitBlobHash, splitLines } from "@cairnfield/protocol";
import type { FileEntry, FileListing, Hunk } from "@cairnfield/protocol";
import { EXIT, stop } from "../outcome.ts";
import type { Verified } from "./verify.ts";

/** One hunk of one patch, with the lines it puts in place of the lines it removes. */
interface Edit {
  readonly patch: string;
  readonly hunk: Hunk;
  readonly lines: readonly Uint8Array[];
}

/** What the selected patches do to the lines of one old content. */
interface Edited {
  readonly before: Uint8Array;
  readonly edits: Edit[];
  /** The new content each patch gave, by patch. */
  readonly wrote: Map<string, string>;
}

/** The copy as changes to the pinned tree. */
export interface Composed {
  /** Every path the copy changes, sorted, with its new mode and blob, or the deletion marker. */
  readonly changes: readonly FileEntry[];
  /** The content of each new blob, by its hash. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

export type Composition = ({ readonly ok: true } & Composed) | { readonly ok: false; readonly conflict: readonly [string, string] };

const LINE_FEED = 10;

/**
 * Whether two hunks of two patches on one old content cannot both be applied: they
 * remove the same line, one adds lines in the middle of what the other removes, or both
 * add lines at the same place, where no order between the two is the right one.
 */
function clash(a: Hunk, b: Hunk): boolean {
  const aEnd = a.oldStart + a.removed;
  const bEnd = b.oldStart + b.removed;
  if (a.removed > 0 && b.removed > 0) return a.oldStart < bEnd && b.oldStart < aEnd;
  if (a.removed === 0 && b.oldStart < a.oldStart && a.oldStart < bEnd) return true;
  if (b.removed === 0 && a.oldStart < b.oldStart && b.oldStart < aEnd) return true;
  return a.added > 0 && b.added > 0 && a.oldStart === b.oldStart;
}

/** Applies the edits of one old content, each against the old content's own line numbers. */
function applyEdits(before: Uint8Array, edits: readonly Edit[]): { readonly content: Uint8Array } | { readonly conflict: readonly [string, string] } {
  const ordered = [...edits].sort((a, b) => a.hunk.oldStart - b.hunk.oldStart || a.hunk.removed - b.hunk.removed);
  for (const [at, edit] of ordered.entries()) {
    const other = ordered.slice(at + 1).find((later) => later.patch !== edit.patch && clash(edit.hunk, later.hunk));
    if (other) return { conflict: [edit.patch, other.patch] };
  }
  const old = splitLines(before);
  const written: { readonly line: Uint8Array; readonly patch?: string }[] = [];
  let next = 1;
  for (const { patch, hunk, lines } of ordered) {
    for (; next < hunk.oldStart; next++) written.push({ line: old[next - 1] ?? new Uint8Array(0) });
    for (const line of lines) written.push({ line, patch });
    next = Math.max(next, hunk.oldStart + hunk.removed);
  }
  for (; next <= old.length; next++) written.push({ line: old[next - 1] ?? new Uint8Array(0) });
  // Only a file's last line may end with no line feed. When one patch ends the file so
  // and another adds lines after it, the two would run together into one line.
  for (const [at, { line, patch }] of written.entries()) {
    const after = written[at + 1];
    if (!after || line[line.length - 1] === LINE_FEED) continue;
    if (patch === undefined || after.patch === undefined) return stop(EXIT.failed, "assembly-failed");
    return { conflict: [patch, after.patch] };
  }
  return { content: Buffer.concat(written.map(({ line }) => line)) };
}

/**
 * Composes patches that each passed the patch checks on the pinned commit. Returns the
 * copy as changes to the pinned tree, or the two patches that do not compose. The result
 * is the same whatever order the patches are given in.
 */
export async function compose(files: FileListing, patches: readonly Verified[]): Promise<Composition> {
  const conflict = (a: string, b: string): Composition => ({ ok: false, conflict: a < b ? [a, b] : [b, a] });
  // By old content: the patches that replace it in any way, the edits to its lines, and the patch that deletes it.
  const touching = new Map<string, Set<string>>();
  const editing = new Map<string, Edited>();
  const deleting = new Map<string, string>();
  // By old content and mode: the mode a patch gives it. A regular file has two modes, so
  // two patches that change the mode of one content give it the same one.
  const modes = new Map<string, string>();

  for (const { facts, before, after } of [...patches].sort((a, b) => compare(a.facts.patchId, b.facts.patchId))) {
    const patch = facts.patchId;
    for (const [at, replacement] of facts.replacements.entries()) {
      const { oldBlob, oldMode, newBlob, newMode } = replacement;
      const others = touching.get(oldBlob) ?? new Set();
      touching.set(oldBlob, others.add(patch));
      if (newMode === DELETED_MODE) {
        deleting.set(oldBlob, patch);
        continue;
      }
      if (newMode !== oldMode) modes.set(`${oldBlob} ${oldMode}`, newMode);
      if (newBlob === oldBlob) continue;
      const old = before.get(oldBlob);
      const content = after.get(newBlob);
      if (!old || !content) return stop(EXIT.failed, "assembly-failed");
      const edited: Edited = editing.get(oldBlob) ?? { before: old, edits: [], wrote: new Map() };
      editing.set(oldBlob, edited);
      // Copies of one content with two modes are two replacements and one change of lines.
      if (edited.wrote.has(patch)) continue;
      edited.wrote.set(patch, newBlob);
      const lines = splitLines(content);
      for (const hunk of facts.changes[at]?.hunks ?? []) {
        edited.edits.push({ patch, hunk, lines: lines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.added) });
      }
    }
  }

  // A patch that deletes a content leaves nothing for another patch to change.
  for (const [blob, patch] of deleting) {
    const other = [...(touching.get(blob) ?? [])].find((id) => id !== patch);
    if (other !== undefined) return conflict(patch, other);
  }

  const blobs = new Map<string, Uint8Array>();
  const newBlobOf = new Map<string, string>();
  for (const [blob, { before, edits, wrote }] of editing) {
    const applied = applyEdits(before, edits);
    if ("conflict" in applied) return conflict(...applied.conflict);
    const newBlob = await gitBlobHash(applied.content);
    // The hunks of one patch alone must give back the content that was checked.
    const [alone] = wrote.size === 1 ? wrote.values() : [];
    if (alone !== undefined && alone !== newBlob) return stop(EXIT.failed, "assembly-failed");
    newBlobOf.set(blob, newBlob);
    if (newBlob !== blob) blobs.set(newBlob, applied.content);
  }

  const changes: FileEntry[] = [];
  for (const { path, mode, blob } of files) {
    if (deleting.has(blob)) {
      changes.push({ path, mode: DELETED_MODE, blob: DELETED_BLOB });
      continue;
    }
    const now = { path, mode: modes.get(`${blob} ${mode}`) ?? mode, blob: newBlobOf.get(blob) ?? blob };
    if (now.mode !== mode || now.blob !== blob) changes.push(now);
  }
  return { ok: true, changes: changes.sort((a, b) => compare(a.path, b.path)), blobs };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// What is printed as an escape. A backslash, so that an escape cannot be mistaken for
// text. Every control character but the tab. Every character a reader does not see or
// cannot tell from another: a format character such as a direction override or a
// zero-width mark, any other character that is drawn as nothing, a blank that fills a
// cell, a space that is not the plain one, the two characters that break a line without
// being a line feed, and a character with no meaning of its own or none yet.
const UNSEEN = /[\\\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u2800]|[^\P{Cc}\t]|[^\P{Zs} ]/gu;

const hex = (code: number): string => code.toString(16).padStart(2, "0");

/**
 * One line of a file as it is printed, without the line feed that ends it. A character
 * that a terminal would act on, or that changes what a reader sees without being seen
 * itself, is printed as an escape, so the line on screen says what bytes the copy holds.
 */
function shown(line: Uint8Array): string {
  const bytes = line[line.length - 1] === LINE_FEED ? line.subarray(0, -1) : line;
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    // Bytes that are no UTF-8 are printed one by one.
    return Array.from(bytes, (byte) => (byte === 0x5c ? "\\\\" : byte === 9 || (byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(byte) : `\\x${hex(byte)}`)).join("");
  }
  return text.replace(UNSEEN, (char) => {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") return "\\\\";
    return code <= 0xff ? `\\x${hex(code)}` : `\\u{${code.toString(16)}}`;
  });
}

/** The most lines a copy can change: every patch a recipe may list, at its largest. */
const MAX_COPY_LINES = MAX_RECIPE_PATCHES * MAX_PATCH_LINES;

/**
 * The diff of the copy against the pinned commit, as text for the operator: each changed
 * path with every line the copy removes and adds there, and nothing else. `contentOf`
 * gives the content of a blob of either side. Each line goes to `write` as it is made,
 * so a removed line of any length, in however many copies, is never held more than once.
 */
export function renderDiff(
  files: FileListing,
  changes: readonly FileEntry[],
  contentOf: (blob: string) => Uint8Array | undefined,
  write: (text: string) => void,
): void {
  const pinned = new Map(files.map((file) => [file.path, file]));
  const put = (...lines: readonly string[]): void => lines.forEach((line) => write(`${line}\n`));
  const print = (sign: string, lines: readonly Uint8Array[], start: number, count: number): void => {
    for (const line of lines.slice(start - 1, start - 1 + count)) {
      put(`${sign}${shown(line)}`);
      if (line[line.length - 1] !== LINE_FEED) put("\\ No newline at end of file");
    }
  };
  for (const { path, mode, blob } of changes) {
    const old = pinned.get(path);
    if (!old) return stop(EXIT.failed, "assembly-failed");
    const deleted = mode === DELETED_MODE;
    put(`--- a/${path}`, deleted ? "+++ /dev/null" : `+++ b/${path}`);
    if (!deleted && mode !== old.mode) put(`old mode ${old.mode}`, `new mode ${mode}`);
    if (blob === old.blob) continue;
    const before = contentOf(old.blob);
    const after = deleted ? new Uint8Array(0) : contentOf(blob);
    const diff = before && after ? diffLines(before, after, MAX_COPY_LINES) : undefined;
    if (!before || !after || !diff) return stop(EXIT.failed, "assembly-failed");
    const removed = splitLines(before);
    const added = splitLines(after);
    for (const hunk of diff.hunks) {
      put(`@@ -${hunk.oldStart},${hunk.removed} +${hunk.newStart},${hunk.added} @@`);
      print("-", removed, hunk.oldStart, hunk.removed);
      print("+", added, hunk.newStart, hunk.added);
    }
  }
}
