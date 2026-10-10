// What assembly checks before a candidate goes into the copy (R25, KTD23).
//
// Nothing is taken on trust, from the index or from a node. The patch record is read
// from the repo of the team that published it, so an index cannot name a commit the
// team never announced. The commit is fetched from that team's fork, and its parent,
// scope, completeness, size, kind and patch ID are worked out again from what arrived,
// against the team's own checkout. The same holds for a patch of the team's own.
//
// Every value from another node is hostile until it is checked (KTD33). A remote must
// have the Artifacts form before Git sees it. A fetch from another team's fork asks for
// one commit by its hash, and is stopped at a size and at a deadline. What a node or its
// fork does wrong refuses the candidate, and the command goes on without it.

import {
  DELETED_MODE,
  MAX_BLOB_BYTES,
  MAX_FETCH_BYTES,
  MAX_LISTING_ENTRIES,
  MAX_PATCH_REPLACEMENTS,
  applyChanges,
  changedPaths,
  checkPatch,
  citedPaths,
  citedRanges,
  isInScope,
  isPath,
  modesAreRegular,
  recordPath,
  replacementsOf,
  validateAgainstFiles,
} from "@cairnfield/protocol";
import type { CitedFiles, CitedRange, FileEntry, Finding, NodeListing, Patch, PatchFacts } from "@cairnfield/protocol";
import { decoded } from "../checkout.ts";
import type { Listing } from "../checkout.ts";
import { blobSizes, changedEntry, diffTrees, fetchCommit, parentsOf, readBlobs } from "../git.ts";
import type { Scratch, TransferBound } from "../git.ts";
import type { Io } from "../io.ts";
import { EXIT, Stop, stop } from "../outcome.ts";
import { forkAccess, nodeListing, readRecord } from "../services.ts";
import type { Answer } from "../services.ts";
import type { Candidate } from "./select.ts";

/** A fetch from another team's fork brings in at most the protocol's limit, and runs for at most two minutes. */
const FORK_FETCH: TransferBound = { bytes: MAX_FETCH_BYTES, ms: 2 * 60_000 };
/** The list of paths a commit changes is read up to this size: as many paths as a node may list, with room for each. */
const MAX_CHANGES_BYTES = MAX_LISTING_ENTRIES * 512;

/** What one run of assembly works with. */
export interface Assembly {
  readonly io: Io;
  /** The base URL of the team's own node. */
  readonly node: string;
  /** The checkout's listing of the pinned commit. */
  readonly listing: Listing;
  /** A scratch repo that holds the pinned commit. */
  readonly scratch: Scratch;
  /** Reads files of the checkout, each held to the blob the listing names. */
  readonly files: (paths: readonly string[]) => Promise<CitedFiles>;
  /** The nodes whose records count for the team: its own, and those its lens names at level 2. */
  readonly counted: readonly string[];
  /** What each node answered when asked for the listing of its team repo. A node is asked once in a run. */
  readonly listings: Map<string, Promise<Answer<NodeListing>>>;
}

/** A candidate that passed every check, with what the copy is built from. */
export interface Verified {
  readonly node: string;
  readonly commit: string;
  readonly facts: PatchFacts;
  /** The lines the patch's findings cite, which are the lines it may change. */
  readonly cited: readonly CitedRange[];
  /** The content of each blob the patch replaces, by its hash. */
  readonly before: ReadonlyMap<string, Uint8Array>;
  /** The content of each blob the patch puts in its place, by its hash. */
  readonly after: ReadonlyMap<string, Uint8Array>;
}

export type Verdict = ({ readonly ok: true } & Verified) | { readonly ok: false; readonly reason: string };

/**
 * Runs a step that reads from a node, from its fork or from what the fork sent. When the
 * step ends the command, the candidate is refused with the step's code in its place.
 */
async function attempt<T>(step: () => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> {
  try {
    return { ok: true, value: await step() };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, reason: String(error.outcome.output["error"]) };
    throw error;
  }
}

function listingOf(run: Assembly, node: string): Promise<Answer<NodeListing>> {
  const answer = run.listings.get(node) ?? nodeListing(run.io, node);
  run.listings.set(node, answer);
  return answer;
}

/**
 * Reads the patch record a candidate names from the repo of the team that published it.
 * The index only said that the record is there. What the record says, its commit and its
 * findings, is the team's own word, and is taken from the team's own node. Returns the
 * code of why there is no such record, when there is none.
 */
async function patchRecordOf(run: Assembly, candidate: Candidate): Promise<Patch | string> {
  const held = await listingOf(run, candidate.node);
  if (!held.ok) return `node-${held.error}`;
  const path = recordPath({ component: run.listing.component, type: "patch" }, candidate.record);
  if (!held.body.records.some((record) => record.path === path)) return "unresolved-reference";
  const file = await readRecord(run.io, candidate.node, held.body.head, path);
  if (!file) return "unresolved-reference";
  if (!file.ok) return file.reason;
  return file.record.type === "patch" ? file.record : "unresolved-reference";
}

/**
 * Reads the findings a patch record names from the repos of the teams that count, the
 * author's first. A record file's name is the hash of its content (KTD1), so a valid
 * file at a finding's path is that finding, whichever node serves it. Returns nothing
 * when one of them is in no such repo.
 */
