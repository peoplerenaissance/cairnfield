// `approvals`: prints the team's table of what it may install (R32), with one entry for
// each component. The table is the decisions file, which only `decide` writes. What this
// prints is what that file holds, so its output saved to a file is an approvals file for
// `verify`. A team that has given no verdict gets the table with no entry.

import type { Home } from "../config.ts";
import { readDecisions, tableOf } from "../decisions.ts";
import { done } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";

export async function approvals(home: Home): Promise<Outcome> {
  return done(tableOf((await readDecisions(home.decisions)) ?? []));
}
