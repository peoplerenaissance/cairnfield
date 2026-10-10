// `decide`: writes down the verdict the operator gave for one commit of a component (R32).
//
// The operator rules. The command computes no verdict and offers none. It records the
// component by the Git URL the commit was pinned from, the commit, the verdict and the
// time, and, when the team built a copy of that commit, the copy's file-tree hash. That
// hash is what `verify` later holds an installed copy to.
//
// A verdict on a copy is a verdict on the diff the operator read. So the operator names
// the copy's tree hash, as `assemble` printed it with that diff, and a copy that was
// built again since, with another selection, is not approved by mistake.

import { readListing } from "../checkout.ts";
import type { Home } from "../config.ts";
import { readCopy } from "../copy.ts";
import { isVerdict, recordDecision } from "../decisions.ts";
import type { Decision } from "../decisions.ts";
import type { Io } from "../io.ts";
import { EXIT, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";

export interface DecideRequest {
  readonly component: string;
  readonly verdict: string | undefined;
  /** The file-tree hash of the copy the verdict is for, when the team built one. */
  readonly tree: string | undefined;
}

export async function decide(io: Io, home: Home, request: DecideRequest): Promise<Outcome> {
  const { component, verdict, tree } = request;
  if (!isVerdict(verdict)) return stop(EXIT.usage, "usage");
  const listing = await readListing(home, component);
  if (!listing) return stop(EXIT.invalid, "unknown-component", { component });
  const copy = await readCopy(home, component);
  // The mitigations a team requires are the patches in its copy. With no copy, there is nothing to install that has them.
  if (!copy && (tree !== undefined || verdict === "approved-with-required-mitigations")) return stop(EXIT.invalid, "no-copy", { component });
  if (copy && tree === undefined) return stop(EXIT.invalid, "no-tree", { component });
  if (copy && tree !== copy.tree) return stop(EXIT.invalid, "tree-differs", { component });

  const decision: Decision = { url: listing.url, commit: component, verdict, date: new Date(io.now()).toISOString(), ...(copy ? { tree: copy.tree } : {}) };
  await recordDecision(home, decision);
  // A checkout leaves out what it cannot hold safely, such as a link. The copy's tree still
  // holds those entries, so only a clone of the published copy has that tree, and the
  // folder the command exported does not.
  const leftOut = copy ? listing.leftOut.length : 0;
  return done({ ...decision, ...(leftOut === 0 ? {} : { leftOut }) });
}
