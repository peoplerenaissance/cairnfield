// A node's count of the fetches of its fork of a component (R45), as the index holds it.
// The node states the number. The index holds it to its form and cannot check its truth,
// so a view carries it under `declared`, apart from everything the index computed (KTD42).
//
// The index asks for the counts inside a sync of the node (KTD43), and a count never
// fails that sync. A node that cannot be reached, or whose answer is not the contract's,
// changes nothing: the count of an earlier sync stays. Only a node that says it has
// counted no fetch takes its count away. An error in writing the counts leaves here, and
// the sync catches it (see `sync.ts`).

import type { Env } from "./env.ts";
import { FETCH_AHEAD, readFetches } from "./fetch.ts";

/**
 * Holds for the sync of a node that started last, and for no other. Only that sync
 * writes what it read, as only it says what is processed. One that started before it may
 * get an older count, and may get it later.
 */
const STARTED_LAST = "(SELECT syncs FROM nodes WHERE url = ?1) = ?3";

/** Stores the count a node gave for a component, unless the index holds that number already. */
function stored(db: D1Database, node: string, component: string, syncs: number, fetches: number): D1PreparedStatement[] {
  const changed = `${STARTED_LAST} AND NOT EXISTS (SELECT 1 FROM fetch_counts WHERE component = ?2 AND node = ?1 AND fetches = ?4)`;
  return [
    // The view of the component lists the count, so its version goes up. It runs first,
    // under the condition of the statement after it, so it goes up only with a new number.
    db.prepare(`UPDATE components SET view_version = view_version + 1 WHERE component = ?2 AND ${changed}`).bind(node, component, syncs, fetches),
    db
      .prepare(`INSERT INTO fetch_counts (component, node, fetches) SELECT ?2, ?1, ?4 WHERE ${changed} ON CONFLICT (component, node) DO UPDATE SET fetches = excluded.fetches`)
      .bind(node, component, syncs, fetches),
  ];
}

/** Drops the count of a node that says it has none for a component. A missing count is not a count of zero. */
function dropped(db: D1Database, node: string, component: string, syncs: number): D1PreparedStatement[] {
  return [
    // It runs first, and goes up only when the statement after it takes a count away.
    db
      .prepare(`UPDATE components SET view_version = view_version + 1 WHERE component = ?2 AND ${STARTED_LAST} AND EXISTS (SELECT 1 FROM fetch_counts WHERE component = ?2 AND node = ?1)`)
      .bind(node, component, syncs),
    db.prepare(`DELETE FROM fetch_counts WHERE component = ?2 AND node = ?1 AND ${STARTED_LAST}`).bind(node, component, syncs),
  ];
}

/**
 * The most components one sync asks a node about. Each costs one read of the node and two
 * statements, and a sync is one invocation, which may make a set number of both. So the
 * bound is this number and not the index's limit on components, which whoever runs the
 * index sets.
 */
export const PASS_COUNTS = 60;

/**
 * The components one sync asks about: all of them, or the run of them whose turn it is.
 * The runs follow each other around the list with the number of the node's syncs, so a
 * node that lists more than one pass takes is asked about all of them over several syncs.
 */
export function inTurn(components: readonly string[], syncs: number): readonly string[] {
  if (components.length <= PASS_COUNTS) return components;
  const from = (syncs * PASS_COUNTS) % components.length;
  return [...components.slice(from), ...components.slice(0, from)].slice(0, PASS_COUNTS);
}

/**
 * Asks a node for its count of the fetches of its fork of each of these components, and
 * stores what it says. `syncs` names the sync that asks, by the number of syncs of the
 * node that had started when it did. The writes go in one batch, each with the change to
 * its view's version.
 */
export async function readFetchCounts(env: Env, node: string, syncs: number, components: readonly string[]): Promise<void> {
  const db = env.DB;
  const statements: D1PreparedStatement[] = [];
  const asked = inTurn(components, syncs);
  for (let at = 0; at < asked.length; at += FETCH_AHEAD) {
    const answers = await Promise.all(asked.slice(at, at + FETCH_AHEAD).map(async (component) => ({ component, said: await readFetches(node, component) })));
    for (const { component, said } of answers) {
      // No answer the index can use: what it holds for the component stays.
      if (!said) continue;
      statements.push(...(said.counted ? stored(db, node, component, syncs, said.fetches) : dropped(db, node, component, syncs)));
    }
  }
  if (statements.length > 0) await db.batch(statements);
}
