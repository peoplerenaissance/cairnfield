// What assembly checks before a candidate goes into the copy (R25, KTD23).
//
// Nothing is taken on trust, from the index or from a node. The commit is fetched from
// the fork of the team that published the record, and its parent, scope, completeness,
// size, kind and patch ID are worked out again from what arrived, against the team's own
// checkout. The same holds for a patch of the team's own.
//
// Every value from another node is hostile until it is checked (KTD33). A remote must
// have the Artifacts form before Git sees it. A fetch from another team's fork asks for
// one commit by its hash, and is stopped at a size and at a deadline. What a node or its
// fork does wrong refuses the candidate, and the command goes on without it.

import {
  DELETED_BLOB,
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
import type { CitedFiles, FileEntry, Finding, NodeListing, PatchFacts } from "@cairnfield/protocol";
import { decoded } from "../checkout.ts";
import type { Listing } from "../checkout.ts";
import { blobSizes, diffTrees, fetchCommit, parentsOf, readBlobs } from "../git.ts";
import type { Access, Scratch, TransferBound } from "../git.ts";
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
  /** The listing of each node's team repo, asked for once. Nothing for a node that gave none. */
  readonly listings: Map<string, Promise<NodeListing | undefined>>;
  /** The read token of each node's fork of the component, asked for once. */
  readonly forks: Map<string, Promise<Answer<Access>>>;
}

/** A candidate that passed every check, with what the copy is built from. */
export interface Verified {
  readonly node: string;
  readonly commit: string;
  readonly facts: PatchFacts;
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

/** Asks a node for something once in a run, however many candidates it holds. */
function once<T>(asked: Map<string, Promise<T>>, node: string, ask: () => Promise<T>): Promise<T> {
  const answer = asked.get(node) ?? ask();
  asked.set(node, answer);
  return answer;
}

function listingOf(run: Assembly, node: string): Promise<NodeListing | undefined> {
  return once(run.listings, node, async () => {
    const answer = await nodeListing(run.io, node);
    return answer.ok ? answer.body : undefined;
  });
}

/**
 * Reads the findings a patch record names from the repos of the teams that count, the
 * author's first. A record file's name is the hash of its content (KTD1), so a valid
 * file at a finding's path is that finding, whichever node serves it. Returns nothing
 * when one of them is in no such repo.
 */
async function findingsOf(run: Assembly, candidate: Candidate): Promise<Finding[] | undefined> {
  const nodes = [candidate.node, ...run.counted.filter((node) => node !== candidate.node)];
  const findings: Finding[] = [];
  for (const id of candidate.findings) {
    const path = recordPath({ component: run.listing.component, type: "finding" }, id);
    let found: Finding | undefined;
    for (const node of nodes) {
      const held = await listingOf(run, node);
      if (!held?.records.some((record) => record.path === path)) continue;
      const file = await readRecord(run.io, node, held.head, path);
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

/** Fetches a candidate's commit and checks it as a patch on the pinned commit. */
export async function verify(run: Assembly, candidate: Candidate): Promise<Verdict> {
  const refuse = (reason: string): Verdict => ({ ok: false, reason });
  const { io, scratch, listing } = run;
  const component = listing.component;

  // The lines the patch may change are the lines its findings cite in the team's own checkout.
  const named = await attempt(() => findingsOf(run, candidate));
  if (!named.ok) return refuse(named.reason);
  if (!named.value) return refuse("unresolved-reference");
  for (const finding of named.value) {
    const valid = validateAgainstFiles(finding, await run.files(citedPaths(finding)));
    if (!valid.ok) return refuse(valid.reason);
  }
  const cited = citedRanges(named.value, listing.files);

  const access = await once(run.forks, candidate.node, () => forkAccess(io, candidate.node, component));
  if (!access.ok) return refuse(`node-${access.error}`);
  const fetched = await attempt(async () => {
    // The team's own fork is its own. Another team's is held to a size and a deadline.
    await fetchCommit(scratch, access.body, candidate.commit, candidate.node === run.node ? undefined : FORK_FETCH);
    const parents = await parentsOf(scratch, candidate.commit);
    if (parents.length !== 1 || parents[0] !== component) return undefined;
    return diffTrees(scratch, component, candidate.commit, { bytes: MAX_CHANGES_BYTES, error: "patch-too-large" });
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
    changes.push({ path, mode: change.new?.mode ?? DELETED_MODE, blob: change.new?.hash ?? DELETED_BLOB });
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
  return { ok, node: candidate.node, commit: candidate.commit, facts, before, after: after.value };
}
