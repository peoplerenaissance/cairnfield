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

import { relative, sep } from "node:path";
import { DELETED_BLOB, DELETED_MODE, MAX_RECIPE_PATCHES, NODE_ROUTES, SCHEMA_VERSION, recordPath } from "@cairnfield/protocol";
import type { Recipe } from "@cairnfield/protocol";
import { compose, renderDiff } from "../assemble/build.ts";
import { select } from "../assemble/select.ts";
import type { Refusal } from "../assemble/select.ts";
import { verify } from "../assemble/verify.ts";
import type { Assembly, Verified } from "../assemble/verify.ts";
import { citedFileReader, readListing } from "../checkout.ts";
import type { Home } from "../config.ts";
import { copyDir, dropCopy, saveCopy } from "../copy.ts";
import type { Copy } from "../copy.ts";
import { commitChanges, diffTrees, fetchCommit, treeOf, withScratch } from "../git.ts";
import type { Scratch } from "../git.ts";
import type { Io } from "../io.ts";
import { loadLens } from "../lens.ts";
import { addRecord } from "../outbox.ts";
import { EXIT, done, outcomeOf, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { adminKey, callNode, nodeFailed, nodeListing, repoAccess, untilReady } from "../services.ts";
import { publish } from "./publish.ts";

const MESSAGE = "Cairnfield copy";
/** A ref of the scratch repo for the pinned commit. A fetch names what the repo's refs hold, so a fork sends only what its patch adds. */
const PINNED_REF = "refs/cairnfield/pinned";
/** The list of paths the copy changes is read up to this size. The command built the copy, so the list is its own. */
const MAX_CHANGES_BYTES = 64 * 1024 * 1024;

/** The branch of a fork that holds the team's copy of a component. */
export const copyRef = (component: string): string => `refs/heads/copy/${component}`;

/**
 * Pushes a copy to its ref in the team's fork and publishes its recipe. The ref moves
 * when the selection changes, so the push may replace what the ref held. The fork holds
 * the copy before the record that names its tree is published.
 */
async function publishCopy(io: Io, home: Home, scratch: Scratch, key: string, copy: Copy): Promise<Outcome> {
  const { component, commit, patches, tree } = copy;
  const fork = await untilReady(io, () => callNode(io, home, NODE_ROUTES.createFork, { key, body: { component } }));
  if (!fork.ok) return nodeFailed(fork);
  const access = await repoAccess(io, home, { repo: "fork", component, scope: "write" });
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
  const records = held?.ok ? held.body : undefined;
  const { candidates, refused: unread } = await select(io, home, lens, component, records);
  const refused: Refusal[] = [...unread];
  const skipped: Outcome["output"][] = [];
  const none = (): Outcome => done({ component, level, patches: [], refused, skipped });
  if (candidates.length === 0) return none();

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
      counted: [node, ...(level === 2 ? lens.teams.filter((team) => team !== node) : [])],
      listings: new Map([[node, Promise.resolve(records)]]),
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
    const built = await diffTrees(scratch, component, commit, { bytes: MAX_CHANGES_BYTES, error: "git-output-too-large" });
    const entry = (path: string, mode: string, blob: string): string => `${mode} ${blob} ${path}`;
    const inCommit = built.map((change) => entry(new TextDecoder().decode(change.path), change.new?.mode ?? DELETED_MODE, change.new?.hash ?? DELETED_BLOB));
    const intended = composed.changes.map(({ path, mode, blob }) => entry(path, mode, blob));
    if (inCommit.sort().join("\n") !== intended.sort().join("\n")) return stop(EXIT.failed, "assembly-failed");
    const content = new Map<string, Uint8Array>(composed.blobs);
    for (const { before } of selected) for (const [blob, bytes] of before) content.set(blob, bytes);
    io.warn(renderDiff(listing.files, composed.changes, (blob) => content.get(blob)));

    await saveCopy(home, scratch, copy);
    const published = lens.publishRecipes ? await publishCopy(io, home, scratch, key, copy) : done({});
    return done(
      {
        component,
        level,
        patches: selected.map(({ node: from, commit: patch, facts }) => ({ patchId: facts.patchId, node: from, commit: patch, kind: facts.kind, size: facts.size })),
        refused,
        skipped,
        tree: copy.tree,
        commit,
        copy: relative(home.root, copyDir(home, component)).split(sep).join("/"),
        paths: composed.changes.map(({ path }) => path),
        ...published.output,
      },
      published.code,
    );
  });
}
