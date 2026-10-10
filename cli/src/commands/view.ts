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

import { isConfirmed, matchGroups, patchConfirmations, patchGroups } from "@cairnfield/protocol";
import type { Sourced, View } from "@cairnfield/protocol";
import type { Home } from "../config.ts";
import type { Io } from "../io.ts";
import { loadLens } from "../lens.ts";
import { EXIT, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { indexView } from "../services.ts";

type FindingGroup = View["findings"][number];

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
    // Patches whose changed lines overlap or adjoin sit side by side (R16).
    return patchGroups(left).map((together) => ({ patches: together }));
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
  // The nodes whose work counts for the team: its own, and those its lens names.
  const counted = new Set([home.config.node, ...(await loadLens(home)).teams]);
  return done(throughLens(await indexView(io, index, component), counted));
}
