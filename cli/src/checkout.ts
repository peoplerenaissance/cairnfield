// The checkout of a pinned commit (KTD16): a plain folder that agents and validation
// read. It is an export, with no `.git` folder and no link. It holds only regular files
// whose path passes the protocol's path rule, and each file holds the bytes Git stores
// for it at the pinned commit, whatever the component's attribute files say.
//
// Beside the folder sits a listing of what the checkout holds, with each file's mode and
// blob hash, and of what the pinned tree holds that the checkout leaves out.

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FILE_MODES, conforms, field, isFileMode, isPath } from "@cairnfield/protocol";
import type { CitedFile, CitedFiles, Infer } from "@cairnfield/protocol";
import type { Home } from "./config.ts";
import { listTree, readBlobs } from "./git.ts";
import type { Scratch } from "./git.ts";
import { EXIT, stop } from "./outcome.ts";

/** Why an entry of the pinned tree is not in the checkout. */
export const LEFT_OUT_REASONS = ["symbolic-link", "submodule", "unsupported-mode", "refused-path"] as const;

// First values for the sizes of a listing. A component with more entries is not pinned.
const MAX_ENTRIES = 1_000_000;
/** A path the checkout leaves out is shown up to this length. It comes from the component. */
const MAX_SHOWN_PATH = 1024;

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
  } catch {
    return undefined;
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

const MODE_LINK = "120000";
const MODE_SUBMODULE = "160000";

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
  const files: Listing["files"][number][] = [];
  const leftOut: Listing["leftOut"][number][] = [];
  for (const entry of await listTree(scratch, commit)) {
    const path = decoded(entry.path);
    const leave = (reason: (typeof LEFT_OUT_REASONS)[number]): void => {
      const shown = path ?? new TextDecoder().decode(entry.path);
      leftOut.push({ path: shown.slice(0, MAX_SHOWN_PATH), reason });
    };
    if (entry.mode === MODE_LINK) leave("symbolic-link");
    else if (entry.mode === MODE_SUBMODULE) leave("submodule");
    else if (!isFileMode(entry.mode)) leave("unsupported-mode");
    else if (path === undefined || !isPath(path)) leave("refused-path");
    else files.push({ path, mode: entry.mode, blob: entry.hash });
  }
  if (files.length > MAX_ENTRIES || leftOut.length > MAX_ENTRIES) stop(EXIT.failed, "component-too-large");

  const blobs = await readBlobs(scratch, [...new Set(files.map((file) => file.blob))]);
  const dir = checkoutDir(home, commit);
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  for (const file of files) {
    // The path passed the path rule: no part is `.`, `..` or `.git`, so it stays in the folder.
    const target = join(partial, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, blobs.get(file.blob) ?? new Uint8Array(0));
    await chmod(target, file.mode === "100755" ? 0o755 : 0o644);
  }
  await mkdir(partial, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await rename(partial, dir);

  const listing: Listing = { component: commit, files, leftOut };
  await writeFile(listingFile(home, commit), `${JSON.stringify(listing, null, 2)}\n`);
  return listing;
}

/** Reads the files a record cites from the checkout, for the second layer of validation. */
export async function citedFiles(home: Home, listing: Listing, paths: readonly string[]): Promise<CitedFiles> {
  const cited = new Map<string, CitedFile>();
  for (const path of paths) {
    const held = listing.files.find((file) => file.path === path);
    if (!held) continue;
    const file = join(checkoutDir(home, listing.component), ...path.split("/"));
    cited.set(path, { mode: held.mode, content: new Uint8Array(await readFile(file)) });
  }
  return cited;
}
