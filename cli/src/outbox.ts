// The outbox (KTD20): a folder of record files that wait to be published. Agents and
// people write to it, and the command writes its own claims to it, so every record
// takes the same path out (R21). A file sits where it will sit in the team repo:
// `records/<component-commit>/<type>/<id>.json`.
//
// Both layers of the protocol's validation run on every file (R3): its structure and
// limits, and then its cited lines against the checkout of its component.

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  MAX_RECORD_BYTES,
  citedPaths,
  recordId,
  recordPath,
  validateAgainstFiles,
  validateRecordFile,
  validateRecordText,
} from "@cairnfield/protocol";
import type { AnyRecord, RejectionReason } from "@cairnfield/protocol";
import { citedFileReader, readListing } from "./checkout.ts";
import type { Home } from "./config.ts";

/** A record file that passed both layers. */
export interface Checked {
  /** The file's path in the outbox, which is its path in the team repo. */
  readonly path: string;
  readonly id: string;
  readonly record: AnyRecord;
  /** The file's bytes as they were validated, so the same bytes are published. */
  readonly content: Uint8Array;
}

/** A file the outbox may not hold, with the reason from the protocol's closed list. */
export interface Refused {
  readonly record: string;
  readonly reason: RejectionReason;
  /** The declared field that was refused. It never holds text from the file. */
  readonly field?: string;
  /** For a valid record under the wrong name: the path it belongs at. */
  readonly expected?: string;
}

export interface OutboxCheck {
  readonly records: readonly Checked[];
  readonly rejected: readonly Refused[];
}

/** Every entry under the outbox that is no folder, by its path there. */
async function entries(outbox: string): Promise<{ readonly path: string; readonly isFile: boolean }[]> {
  let found;
  try {
    found = await readdir(outbox, { recursive: true, withFileTypes: true });
  } catch {
    // No outbox yet is an empty outbox.
    return [];
  }
  return found
    .filter((entry) => !entry.isDirectory())
    .map((entry) => ({
      path: relative(outbox, join(entry.parentPath, entry.name)).split(sep).join("/"),
      isFile: entry.isFile(),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Validates every file of the outbox. Nothing is read from a node or an index. */
export async function checkOutbox(home: Home): Promise<OutboxCheck> {
  const records: Checked[] = [];
  const rejected: Refused[] = [];
  // The reader of each component's checkout, or nothing for a component that is not pinned here.
  const checkouts = new Map<string, ReturnType<typeof citedFileReader> | undefined>();
  const pinned = async (component: string): Promise<ReturnType<typeof citedFileReader> | undefined> => {
    if (!checkouts.has(component)) {
      const listing = await readListing(home, component);
      checkouts.set(component, listing && citedFileReader(home, listing));
    }
    return checkouts.get(component);
  };

  for (const { path, isFile } of await entries(home.outbox)) {
    const refuse = (reason: RejectionReason, more: Omit<Refused, "record" | "reason"> = {}): void => {
      rejected.push({ record: path, reason, ...more });
    };
    // A link is not followed, so the outbox cannot name a file outside itself.
    if (!isFile) {
      refuse("bad-path");
      continue;
    }
    const file = join(home.outbox, ...path.split("/"));
    if ((await stat(file)).size > MAX_RECORD_BYTES) {
      refuse("too-large");
      continue;
    }
    const content = new Uint8Array(await readFile(file));
    const structure = await validateRecordFile(path, content);
    if (!structure.ok) {
      const { reason, field } = structure;
      // A valid record at the wrong place is told where it belongs, so a person who
      // writes one by hand need not work out its hash.
      const misplaced = reason === "bad-path" || reason === "hash-mismatch" ? validateRecordText(content) : undefined;
      refuse(reason, {
        ...(field === undefined ? {} : { field }),
        ...(misplaced?.ok ? { expected: recordPath(misplaced.record, await recordId(misplaced.record)) } : {}),
      });
      continue;
    }
    const { record, id } = structure;
    const citedFiles = await pinned(record.component);
    if (!citedFiles) {
      refuse("unknown-component");
      continue;
    }
    const cited = validateAgainstFiles(record, await citedFiles(citedPaths(record)));
    if (!cited.ok) {
      refuse(cited.reason, cited.field === undefined ? {} : { field: cited.field });
      continue;
    }
    records.push({ path, id, record, content });
  }
  return { records, rejected };
}

/** Writes a record of the command's own to the outbox, and returns its ID. */
export async function addRecord(home: Home, record: AnyRecord): Promise<string> {
  const id = await recordId(record);
  const file = join(home.outbox, ...recordPath(record, id).split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  return id;
}
