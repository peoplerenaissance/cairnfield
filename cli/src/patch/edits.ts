// The edits a patch agent returns (KTD17), and the patch they amount to.
//
// An edit names a path, a line range and the lines that replace it. The command applies
// each edit to the content at that path, and so to every path that holds the same content
// (KTD4). The protocol's patch checks then run on the result, with scope by line (KTD37),
// before any commit is made. Replacement text goes into the fork as code. It never goes
// into a record.

import { MAX_LINE, checkPatch, citedRanges, conforms, field, gitBlobHash, lineStarts } from "@cairnfield/protocol";
import type { FileEntry, Finding, Infer, PatchFacts } from "@cairnfield/protocol";
import { citedFileReader } from "../checkout.ts";
import type { Listing } from "../checkout.ts";
import type { Home } from "../config.ts";

// How much of an answer is read at all. The limits of a patch are the protocol's, and
// its checks state them.
const MAX_EDITS = 64;
const MAX_EDIT_LINES = 256;
const MAX_LINE_LENGTH = 64 * 1024;

/** Lines `start` to `end` of the file at `path`, replaced by `lines`. Lines count from 1 and the range includes both ends. */
export const EDIT = field.shape(
  {
    path: field.path(),
    start: field.int(1, MAX_LINE),
    end: field.int(1, MAX_LINE),
    /** Each line without the line feed that ends it. No line deletes the range. */
    lines: field.listOf(field.text(MAX_LINE_LENGTH), MAX_EDIT_LINES),
  },
  [{ rule: "ordered", low: "start", high: "end" }],
);
export type Edit = Infer<typeof EDIT>;

export const EDITS = field.listOf(EDIT, MAX_EDITS);
const ANSWER = field.shape({ edits: EDITS });

/**
 * The form of an answer as a JSON Schema, for a model that answers in a fixed form. It
 * states the structure only, because such a schema carries no limit. `draftPatch` checks
 * every answer in full.
 */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          start: { type: "integer" },
          end: { type: "integer" },
          lines: { type: "array", items: { type: "string" } },
        },
        required: ["path", "start", "end", "lines"],
        additionalProperties: false,
      },
    },
  },
  required: ["edits"],
  additionalProperties: false,
};

/** A patch that passed every check, before it is a commit. */
export interface Draft {
  /** The edits as they were validated, which is what a recording holds (KTD18). */
  readonly edits: readonly Edit[];
  readonly facts: PatchFacts;
  /** Every path the patch changes, with its mode and its new blob. */
  readonly changes: readonly FileEntry[];
  /** The new content of each new blob. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

/**
 * A draft, or the code of what is wrong with the edits. The code is one of the
 * protocol's rejection reasons or one of this file's own, and it is all an agent is told.
 */
export type Drafted = ({ readonly ok: true } & Draft) | { readonly ok: false; readonly reason: string };

const LINE_FEED = 10;

/** Applies the edits of one content. Every line number is a line of the content as it was. */
function apply(content: Uint8Array, edits: readonly Edit[]): Uint8Array | "lines-out-of-range" | "edits-overlap" {
  const starts = lineStarts(content);
  const parts: Uint8Array[] = [];
  let at = 0;
  let last = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.end > starts.length) return "lines-out-of-range";
    if (edit.start <= last) return "edits-overlap";
    parts.push(content.subarray(at, starts[edit.start - 1]));
    let text = edit.lines.map((line) => `${line}\n`).join("");
    // A file's last line may end with no line feed. What replaces it then ends with none either.
    if (edit.end === starts.length && content[content.length - 1] !== LINE_FEED) text = text.slice(0, -1);
    parts.push(new TextEncoder().encode(text));
    at = starts[edit.end] ?? content.length;
    last = edit.end;
  }
  parts.push(content.subarray(at));
  return Buffer.concat(parts);
}

/**
 * Turns an agent's answer, or a recording's edits, into a patch of one finding and runs
 * the patch checks on it. Nothing is written and no call is made.
 */
export async function draftPatch(home: Home, listing: Listing, finding: Finding, answer: unknown): Promise<Drafted> {
  const refused = (reason: string): Drafted => ({ ok: false, reason });
  if (conforms(ANSWER, answer)) return refused("bad-edits");
  const { edits } = answer as Infer<typeof ANSWER>;
  if (edits.length === 0) return refused("no-edits");
  if (edits.some((edit) => edit.lines.some((line) => line.includes("\n")))) return refused("bad-edits");

  // Edits are kept by the content they change, so two paths with one content are one file here.
  const blobOf = new Map(listing.files.map((file) => [file.path, file.blob]));
  const byBlob = new Map<string, { readonly path: string; readonly edits: Edit[] }>();
  for (const edit of edits) {
    const blob = blobOf.get(edit.path);
    if (blob === undefined) return refused("bad-path");
    const same = byBlob.get(blob);
    if (same) same.edits.push(edit);
    else byBlob.set(blob, { path: edit.path, edits: [edit] });
  }

  const files = await citedFileReader(home, listing)([...byBlob.values()].map(({ path }) => path));
  const before = new Map<string, Uint8Array>();
  const after = new Map<string, Uint8Array>();
  const newBlobOf = new Map<string, string>();
  for (const [blob, { path, edits: onContent }] of byBlob) {
    const content = files.get(path)?.content;
    if (!content) return refused("bad-path");
    const applied = apply(content, onContent);
    if (typeof applied === "string") return refused(applied);
    const newBlob = await gitBlobHash(applied);
    before.set(blob, content);
    after.set(newBlob, applied);
    newBlobOf.set(blob, newBlob);
  }
  if ([...newBlobOf].every(([blob, newBlob]) => blob === newBlob)) return refused("no-change");

  // Every path that holds a replaced content gets the new one, and keeps its own mode.
  const patched = listing.files.map((file) => ({ ...file, blob: newBlobOf.get(file.blob) ?? file.blob }));
  const verdict = await checkPatch({
    base: { files: listing.files, content: before },
    patched: { files: patched, content: after },
    cited: citedRanges([finding], listing.files),
  });
  if (!verdict.ok) return refused(verdict.reason);
  const { ok, ...facts } = verdict;
  const changed = new Set(facts.paths);
  return { ok, edits, facts, changes: patched.filter(({ path }) => changed.has(path)), blobs: after };
}
