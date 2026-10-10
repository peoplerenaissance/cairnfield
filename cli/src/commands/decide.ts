// `decide`: writes down the verdict the operator gave for one commit of a component (R32).
//
// The operator rules. The command computes no verdict and offers none. It records the
// component by the Git URL it is pinned from, the commit, the verdict and the time, and,
// when the team built a copy of that commit, the copy's file-tree hash. That hash is
// what `verify` later holds an installed copy to.

import { readListing } from "../checkout.ts";
import type { Home } from "../config.ts";
import { readCopy } from "../copy.ts";
import { isVerdict, recordDecision } from "../decisions.ts";
import type { Decision } from "../decisions.ts";
import type { Io } from "../io.ts";
import { EXIT, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";

export interface DecideRequest {
  /** The Git URL the component is pinned from. */
  readonly url: string;
  readonly commit: string;
  readonly verdict: string | undefined;
}

export async function decide(io: Io, home: Home, request: DecideRequest): Promise<Outcome> {
  const { url, commit, verdict } = request;
  if (!isVerdict(verdict)) return stop(EXIT.usage, "usage");
  if (!(await readListing(home, commit))) return stop(EXIT.invalid, "unknown-component", { component: commit });
  const copy = await readCopy(home, commit);
  // The mitigations a team requires are the patches in its copy. With no copy, there is nothing to install that has them.
  if (verdict === "approved-with-required-mitigations" && !copy) return stop(EXIT.invalid, "no-copy", { component: commit });

  const decision: Decision = { url, commit, verdict, date: new Date(io.now()).toISOString(), ...(copy ? { tree: copy.tree } : {}) };
  await recordDecision(home, decision);
  return done(decision);
}
