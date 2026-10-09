// Recordings (KTD18, R20): the patch agent's saved edits. A live run saves the edits that
// passed the patch checks, with the number of the claim it published and the model that
// wrote them. A replay reads them in place of the model call and goes on through the same
// commit, check and publish path, so it repeats every record ID of the live run.
//
// A recording is kept by team label, component commit and finding ID. It holds no node
// URL, so a reader's own deployment finds the same one.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_CLAIM_NUMBER, MODELS, conforms, field } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import type { Home } from "../config.ts";
import { EXIT, stop } from "../outcome.ts";
import { EDITS } from "../patch/edits.ts";

const RECORDING = field.shape({
  version: field.version(),
  component: field.gitHash(),
  finding: field.sha256(),
  /** The number of the claim the live run published (Appendix H). */
  claim: field.int(0, MAX_CLAIM_NUMBER),
  model: field.oneOf(MODELS),
  edits: EDITS,
});
export type Recording = Infer<typeof RECORDING>;

/** Where the recording of one finding is kept. */
export function recordingFile(home: Home, team: string, component: string, finding: string): string {
  return join(home.recordings, team, component, `${finding}.json`);
}

/** Reads the recording of one finding. Returns nothing when there is none. */
export async function readRecording(file: string, component: string, finding: string): Promise<Recording | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
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
  return read;
}

export async function saveRecording(file: string, recording: Recording): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);
}
