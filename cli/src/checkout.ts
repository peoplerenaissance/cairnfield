// The checkout of a pinned commit (KTD16): a plain folder that agents and validation
// read. It is an export, with no `.git` folder and no link. It holds only regular files
// whose path passes the protocol's path rule, and each file holds the bytes Git stores
// for it at the pinned commit, whatever the component's attribute files say.
//
// Beside the folder sits a listing of what the checkout holds, with each file's mode and
// blob hash, and of what the pinned tree holds that the checkout leaves out.

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FILE_MODES, LINK_MODE, SUBMODULE_MODE, conforms, field, gitBlobHash, isFileMode, isPath } from "@cairnfield/protocol";
import type { CitedFile, CitedFiles, Infer } from "@cairnfield/protocol";
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

const LISTING = field.shape({
  component: field.gitHash(),
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

/** Reads the listing of a pinned commit. Returns nothing when the commit is not pinned here. */
export async function readListing(home: Home, component: string): Promise<Listing | undefined> {
  let text: string;
  try {
    text = await readFile(listingFile(home, component), "utf8");
  } catch (error) {
    // No listing means the commit is not pinned here. A listing that cannot be read does not.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return stop(EXIT.failed, "bad-checkout", { component });
  }
  let listing: unknown;
  try {
    listing = JSON.parse(text);
  } catch {
    listing = undefined;
  }
  if (conforms(LISTING, listing) || (listing as Listing).component !== component) {
    return stop(EXIT.failed, "bad-checkout", { component });
  }
  return listing as Listing;
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
    folded.set(key, [...(folded.get(key) ?? []), path]);
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

function decoded(path: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(path);
  } catch {
    return undefined;
  }
}

/**
 * Exports a commit that the scratch repo holds, and writes its listing. The listing is
 * written last, so a checkout that was cut short is made again.
 */
export async function exportCheckout(home: Home, scratch: Scratch, commit: string): Promise<Listing> {
  const regular: Listing["files"][number][] = [];
  const leftOut: Listing["leftOut"][number][] = [];
  for (const entry of await listTree(scratch, commit)) {
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
  if (files.length > MAX_ENTRIES || leftOut.length > MAX_ENTRIES) stop(EXIT.failed, "component-too-large");

  const blobs = await readBlobs(scratch, [...new Set(files.map((file) => file.blob))]);
  const dir = checkoutDir(home, commit);
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  // Each path passed the path rule: no part is `.`, `..` or `.git`, so it stays in the folder.
  const targets = files.map((file) => ({ file, target: join(partial, ...file.path.split("/")) }));
  await mkdir(partial, { recursive: true });
  for (const dir of new Set(targets.map(({ target }) => dirname(target)))) await mkdir(dir, { recursive: true });
  for (let at = 0; at < targets.length; at += WRITES_AT_ONCE) {
    await Promise.all(
      targets.slice(at, at + WRITES_AT_ONCE).map(async ({ file, target }) => {
        await writeFile(target, blobs.get(file.blob) ?? new Uint8Array(0));
        await chmod(target, file.mode === "100755" ? 0o755 : 0o644);
      }),
    );
  }
  await rm(dir, { recursive: true, force: true });
  await rename(partial, dir);

  const listing: Listing = { component: commit, files, leftOut };
  // Written whole under another name first, so a run that is cut short leaves no listing.
  const unfinished = `${listingFile(home, commit)}.partial`;
  await writeFile(unfinished, `${JSON.stringify(listing, null, 2)}\n`);
  await rename(unfinished, listingFile(home, commit));
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
