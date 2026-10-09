// An injection fixture as a checkout the patch agent can read: the files under `files/`
// in the command's own layout, with their listing, and the fixture's one finding. The
// files are not a Git commit, so the listing is made from the files as they are on disk.

import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { citedPaths, gitBlobHash, validateAgainstFiles, validateRecordText } from "@cairnfield/protocol";
import type { Finding } from "@cairnfield/protocol";
import { checkoutDir, citedFileReader } from "../src/checkout.ts";
import type { Listing } from "../src/checkout.ts";
import { loadHome } from "../src/config.ts";
import type { Home } from "../src/config.ts";
import type { Io } from "../src/io.ts";

export interface Fixture {
  readonly home: Home;
  readonly listing: Listing;
  readonly finding: Finding;
}

/** Makes the checkout of a fixture under `root`, an empty folder. Throws when the fixture's finding does not fit its files. */
export async function openFixture(io: Io, fixture: string, root: string): Promise<Fixture> {
  const written = validateRecordText(await readFile(join(fixture, "finding.json")));
  if (!written.ok || written.record.type !== "finding") throw new Error("the fixture's finding is not a valid finding");
  const finding = written.record;

  // The node is never called. A config file needs one.
  await writeFile(join(root, "cairnfield.json"), JSON.stringify({ node: "https://node.fixture.example" }));
  const home = await loadHome({ ...io, cwd: root }, undefined);
  const checkout = checkoutDir(home, finding.component);
  await cp(join(fixture, "files"), checkout, { recursive: true });

  const files: Listing["files"][number][] = [];
  for (const entry of await readdir(checkout, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files.push({ path: relative(checkout, file).split(sep).join("/"), mode: "100644", blob: await gitBlobHash(new Uint8Array(await readFile(file))) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const listing: Listing = { component: finding.component, files, leftOut: [] };

  const cited = validateAgainstFiles(finding, await citedFileReader(home, listing)(citedPaths(finding)));
  if (!cited.ok) throw new Error(`the fixture's finding does not fit its files: ${cited.reason}`);
  return { home, listing, finding };
}
