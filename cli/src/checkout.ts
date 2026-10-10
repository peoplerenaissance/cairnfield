// The checkout of a pinned commit (KTD16): a plain folder that agents and validation
// read. It is an export, with no `.git` folder and no link. It holds only regular files
// whose path passes the protocol's path rule, and each file holds the bytes Git stores
// for it at the pinned commit, whatever the component's attribute files say.
//
// Beside the folder sits a listing of what the checkout holds, with each file's mode and
// blob hash, and of what the pinned tree holds that the checkout leaves out. It also
// names the Git URL the commit was pinned from, which names the component across its
// commits.

import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FILE_MODES, LINK_MODE, SUBMODULE_MODE, conforms, field, gitBlobHash, isFileMode, isPath } from "@cairnfield/protocol";
import type { CitedFile, CitedFiles, ContractKind, Infer } from "@cairnfield/protocol";
import type { Home } from "./config.ts";
import { listTree, readBlobs } from "./git.ts";
import type { Scratch } from "./git.ts";
import { EXIT, stop } from "./outcome.ts";

/** Why an entry of the pinned tree is not in the checkout. */
const LEFT_OUT_REASONS = ["symbolic-link", "submodule", "unsupported-mode", "refused-path", "path-collision"] as const;

// First values for the sizes of a listing. A component with more entries is not pinned.
const MAX_ENTRIES = 1_000_000;
/** A path the checkout leaves out is shown up to this length. It comes from the component. */
const MAX_SHOWN_PATH = 1024;
/** How many files of a checkout are written at once. */
const WRITES_AT_ONCE = 32;
// First values for the size of a checkout: the largest file and the largest repo that
// Artifacts says it holds. A component past either is not pinned.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CHECKOUT_BYTES = 1024 * 1024 * 1024;
/** Files are read from Git up to this many bytes at a time, so a large component is never held in memory whole. */
const READ_AT_ONCE_BYTES = 64 * 1024 * 1024;
/** The listing of a commit's tree is read up to this size. It holds every path, and a component's author chose those. */
const MAX_TREE_LISTING_BYTES = 64 * 1024 * 1024;

const LISTING = field.shape({
  component: field.gitHash(),
  /** The Git URL the node imported the commit from. */
  url: field.url(),
  files: field.listOf(
    field.shape({ path: field.path(), mode: field.oneOf(FILE_MODES), blob: field.gitHash() }),
    MAX_ENTRIES,
  ),
  leftOut: field.listOf(
    field.shape({ path: field.text(MAX_SHOWN_PATH), reason: field.oneOf(LEFT_OUT_REASONS) }),
    MAX_ENTRIES,
  ),
});
/** What a checkout holds and what it leaves out. */
export type Listing = Infer<typeof LISTING>;

export const checkoutDir = (home: Home, component: string): string => join(home.checkouts, component);
const listingFile = (home: Home, component: string): string => join(home.checkouts, `${component}.json`);

/**
 * Reads a JSON file the command keeps and holds it to its shape. Returns nothing when
 * there is no file. A file that cannot be read, or that has another form, is not the
 * same as no file: `bad` ends the command for it. So does a file of more than `limit`
 * bytes, which is not read.
 */
export async function readWhole<K extends ContractKind>(file: string, kind: K, bad: () => never, limit = Infinity): Promise<Infer<K> | undefined> {
  let text: string | undefined;
  try {
    const handle = await open(file, "r");
    try {
      if ((await handle.stat()).size <= limit) text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : bad();
  }
  if (text === undefined) return bad();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  return conforms(kind, value) ? bad() : (value as Infer<K>);
}

/** Reads the listing of a pinned commit. Returns nothing when the commit is not pinned here. */
export async function readListing(home: Home, component: string): Promise<Listing | undefined> {
  const bad = (): never => stop(EXIT.failed, "bad-checkout", { component });
  const listing = await readWhole(listingFile(home, component), LISTING, bad);
  return listing && listing.component !== component ? bad() : listing;
}

/**
 * The paths that a disk which ignores letter case could not hold apart: two that differ
 * only in case, and a file where another path needs a folder. On such a disk one would
 * be written over the other. They are found the same way on every disk, so every team
 * gets the same checkout of a commit. A path here is ASCII, so lower case folds it fully.
 */
function collisions(paths: readonly string[]): ReadonlySet<string> {
  const folded = new Map<string, string[]>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const same = folded.get(key);
    if (same) same.push(path);
    else folded.set(key, [path]);
  }
  const colliding = new Set<string>();
  for (const [key, same] of folded) {
    if (same.length > 1) same.forEach((path) => colliding.add(path));
    const parts = key.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const asFile = folded.get(parts.slice(0, depth).join("/"));
      if (asFile) [...asFile, ...same].forEach((path) => colliding.add(path));
    }
  }
  return colliding;
}

/**
 * A path of a tree as text, or nothing when its bytes are no UTF-8. A byte order mark at
 * its start is kept, so such a path does not read as the path without one.
 */
export function decoded(path: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(path);
  } catch {
    return undefined;
  }
}

/** What an exported folder holds, and what of its commit's tree it leaves out. */
export type Exported = Pick<Listing, "files" | "leftOut">;

/**
 * Exports a commit that the scratch repo holds to a folder, in place of what the folder
 * held. Returns what the folder holds now, and what of the commit's tree it leaves out.
 */
