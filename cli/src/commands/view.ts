// `view`: the index view of one component commit, as the team's lens lets it count.
//
// Only the team's own work and the work of the teams its lens names counts for the team
// or shows in its view (R23). So every record from another node is dropped first, and
// what is left is grouped and counted again here (KTD38). The index groups and counts
// over all nodes, and a record that is dropped may be the one that held a group together
// or gave it its second organization.
//
// The index is still taken at its word for which node a record came from and which
// content a path holds. This command shows work. Assembly fetches a patch from its node
// and checks it there (KTD23).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { INDEX_ROUTES, hunksTouch, isConfirmed, matchGroups, patchConfirmations } from "@cairnfield/protocol";
import type { Sourced, View } from "@cairnfield/protocol";
import type { Home } from "../config.ts";
import type { Io } from "../io.ts";
import { parseLens } from "../lens.ts";
import { EXIT, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { callIndex, indexFailed } from "../services.ts";

/** The nodes whose work counts for the team: its own, and those its lens names. */
async function countedNodes(home: Home): Promise<ReadonlySet<string>> {
  if (home.config.lens === undefined) return stop(EXIT.usage, "no-lens");
  let text: string;
  try {
    text = await readFile(resolve(home.root, home.config.lens), "utf8");
  } catch {
    return stop(EXIT.usage, "no-lens");
  }
  const read = parseLens(text);
  if (!read.ok) return stop(EXIT.usage, "bad-lens", { reason: read.error });
  return new Set([home.config.node, ...read.lens.teams]);
}

type FindingGroup = View["findings"][number];
type Patch = View["patches"][number]["patches"][number];

const nodesOf = (sourced: readonly { readonly node: string }[]): string[] => [...new Set(sourced.map(({ node }) => node))].sort();

/** `matchGroups` gives back the records it was given. This finds each one's entry in the view again. */
function entriesOf<E extends Sourced>(all: readonly E[]): (matched: readonly Sourced[]) => E[] {
  const known = new Map<Sourced, E>(all.map((entry) => [entry, entry]));
  return (matched) => matched.flatMap((sourced) => known.get(sourced) ?? []);
}

/**
 * Matches the records of one index group again by the protocol's own rule (R10). The
 * group may come apart, and each part gets its own organizations and counts.
 */
function regroup(group: FindingGroup): FindingGroup[] {
  const listing = group.paths.map((path) => ({ path, mode: "100644", blob: group.blob }));
  const findings = entriesOf(group.findings);
  const rechecks = entriesOf(group.rechecks);
  const counterFindings = entriesOf(group.counterFindings);
  return matchGroups([...group.findings, ...group.rechecks, ...group.counterFindings], listing).map((matched) => ({
    blob: matched.blob,
    observation: matched.observation,
    ...(matched.host === undefined ? {} : { host: matched.host }),
    paths: [...matched.paths],
    findings: findings(matched.findings),
    rechecks: rechecks(matched.rechecks),
    counterFindings: counterFindings(matched.counterFindings),
    nodes: [...matched.nodes],
    confirmed: matched.confirmed,
    criteria: matched.criteria.map((count) => ({ ...count, nodes: [...count.nodes] })),
  }));
}

/** Whether two patches change lines of one content that overlap or adjoin (R16). */
function patchesTouch(a: Patch, b: Patch): boolean {
  return a.changes.some((change) =>
    b.changes.some(
      (other) => change.blob === other.blob && change.hunks.some((hunk) => other.hunks.some((against) => hunksTouch(hunk, against))),
    ),
  );
}

/** Puts patches that touch in one group, directly or through another patch. */
function sideBySide(patches: readonly Patch[]): Patch[][] {
  let groups: Patch[][] = [];
  for (const patch of patches) {
    const joined = groups.filter((group) => group.some((member) => patchesTouch(member, patch)));
    groups = [...groups.filter((group) => !joined.includes(group)), [...joined.flat(), patch]];
  }
  return groups;
}

/** Drops everything that comes from a node outside `counted`, then groups and counts again. */
export function throughLens(view: View, counted: ReadonlySet<string>): View {
  const kept = <T extends { readonly node: string }>(all: readonly T[]): T[] => all.filter(({ node }) => counted.has(node));

  const findings = view.findings.flatMap((group) =>
    regroup({
      ...group,
      findings: kept(group.findings),
      rechecks: kept(group.rechecks),
      counterFindings: kept(group.counterFindings),
    }),
  );

  const hosts = new Map<string, number>();
  for (const group of findings) {
    if (group.host !== undefined) hosts.set(group.host, (hosts.get(group.host) ?? 0) + group.findings.length);
  }

  const patches = view.patches.flatMap((group) => {
    const left = group.patches.flatMap((patch) => {
      const records = kept(patch.records);
      if (records.length === 0) return [];
      const rechecks = kept(patch.rechecks);
      const nodes = patchConfirmations(patch.patchId, records.map(({ node }) => ({ node, patchId: patch.patchId })), rechecks);
      return [{ ...patch, records, rechecks, nodes, confirmed: isConfirmed(nodes) }];
    });
    return sideBySide(left).map((together) => ({ patches: together }));
  });

  const recipes = view.recipes.flatMap((recipe) => {
    const records = kept(recipe.records);
    return records.length === 0 ? [] : [{ ...recipe, records, nodes: nodesOf(records) }];
  });

  const nodes = kept(view.nodes);
  return {
    ...view,
    organizations: nodes.length,
    nodes,
    claims: kept(view.claims),
    findings,
    hosts: [...hosts].map(([host, count]) => ({ host, count })).sort((a, b) => (a.host < b.host ? -1 : 1)),
    patches,
    recipes,
    pending: kept(view.pending),
    rejected: kept(view.rejected),
  };
}

export async function view(io: Io, home: Home, component: string): Promise<Outcome> {
  const { index } = home.config;
  if (index === undefined) return stop(EXIT.noIndex, "no-index");
  const counted = await countedNodes(home);
  const answer = await callIndex(io, index, INDEX_ROUTES.view, { params: { component } });
  if (!answer.ok) return indexFailed(answer);
  if (answer.body.component !== component) return stop(EXIT.index, "index-bad-answer");
  return done(throughLens(answer.body, counted));
}