async function findingsOf(run: Assembly, author: string, ids: readonly string[]): Promise<Finding[] | undefined> {
  const nodes = [author, ...run.counted.filter((node) => node !== author)];
  const findings: Finding[] = [];
  for (const id of ids) {
    const path = recordPath({ component: run.listing.component, type: "finding" }, id);
    let found: Finding | undefined;
    for (const node of nodes) {
      const held = await listingOf(run, node);
      if (!held.ok || !held.body.records.some((record) => record.path === path)) continue;
      const file = await readRecord(run.io, node, held.body.head, path);
      if (file?.ok && file.record.type === "finding") {
        found = file.record;
        break;
      }
    }
    if (!found) return undefined;
    findings.push(found);
  }
  return findings;
}

/** Reads a candidate's record, fetches the commit it names and checks it as a patch on the pinned commit. */
export async function verify(run: Assembly, candidate: Candidate): Promise<Verdict> {
  const refuse = (reason: string): Verdict => ({ ok: false, reason });
  const { io, scratch, listing } = run;
  const component = listing.component;

  const announced = await attempt(() => patchRecordOf(run, candidate));
  if (!announced.ok) return refuse(announced.reason);
  if (typeof announced.value === "string") return refuse(announced.value);
  const { commit, findings } = announced.value;

  // The lines the patch may change are the lines its findings cite in the team's own checkout.
  const named = await attempt(() => findingsOf(run, candidate.node, findings));
  if (!named.ok) return refuse(named.reason);
  if (!named.value) return refuse("unresolved-reference");
  for (const finding of named.value) {
    const valid = validateAgainstFiles(finding, await run.files(citedPaths(finding)));
    if (!valid.ok) return refuse(valid.reason);
  }
  const cited = citedRanges(named.value, listing.files);

  const access = await forkAccess(io, candidate.node, component);
  if (!access.ok) return refuse(`node-${access.error}`);
  const fetched = await attempt(async () => {
    // The team's own fork is its own. Another team's is held to a size and a deadline.
    await fetchCommit(scratch, access.body, commit, candidate.node === run.node ? undefined : FORK_FETCH);
    const parents = await parentsOf(scratch, commit);
    if (parents.length !== 1 || parents[0] !== component) return undefined;
    return diffTrees(scratch, component, commit, { bytes: MAX_CHANGES_BYTES, error: "patch-too-large" });
  });
  if (!fetched.ok) return refuse(fetched.reason);
  if (!fetched.value) return refuse("wrong-parent");

  const held = new Map(listing.files.map((file) => [file.path, file]));
  const changes: FileEntry[] = [];
  for (const change of fetched.value) {
    const path = decoded(change.path);
    if (path === undefined || !isPath(path)) return refuse("bad-path");
    // What a patch changes must be a file of the checkout. The pinned tree may hold more:
    // a link, a submodule entry, a path the checkout refuses. No finding can cite one.
    const file = held.get(path);
    if (change.old && (file?.mode !== change.old.mode || file.blob !== change.old.hash)) return refuse("patch-out-of-scope");
    changes.push(changedEntry(change, path));
  }

  // The checks that read no content run first, in the order the protocol runs them, so
  // a commit cannot make the command read content for a patch it refuses anyway.
  const patched = applyChanges(listing.files, changes);
  const paths = changedPaths(listing.files, patched);
  if (!modesAreRegular(paths)) return refuse("bad-mode");
  if (!isInScope(paths, cited)) return refuse("patch-out-of-scope");
  const replacements = replacementsOf(listing.files, paths);
  if (!replacements) return refuse("patch-incomplete");
  if (replacements.length > MAX_PATCH_REPLACEMENTS) return refuse("patch-too-large");

  // The old content comes from the checkout, and the new content from the commit.
  const rewritten = replacements.filter((replacement) => replacement.newBlob !== replacement.oldBlob);
  const before = new Map<string, Uint8Array>();
  for (const { oldBlob } of rewritten) {
    const path = listing.files.find((file) => file.blob === oldBlob)?.path ?? "";
    const content = (await run.files([path])).get(path)?.content;
    if (!content) return stop(EXIT.failed, "bad-checkout", { component });
    before.set(oldBlob, content);
  }
  const added = [...new Set(rewritten.filter(({ newMode }) => newMode !== DELETED_MODE).map(({ newBlob }) => newBlob))];
  const after = await attempt(async () => {
    const sizes = await blobSizes(scratch, added);
    if (added.some((blob) => !sizes.has(blob))) return stop(EXIT.invalid, "blob-mismatch");
    if (added.some((blob) => (sizes.get(blob) ?? 0) > MAX_BLOB_BYTES)) return stop(EXIT.invalid, "too-large");
    return readBlobs(scratch, added, added.reduce((sum, blob) => sum + (sizes.get(blob) ?? 0), 0));
  });
  if (!after.ok) return refuse(after.reason);

  const checked = await checkPatch({
    base: { files: listing.files, content: before },
    patched: { files: patched, content: after.value },
    cited,
  });
  if (!checked.ok) return refuse(checked.reason);
  const { ok, ...facts } = checked;
  // The index may be wrong about a patch, or lie about it. Its patch ID only says which one it meant.
  if (candidate.expected !== undefined && candidate.expected !== facts.patchId) return refuse("patch-id-mismatch");
  return { ok, node: candidate.node, commit, facts, cited, before, after: after.value };
}
