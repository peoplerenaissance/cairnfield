// Recordings (KTD18, R20): the patch agent's saved edits. A live run saves the edits that
// passed the patch checks, with the number of the claim it published, the model that
// wrote them and the hash of the prompt that model ran under. A replay reads them in
// place of the model call and goes on through the same commit, check and publish path, so
// it repeats every record ID of the live run, and the note on its commit (R46).
//
// A recording is kept by team label, component commit and finding ID. It holds no node
// URL, so a reader's own deployment finds the same one.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_CLAIM_NUMBER, MODELS, conforms, field } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import type { Home } from "../config.ts";
import { EXIT, Stop, stop } from "../outcome.ts";
import { EDITS } from "../patch/edits.ts";

const RECORDING = field.shape({
  version: field.version(),
  component: field.gitHash(),
  finding: field.sha256(),
  /** The number of the claim the live run published (Appendix H). */
  claim: field.int(0, MAX_CLAIM_NUMBER),
  model: field.oneOf(MODELS),
  /** The SHA-256 of the prompt the model ran under. A live run saves it, and a recording made before it did has none (KTD44). */
  prompt: field.optional(field.sha256()),
  edits: EDITS,
});
export type Recording = Infer<typeof RECORDING>;

/**
 * A larger file is no recording. Every recording a live run saves is under this size:
 * its edits passed `draftPatch`, so as JSON they hold at most `MAX_EDITS_CHARS`
 * characters. A character is at most 3 bytes, and the saved form adds at most 12 bytes of
 * line break and indent to each of their lines, of which there are under a third as many
 * as characters.
 */
const MAX_RECORDING_BYTES = 256 * 1024;

/** Where the recording of one finding is kept. */
export function recordingFile(home: Home, team: string, component: string, finding: string): string {
  return join(home.recordings, team, component, `${finding}.json`);
}

/** Reads the recording of one finding. Returns nothing when there is none. */
export async function readRecording(file: string, component: string, finding: string): Promise<Recording | undefined> {
  let text: string;
  try {
    // Checked before the file is read, so a file that is no recording is never held in memory.
    if ((await stat(file)).size > MAX_RECORDING_BYTES) return stop(EXIT.failed, "bad-recording");
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Stop) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return stop(EXIT.failed, "bad-recording");
  }
  let recording: unknown;
  try {
    recording = JSON.parse(text);
  } catch {
    recording = undefined;
  }
  if (conforms(RECORDING, recording)) return stop(EXIT.failed, "bad-recording");
  const read = recording as Recording;
  // A recording answers for the finding it was made for and no other.
  if (read.component !== component || read.finding !== finding) return stop(EXIT.failed, "bad-recording");
  // No model wrote a recording with the model `none`, so none ran under a prompt (KTD44).
  if (read.model === "none" && read.prompt !== undefined) return stop(EXIT.failed, "bad-recording");
  return read;
}

export async function saveRecording(file: string, recording: Recording): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);
}
