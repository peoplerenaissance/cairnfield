// `pin`: has the node import a component and makes the local checkout of one commit.
//
// A component is its full commit hash (R8). The node imports the branch that holds the
// commit, and the copy is ready when the node says it holds that commit (KTD36). With an
// index in the config, the command registers its node and the commit there (KTD12,
// KTD40). A commit that is already pinned keeps its checkout, so a team that adds an
// index later runs `pin` again and nothing else changes. A checkout whose listing cannot
// be read is the one exception: `pin` makes it again.

import { relative } from "node:path";
import { INDEX_ROUTES, NODE_ROUTES } from "@cairnfield/protocol";
import { checkoutDir, exportCheckout, readListing } from "../checkout.ts";
import { REGISTRATION_KEY, keyFrom } from "../config.ts";
import type { Home } from "../config.ts";
import { fetchCommit, withScratch } from "../git.ts";
import type { Io } from "../io.ts";
import { EXIT, Stop, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { adminKey, callIndex, callNode, indexFailed, nodeFailed, repoAccess, untilReady } from "../services.ts";

export interface Component {
  /** The Git URL the node imports from. */
  readonly url: string;
  /** The branch that holds the commit. No default branch is relied on (KTD36). */
  readonly branch: string;
  readonly commit: string;
}

/** Registers the node and the commit. The index may hold either already. */
async function register(io: Io, home: Home, index: string, key: string, component: Component): Promise<void> {
  const calls = [
    () => callIndex(io, index, INDEX_ROUTES.registerNode, { key, body: { url: home.config.node } }),
    () => callIndex(io, index, INDEX_ROUTES.registerComponent, { key, body: component }),
  ];
  for (const call of calls) {
    const answer = await call();
    if (!answer.ok && !(answer.error === "refused" && answer.reason === "already-registered")) indexFailed(answer);
  }
}

export async function pin(io: Io, home: Home, component: Component): Promise<Outcome> {
  const key = adminKey(io);
  const { index } = home.config;
  // Read before any call, so a missing key stops the command before the node imports anything.
  const registration = index === undefined ? undefined : { index, key: keyFrom(io, REGISTRATION_KEY) };

  const copy = await untilReady(io, () => callNode(io, home, NODE_ROUTES.importCopy, { key, body: component }));
  if (!copy.ok) {
    // The node says this of a finished copy without the commit, and of a repo that is not there.
    if (copy.error === "refused" && copy.reason === "not-found") {
      return stop(EXIT.notHeld, "not-held", { component: component.commit });
    }
    return nodeFailed(copy);
  }
  if (registration) await register(io, home, registration.index, registration.key, component);

  const { commit } = component;
  // A listing that cannot be read as one is made again with its checkout: one that was
  // damaged, or one written before a listing named its URL. Every other command stops at it.
  let listing = await readListing(home, commit).catch((error: unknown) => (error instanceof Stop ? undefined : Promise.reject(error)));
  if (!listing) {
    const access = await repoAccess(io, home, { repo: "copy", component: commit, scope: "read" });
    listing = await withScratch(io, async (scratch) => {
      await fetchCommit(scratch, access, commit);
      return exportCheckout(home, scratch, component);
    });
  }
  return done({
    component: commit,
    checkout: relative(home.root, checkoutDir(home, commit)),
    files: listing.files.length,
    // What the pinned tree holds that the checkout does not, by reason (KTD16).
    leftOut: listing.leftOut,
    registered: registration !== undefined,
  });
}
