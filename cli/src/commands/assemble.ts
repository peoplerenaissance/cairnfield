// `assemble`: builds the team's own copy of a pinned commit at its lens's patch level,
// and shows what went into it (R23, R25).
//
// The lens selects the candidates. Each is fetched from the fork of the team that wrote
// it and checked again here, and the index is taken at its word for nothing (KTD23).
// The patches that pass are applied as line edits to one commit with fixed metadata, so
// two teams with the same pinned commit and the same patches get the same file-tree
// hash (KTD22). The operator is shown the full diff of the copy against the original.
//
// The copy stays on this machine, in a folder beside the checkouts. Only a lens that
// publishes recipes has the command push the copy to the team's fork and publish a
// recipe record. A team that does not publish recipes publishes nothing about its copy.

import { MAX_RECIPE_PATCHES, SCHEMA_VERSION, recordPath } from "@cairnfield/protocol";
import type { FileEntry, Recipe } from "@cairnfield/protocol";
import { compose, renderDiff } from "../assemble/build.ts";
import { namedTeams, select } from "../assemble/select.ts";
import { verify } from "../assemble/verify.ts";
import type { Assembly, Verified } from "../assemble/verify.ts";
import { citedFileReader, decoded, readListing } from "../checkout.ts";
import { shownPath } from "../config.ts";
import type { Home } from "../config.ts";
import { copyDir, dropCopy, keepCopy, stageCopy } from "../copy.ts";
import type { Copy } from "../copy.ts";
import { changedEntry, commitChanges, diffTrees, fetchCommit, treeOf, withScratch } from "../git.ts";
import type { Scratch } from "../git.ts";
import type { Io } from "../io.ts";
import { loadLens } from "../lens.ts";
import { addRecord } from "../outbox.ts";
import { EXIT, done, outcomeOf, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { adminKey, nodeFailed, nodeListing, repoAccess, writableFork } from "../services.ts";
import { publish } from "./publish.ts";

const MESSAGE = "Cairnfield copy";
/** A ref of the scratch repo for the pinned commit. A fetch names what the repo's refs hold, so a fork sends only what its patch adds. */
const PINNED_REF = "refs/cairnfield/pinned";
/** The list of paths the copy changes is read up to this size. The command built the copy, so the list is its own. */
const MAX_BUILT_CHANGES_BYTES = 64 * 1024 * 1024;

/** A candidate that did not get into the copy, with the code of why. */
interface Refusal {
  readonly node: string;
  readonly record: string;
  readonly reason: string;
}

/** The branch of a fork that holds the team's copy of a component. */
export const copyRef = (component: string): string => `refs/heads/copy/${component}`;

/**
 * Pushes a copy to its ref in the team's fork and publishes its recipe. The ref moves
 * when the selection changes, so the push may replace what the ref held. The fork holds
 * the copy before the record that names its tree is published.
 */
async function publishCopy(io: Io, home: Home, scratch: Scratch, key: string, copy: Copy): Promise<Outcome> {
  const { component, commit, patches, tree } = copy;
  const access = await writableFork(io, home, key, component);
  await scratch.git("push", ["push", "--porcelain", "--force", access.remote, `${commit}:${copyRef(component)}`], { access });

  const record: Recipe = { version: SCHEMA_VERSION, type: "recipe", component, patches: [...patches], tree };
  const recipe = await addRecord(home, record);
  const published = await outcomeOf(() => publish(io, home, recordPath(record, recipe)));
  return done({ recipe, ...published.output }, published.code);
}

export async function assemble(io: Io, home: Home, component: string): Promise<Outcome> {
  const listing = await readListing(home, component);
  if (!listing) return stop(EXIT.invalid, "unknown-component", { component });
  const lens = await loadLens(home);
  const level = lens.patchLevel;
  const { node } = home.config;
  // A copy from an earlier run is not the copy of this one.
  await dropCopy(home, component);

  // A team that has published no record yet has no team repo, and so no patch of its own.
  const held = level === 0 ? undefined : await nodeListing(io, node);
  if (held && !held.ok && !(held.error === "refused" && held.reason === "not-found")) return nodeFailed(held);
  const candidates = await select(io, home, lens, component, held?.ok ? held.body : undefined);
  const refused: Refusal[] = [];
  const skipped: Outcome["output"][] = [];
  const none = (): Outcome => done({ component, level, patches: [], refused, skipped });
  if (!held || candidates.length === 0) return none();

  // The pinned commit comes from the team's own copy of the component, which needs the node's key.
  const key = adminKey(io);
  const pinned = await repoAccess(io, home, { repo: "copy", component, scope: "read" });
  return withScratch(io, async (scratch) => {
    await fetchCommit(scratch, pinned, component);
    await scratch.git("update-ref", ["update-ref", PINNED_REF, component]);
    const run: Assembly = {
      io,
      node,
      listing,
      scratch,
      files: citedFileReader(home, listing),
      counted: [node, ...namedTeams(lens, node)],
      listings: new Map([[node, Promise.resolve(held)]]),
    };

    // Two teams may have written the same patch. One of them is enough, and the team's own comes first.
    const taken = new Map<string, Verified>();
    const settled = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.expected !== undefined && settled.has(candidate.expected)) continue;
      const verdict = await verify(run, candidate);
      if (!verdict.ok) {
        refused.push({ node: candidate.node, record: candidate.record, reason: verdict.reason });
        continue;
      }
      const { patchId, kind } = verdict.facts;
      if (settled.has(patchId)) continue;
      settled.add(patchId);
      if (lens.patchKinds.includes(kind)) taken.set(patchId, verdict);
      else skipped.push({ patchId, node: verdict.node, commit: verdict.commit, kind });
    }
    if (taken.size === 0) return none();
    if (taken.size > MAX_RECIPE_PATCHES) return stop(EXIT.invalid, "too-many-patches", { patches: taken.size });

    const patches = [...taken.keys()].sort();
    const selected = patches.flatMap((patchId) => taken.get(patchId) ?? []);
    const composed = await compose(listing.files, selected);
    if (!composed.ok) return stop(EXIT.invalid, "patches-conflict", { patches: composed.conflict, refused, skipped });
    const commit = await commitChanges(scratch, component, composed.changes, composed.blobs, MESSAGE);
    const copy: Copy = { component, patches, tree: await treeOf(scratch, commit), commit };

    // The diff is of the commit that was built: Git is asked which paths it changes, and
    // they must be the changes that were composed.
    const built = await diffTrees(scratch, component, commit, { bytes: MAX_BUILT_CHANGES_BYTES, error: "git-output-too-large" });
    const entries = (changes: readonly FileEntry[]): string => changes.map(({ path, mode, blob }) => `${mode} ${blob} ${path}`).sort().join("\n");
    const inCommit = built.map((change) => changedEntry(change, decoded(change.path) ?? ""));
    if (entries(inCommit) !== entries(composed.changes)) return stop(EXIT.failed, "assembly-failed");
    const content = new Map<string, Uint8Array>(composed.blobs);
    for (const { before } of selected) for (const [blob, bytes] of before) content.set(blob, bytes);
    renderDiff(listing.files, composed.changes, (blob) => content.get(blob), io.warn);

    // The copy is exported before anything is published, so a copy that cannot be exported
    // publishes nothing. It counts as built only when what the lens asked for was done, so
    // a run that could not publish leaves none behind. A notice the index did not take is
    // no failure of the copy: its recipe is published all the same.
    let published: Outcome;
    try {
      await stageCopy(home, scratch, copy);
      published = lens.publishRecipes ? await publishCopy(io, home, scratch, key, copy) : done({});
    } catch (error) {
      await dropCopy(home, component);
      throw error;
    }
    const kept = published.code === EXIT.ok || published.output["notice"] === "failed";
    if (kept) await keepCopy(home, copy);
    else await dropCopy(home, component);
    return done(
      {
        component,
        level,
        patches: selected.map(({ node: from, commit: patch, facts }) => ({ patchId: facts.patchId, node: from, commit: patch, kind: facts.kind, size: facts.size })),
        refused,
        skipped,
        tree: copy.tree,
        commit,
        ...(kept ? { copy: shownPath(home, copyDir(home, component)) } : {}),
        paths: composed.changes.map(({ path }) => path),
        ...published.output,
      },
      published.code,
    );
  });
}
