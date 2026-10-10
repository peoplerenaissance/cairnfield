// `carry`: moves the team's own findings and patches to a newer commit of a component,
// and says what needs a fresh look (R37, KTD39).
//
// The command pins the newer commit from the Git URL the older one was pinned from. It
// reads the team's findings and patch records at the older commit from the team's own
// repo, and each patch commit from the team's own fork. It asks no index, and it carries
// nothing of another team (R38).
//
// What carries is written again for the newer commit: a finding as a new record, and a
// patch as a new commit on the newer commit, with the patch ID it had (KTD4), and a new
// patch record that cites the carried findings. The records go to the outbox and out
// through `publish`, so they pass the validation every record passes (KTD20). A second
// run builds the same commits and the same records, and so writes nothing new (KTD17).
//
// The output holds one entry for each finding and each patch record of the older
// commit, carried or not, with a reason from a closed list:
//
//   content-unchanged        carried: the content is where it was. A patch still changes every path it changed
//   content-moved            carried: a finding whose content is at another path now, or a patch that no
//                            longer changes a path it changed
//   content-changed          not carried: the newer commit does not hold the content
//   second-location-changed  not carried: nor does it hold the content of a finding's second location
//   finding-not-carried      not carried: a patch that cites a finding that did not carry
//   refused                  not carried: a check refused it, and `check` holds that check's code
//
// A carried finding's entry holds the path it cites now. A carried patch's entry holds
// `paths`: every path its commit changes at the newer commit, sorted. A patch goes to
// every path that holds a content it replaces, so a newer commit with one more copy
// gives one more path there, and the reason stays `content-unchanged`.
//
// It also names, by patch ID, each patch of another team in the copy the team last built
// at the older commit: the copy of the newer commit will not hold it. It ends with the
// counts of paths the newer commit added, changed and removed. `carry` reviews none of them.

import { changedPaths, compare, recordPath } from "@cairnfield/protocol";
import type { Patch } from "@cairnfield/protocol";
import { ownCandidates } from "../assemble/select.ts";
import type { Assembly } from "../assemble/verify.ts";
import { carryFindings } from "../carry/findings.ts";
import type { CarriedFindings } from "../carry/findings.ts";
import { carryPatch } from "../carry/patches.ts";
import type { PatchEntry } from "../carry/patches.ts";
import { citedFileReader, readListing } from "../checkout.ts";
import type { Home } from "../config.ts";
import { readCopy } from "../copy.ts";
import { fetchCommit, withScratch } from "../git.ts";
import type { Access } from "../git.ts";
import type { Io } from "../io.ts";
import { addRecord } from "../outbox.ts";
import { EXIT, done, outcomeOf, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { commitPatch, pushPatch } from "../patch/commit.ts";
import { adminKey, nodeFailed, nodeListing, repoAccess, writableFork } from "../services.ts";
import { pin } from "./pin.ts";
import { publish } from "./publish.ts";

export interface CarryRequest {
  readonly older: string;
  readonly newer: string;
  /** The branch that holds the newer commit. The node imports a branch by its name (KTD36). */
  readonly branch: string;
}

/** A ref of the scratch repo for the older commit. A fetch names what the repo's refs hold, so the fork sends only what a patch adds. */
const OLDER_REF = "refs/cairnfield/older";

export async function carry(io: Io, home: Home, request: CarryRequest): Promise<Outcome> {
  const older = await readListing(home, request.older);
  if (!older) return stop(EXIT.invalid, "unknown-component", { component: request.older });
  const built = await readCopy(home, older.component);
  const key = adminKey(io);
  const { node } = home.config;

  // A component is named by the Git URL it was pinned from, so the newer commit is pinned from the older one's.
  await pin(io, home, { url: older.url, branch: request.branch, commit: request.newer });
  const newer = await readListing(home, request.newer);
  if (!newer) return stop(EXIT.failed, "bad-checkout", { component: request.newer });

  // A team that has published no record yet has no team repo, and so nothing to carry.
  const held = await nodeListing(io, node);
  if (!held.ok && !(held.error === "refused" && held.reason === "not-found")) return nodeFailed(held);
  const files = citedFileReader(home, older);
  const findings: CarriedFindings = held.ok ? await carryFindings(io, node, held.body, older, newer, files) : { entries: [], carried: new Map() };
  // The path in the outbox of each record this run wrote.
  const written: string[] = [];
  for (const { record } of findings.carried.values()) written.push(recordPath(record, await addRecord(home, record)));

  const candidates = held.ok ? ownCandidates(node, older.component, held.body).sort((a, b) => compare(a.record, b.record)) : [];
  const patches: PatchEntry[] = [];
  if (candidates.length > 0) {
    // The older commit comes from the team's own copy of the component.
    const copy = await repoAccess(io, home, { repo: "copy", component: older.component, scope: "read" });
    await withScratch(io, async (scratch) => {
      await fetchCommit(scratch, copy, older.component);
      await scratch.git("update-ref", ["update-ref", OLDER_REF, older.component]);
      const run: Assembly = { io, node, listing: older, scratch, files, counted: [node], listings: new Map([[node, Promise.resolve(held)]]) };
      // The fork of the newer commit is made when the first patch carries, and the newer commit is fetched from it.
      let fork: Access | undefined;
      for (const candidate of candidates) {
        const decided = await carryPatch(run, newer, findings.carried, candidate);
        if (!decided.carried) {
          patches.push({ patch: candidate.record, ...decided });
          continue;
        }
        if (!fork) {
          fork = await writableFork(io, home, key, newer.component);
          await fetchCommit(scratch, fork, newer.component);
        }
        const commit = await commitPatch(scratch, newer.component, decided);
        await pushPatch(scratch, fork, newer.component, decided.patchId, commit);
        // The fork holds the commit before the record that announces it is published.
        const record: Patch = { ...decided.record, commit };
        const as = await addRecord(home, record);
        written.push(recordPath(record, as));
        patches.push({ patch: candidate.record, patchId: decided.patchId, carried: true, reason: decided.reason, as, commit, paths: decided.paths });
      }
    });
  }

  // A patch in the older copy that is none of the team's own came from a team its lens names.
  const own = new Set(patches.map(({ patchId }) => patchId));
  const leftBehind = (built?.patches ?? []).filter((patchId) => !own.has(patchId));
  const changes = changedPaths(older.files, newer.files);
  const paths = {
    added: changes.filter((change) => !change.old).length,
    changed: changes.filter((change) => change.old && change.new).length,
    removed: changes.filter((change) => !change.new).length,
  };

  // When publishing stops, the output still says what carried, and the records wait in the outbox.
  const published = await outcomeOf(() => publish(io, home, written));
  return done({ older: older.component, newer: newer.component, findings: findings.entries, patches, ...published.output, leftBehind, paths }, published.code);
}
