// The note on a patch commit (R46, KTD44): what the team declares about how the commit
// was made, kept in the team's fork at `refs/notes/cairnfield`.
//
// The note is a blob of canonical JSON, and the notes tree is flat: one plain file for
// each noted commit, named by the commit's full hash. Git's own `notes` command spreads
// a tree over folders as it grows, and a reader of the flat path would then miss a note.
// So the tree is built with plumbing. The notes commit has a fixed message, author,
// committer and dates, as a patch commit has (KTD17). The same notes on the same history
// then give the same notes commit on every machine, and a replay that finds the note of
// its live run writes nothing.
//
// A note is no record (KTD1). No record names it, and no check of the command reads one.

import { join } from "node:path";
import { NOTES_REF, SCHEMA_VERSION, canonicalJson, sha256Hex } from "@cairnfield/protocol";
import type { FileMode, PatchNote } from "@cairnfield/protocol";
import type { Recording } from "../agents/replay.ts";
import { FIXED_DATE, MAX_PUSH_TRIES, RETRY_SPREAD_MS, fetchRef, inputLines, listRefs, said, wasRejected, writeBlobs } from "../git.ts";
import type { Access, Scratch } from "../git.ts";
import type { Io } from "../io.ts";
import { EXIT, stop } from "../outcome.ts";

const MESSAGE = "Cairnfield note";
/** A note is a plain file of the notes tree. */
const NOTE_MODE: FileMode = "100644";

/**
 * What `patch` did with the note of its commit: wrote it where the fork held none, found
 * the same bytes there and pushed nothing, or wrote it in the place of other bytes.
 */
export type Noted = "written" | "already-there" | "replaced";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * The note of a patch commit: the findings its patch record names, and what its
 * recording says of how the edits were made. The recording is named by the hash of its
 * fields and not of its file, so a file with other spacing gives the same note.
 */
async function noteFor(commit: string, findings: readonly string[], recording: Recording): Promise<PatchNote> {
  const { model, prompt } = recording;
  return {
    version: SCHEMA_VERSION,
    commit,
    findings: [...findings],
    model,
    recording: await sha256Hex(utf8(canonicalJson(recording))),
    ...(prompt === undefined ? {} : { prompt }),
  };
}

/** The commit the fork's notes ref points to, fetched at depth 1. Nothing for a fork that holds no note yet. */
async function fetchNotes(scratch: Scratch, access: Access): Promise<string | undefined> {
  // `fetchRef` fails on a ref the fork does not hold, so the fork is asked first.
  const held = (await listRefs(scratch, access, NOTES_REF)).includes(NOTES_REF);
  return held ? fetchRef(scratch, access, NOTES_REF) : undefined;
}

/** What a notes commit holds under a commit's name: nothing, this blob, or anything else. */
async function heldUnder(scratch: Scratch, notes: string, commit: string, blob: string): Promise<"nothing" | "this" | "other"> {
  const asked = await scratch.git("cat-file", ["cat-file", "--batch-check"], { input: inputLines([`${notes}:${commit}`]) });
  // `<hash> <type> <size>` for a name the tree holds, and a line that ends in `missing` for one it lacks.
  const answer = said(asked);
  if (answer.endsWith(" missing")) return "nothing";
  const [hash = "", type = ""] = answer.split(" ");
  return type === "blob" && hash === blob ? "this" : "other";
}

/**
 * Attaches the note to a patch commit the fork already holds, and says what it did. The
 * notes ref is pushed alone, after the patch branch, so a push the fork turns down is
 * known to be this one. When another run of the team moved the ref meanwhile, the
 * command reads it again and builds its commit on top, as `publish` does (KTD20).
 */
export async function attachNote(
  io: Io,
  scratch: Scratch,
  access: Access,
  commit: string,
  findings: readonly string[],
  recording: Recording,
): Promise<Noted> {
  const note = await noteFor(commit, findings, recording);
  const [blob = ""] = await writeBlobs(scratch, [utf8(canonicalJson(note))]);
  for (let attempt = 1; ; attempt++) {
    const head = await fetchNotes(scratch, access);
    const held = head === undefined ? "nothing" : await heldUnder(scratch, head, commit, blob);
    // The same bytes make no commit and no push. A push of the ref would start the node's Workflow, which sends the index a notice (R7).
    if (held === "this") return "already-there";

    // The tree is merged by the name of this one entry, and no other entry is read.
    const index = join(scratch.dir, `notes-index-${attempt}`);
    await scratch.git("read-tree", head === undefined ? ["read-tree", "--empty"] : ["read-tree", head], { index });
    await scratch.git("update-index", ["update-index", "--add", "--replace", "--index-info"], {
      index,
      // With `--replace`, a folder of that name gives way to the file.
      input: inputLines([`${NOTE_MODE} blob ${blob}\t${commit}`]),
    });
    const tree = said(await scratch.git("write-tree", ["write-tree"], { index }));
    const parent = head === undefined ? [] : ["-p", head];
    const notes = said(await scratch.git("commit-tree", ["commit-tree", tree, ...parent, "-m", MESSAGE], { date: FIXED_DATE }));

    const pushed = await scratch.git("push", ["push", "--porcelain", access.remote, `${notes}:${NOTES_REF}`], { access, mayFail: true });
    if (pushed.code === 0) return held === "nothing" ? "written" : "replaced";
    if (!wasRejected(said(pushed)) || attempt === MAX_PUSH_TRIES) {
      await scratch.report(pushed);
      return stop(EXIT.git, "git-failed", { step: "push" });
    }
    await io.sleep(io.random(RETRY_SPREAD_MS) * attempt);
  }
}
