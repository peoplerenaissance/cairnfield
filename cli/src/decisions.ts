// The team's own table of what it may install (R32): one entry for each component, with
// the verdict the operator gave, when, and the file-tree hash of the copy the team built.
//
// The table is a local file, `.cairnfield/decisions.json`. A person gives the verdict,
// and the command only writes it down. The file is never placed in the outbox and never
// published. A team shares it by its own means, and `verify` reads the copy it is given
// (R36).

import { SCHEMA_VERSION, compare, field } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import { readWhole, writeWhole } from "./checkout.ts";
import type { Home } from "./config.ts";
import { EXIT, stop } from "./outcome.ts";

/** The three verdicts of R32. */
export const VERDICTS = ["approved", "approved-with-required-mitigations", "not-approved"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: unknown): value is Verdict {
  return (VERDICTS as readonly unknown[]).includes(value);
}

/** A table holds at most this many components. The plan sets no bound, so this is a first value. */
const MAX_DECISIONS = 10_000;
/** A time as `Date.toISOString` writes it. */
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

const DECISION = field.shape({
  /** The Git URL the commit was pinned from, which names the component across its commits. */
  url: field.url(),
  /** The commit the verdict is for. */
  commit: field.gitHash(),
  verdict: field.oneOf(VERDICTS),
  /** When the verdict was given, in UTC. */
  date: field.text(24),
  /** The file-tree hash of the copy the team built of the commit, when it built one. */
  tree: field.optional(field.gitHash()),
});
export type Decision = Infer<typeof DECISION>;

const TABLE = field.shape({ version: field.version(), decisions: field.listOf(DECISION, MAX_DECISIONS) });

/**
 * Reads a decisions file: the team's own, or a copy of another machine's. Returns nothing
 * when there is no file. A file in any other form ends the command, because a table that
 * cannot be read says nothing about what may be installed.
 */
export async function readDecisions(file: string): Promise<Decision[] | undefined> {
  const bad = (): never => stop(EXIT.failed, "bad-decisions");
  const decisions = (await readWhole(file, TABLE, bad))?.decisions;
  if (!decisions) return undefined;
  // A component has one entry. A table with two for one URL, merged by hand, could hold an approval that was withdrawn.
  const repeats = new Set(decisions.map(({ url }) => url)).size !== decisions.length;
  return repeats || decisions.some(({ date }) => !TIME.test(date)) ? bad() : decisions;
}

/**
 * Writes a verdict into the team's table. A component has one entry, so a verdict for a
 * newer commit takes the place of the one before it.
 */
export async function recordDecision(home: Home, decision: Decision): Promise<void> {
  const others = ((await readDecisions(home.decisions)) ?? []).filter(({ url }) => url !== decision.url);
  // Refused before the file is replaced: a table past its limit could not be read back.
  if (others.length >= MAX_DECISIONS) return stop(EXIT.invalid, "too-many-decisions");
  const decisions = [...others, decision].sort((a, b) => compare(a.url, b.url));
  await writeWhole(home.decisions, { version: SCHEMA_VERSION, decisions });
}
