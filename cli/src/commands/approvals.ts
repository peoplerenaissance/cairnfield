// `approvals`: prints the team's table of what it may install (R32), with one entry for
// each component. The table is the decisions file, which only `decide` writes.

import type { Home } from "../config.ts";
import { readDecisions } from "../decisions.ts";
import { done } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";

export async function approvals(home: Home): Promise<Outcome> {
  return done({ approvals: (await readDecisions(home.decisions)) ?? [] });
}
