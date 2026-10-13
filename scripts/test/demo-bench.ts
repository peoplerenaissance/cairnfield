// What the tests of the demo's scripts share: the second team's node, the invented keys,
// and a bench with both demo nodes and the index of `index.ts`.

import { expect } from "vitest";
import { ADMIN_KEY, INDEX, MODEL_KEY, NODE, REGISTRATION_KEY, TOKEN, bench, demoPlugin } from "../../cli/test/support.ts";
import type { Bench, Site } from "../../cli/test/support.ts";
import { Stopped } from "../demo-stage.ts";
import type { Deployment } from "../demo-stage.ts";
import { testIndex } from "./index.ts";
import type { TestIndex } from "./index.ts";

// Team B's node is not at the address the lens fixtures name for it, so a lens must be rewritten to count its work.
export const TEAM_B = "https://team-b.nodes.example";
// Every key here is invented, and each node has its own.
export const TEAM_B_KEY = "the-admin-key-of-team-b";
export const RESET_KEY = "the-reset-key";
/** The names a script or the command reads a key under. */
export const KEY_NAMES = ["CAIRNFIELD_ADMIN_KEY", "CAIRNFIELD_REGISTRATION_KEY", "ANTHROPIC_API_KEY", "TEAM_A_ADMIN_KEY", "TEAM_B_ADMIN_KEY", "CAIRNFIELD_RESET_KEY"];

export const DEPLOYMENT: Deployment = {
  index: INDEX,
  nodes: { "team-a": NODE, "team-b": TEAM_B },
  adminKeys: { "team-a": ADMIN_KEY, "team-b": TEAM_B_KEY },
  registrationKey: REGISTRATION_KEY,
};

export interface DemoBench {
  /** The bench, which is also the site of Team A's node. */
  readonly on: Bench;
  readonly teamB: Site;
  readonly index: TestIndex;
  /** The demo plugin's two commits. Each node holds a copy of the first. */
  readonly commits: { readonly first: string; readonly later: string };
}

/** Makes a bench with both demo nodes and the index, in a shell that holds every key of the demo. */
export function demoBench(): DemoBench {
  const on = bench();
  const teamB = on.another(TEAM_B, "cairnfield-team-b", TEAM_B_KEY);
  // Each node holds its own copy of the plugin, as its import of the public repo gives it.
  const commits = demoPlugin(on);
  demoPlugin(teamB);
  // The index reads a node two reads of a view after it is told, so a step that does not wait for it fails.
  const index = testIndex(on, new Map<string, Site>([[NODE, on], [TEAM_B, teamB]]), { registration: REGISTRATION_KEY, reset: RESET_KEY }, 2);
  // The shell a script runs in holds every key of the demo.
  Object.assign(on.env, { TEAM_A_ADMIN_KEY: ADMIN_KEY, TEAM_B_ADMIN_KEY: TEAM_B_KEY, CAIRNFIELD_RESET_KEY: RESET_KEY });
  return { on, teamB, index, commits };
}

/** What a script stopped with. */
export const stoppedWith = async (run: Promise<unknown>): Promise<string> => {
  const stopped = await run.catch((error: unknown) => error);
  expect(stopped).toBeInstanceOf(Stopped);
  return (stopped as Stopped).message;
};

/** What a script told the operator holds no key, no token and no Git remote. */
export function expectNothingSecretIn(told: string): void {
  for (const secret of [ADMIN_KEY, TEAM_B_KEY, REGISTRATION_KEY, RESET_KEY, MODEL_KEY, TOKEN]) expect(told).not.toContain(secret);
  expect(told).not.toMatch(/art_v[0-9]+_|artifacts\.cloudflare\.net/);
}