export async function exportTree(scratch: Scratch, commit: string, dir: string): Promise<Exported> {
  const regular: Listing["files"][number][] = [];
  const leftOut: Listing["leftOut"][number][] = [];
  const sizeOf = new Map<string, number>();
  const tree = await listTree(scratch, commit, { bytes: MAX_TREE_LISTING_BYTES, error: "component-too-large" });
  for (const entry of tree) {
    sizeOf.set(entry.hash, entry.size);
    const path = decoded(entry.path);
    const leave = (reason: (typeof LEFT_OUT_REASONS)[number]): void => {
      const shown = path ?? new TextDecoder().decode(entry.path);
      leftOut.push({ path: shown.slice(0, MAX_SHOWN_PATH), reason });
    };
    if (entry.mode === LINK_MODE) leave("symbolic-link");
    else if (entry.mode === SUBMODULE_MODE) leave("submodule");
    else if (!isFileMode(entry.mode)) leave("unsupported-mode");
    else if (path === undefined || !isPath(path)) leave("refused-path");
    else regular.push({ path, mode: entry.mode, blob: entry.hash });
  }
  const colliding = collisions(regular.map(({ path }) => path));
  const files = regular.filter(({ path }) => !colliding.has(path));
  for (const path of colliding) leftOut.push({ path, reason: "path-collision" });
  // The sizes come from Git before any file is read, so a component cannot fill the
  // memory or the disk of the machine that pins it.
  const bytes = (file: { readonly blob: string }): number => sizeOf.get(file.blob) ?? 0;
  const total = files.reduce((sum, file) => sum + bytes(file), 0);
  const tooLarge = total > MAX_CHECKOUT_BYTES || files.some((file) => bytes(file) > MAX_FILE_BYTES);
  if (tooLarge || files.length > MAX_ENTRIES || leftOut.length > MAX_ENTRIES) stop(EXIT.failed, "component-too-large");

  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  // Each path passed the path rule: no part is `.`, `..` or `.git`, so it stays in the folder.
  const targets = files.map((file) => ({ file, target: join(partial, ...file.path.split("/")) }));
  await mkdir(partial, { recursive: true });
  for (const dir of new Set(targets.map(({ target }) => dirname(target)))) await mkdir(dir, { recursive: true });

  // One blob may sit at many paths. Each blob is read once, in a batch of bounded size,
  // and written to every path that holds it before the next batch is read.
  const holders = new Map<string, typeof targets>();
  for (const held of targets) {
    const others = holders.get(held.file.blob);
    if (others) others.push(held);
    else holders.set(held.file.blob, [held]);
  }
  const write = async (batch: readonly string[], batched: number): Promise<void> => {
    const blobs = await readBlobs(scratch, batch, batched);
    const writes = batch.flatMap((blob) => holders.get(blob) ?? []);
    for (let at = 0; at < writes.length; at += WRITES_AT_ONCE) {
      await Promise.all(
        writes.slice(at, at + WRITES_AT_ONCE).map(async ({ file, target }) => {
          await writeFile(target, blobs.get(file.blob) ?? new Uint8Array(0));
          await chmod(target, file.mode === "100755" ? 0o755 : 0o644);
        }),
      );
    }
  };
  let batch: string[] = [];
  let batched = 0;
  for (const blob of holders.keys()) {
    const size = sizeOf.get(blob) ?? 0;
    if (batch.length > 0 && batched + size > READ_AT_ONCE_BYTES) {
      await write(batch, batched);
      batch = [];
      batched = 0;
    }
    batch.push(blob);
    batched += size;
  }
  await write(batch, batched);
  await rm(dir, { recursive: true, force: true });
  await rename(partial, dir);
  return { files, leftOut };
}

/** Writes a file whole under another name first, so a run that is cut short leaves no file. */
export async function writeWhole(file: string, value: object): Promise<void> {
  const unfinished = `${file}.partial`;
  await writeFile(unfinished, `${JSON.stringify(value, null, 2)}\n`);
  await rename(unfinished, file);
}

/**
 * Exports the checkout of a commit that the scratch repo holds, and writes its listing
 * with the Git URL the commit was pinned from. The listing is written last, so a
 * checkout that was cut short is made again.
 */
export async function exportCheckout(home: Home, scratch: Scratch, pinned: { readonly url: string; readonly commit: string }): Promise<Listing> {
  const { url, commit } = pinned;
  const listing: Listing = { component: commit, url, ...(await exportTree(scratch, commit, checkoutDir(home, commit))) };
  await writeWhole(listingFile(home, commit), listing);
  return listing;
}

/**
 * Gives a reader of the files that records cite in one checkout, for the second layer of
 * validation. A file is read once, however many records cite it. Its bytes must be the
 * blob the listing names, so a record is never checked against a file that was changed
 * after the export.
 */
export function citedFileReader(home: Home, listing: Listing): (paths: readonly string[]) => Promise<CitedFiles> {
  const modes = new Map(listing.files.map((file) => [file.path, file.mode]));
  const blobs = new Map(listing.files.map((file) => [file.path, file.blob]));
  const read = new Map<string, CitedFile>();
  return async (paths) => {
    const cited = new Map<string, CitedFile>();
    for (const path of paths) {
      const mode = modes.get(path);
      if (mode === undefined) continue;
      let file = read.get(path);
      if (!file) {
        const content = new Uint8Array(await readFile(join(checkoutDir(home, listing.component), ...path.split("/"))));
        if ((await gitBlobHash(content)) !== blobs.get(path)) stop(EXIT.failed, "bad-checkout", { component: listing.component });
        file = { mode, content };
        read.set(path, file);
      }
      cited.set(path, file);
    }
    return cited;
  };
}
