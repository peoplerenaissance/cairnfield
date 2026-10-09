// `view`: the index view of one component commit, as the team's lens lets it count.
//
// Only the team's own work and the work of the teams its lens names counts for the team
// or shows in its view (R23). So every record from another node is dropped first, and
// then each count the index made over all nodes is made again over what is left
// (KTD38). The index is not trusted to have done either.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { INDEX_ROUTES, criterionCounts, isConfirmed, patchConfirmations } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
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

const nodesOf = (sourced: readonly { readonly node: string }[]): string[] => [...new Set(sourced.map(({ node }) => node))].sort();

/** Drops everything that comes from a node outside `counted`, and counts again. */
export function throughLens(view: View, counted: ReadonlySet<string>): View {
  const kept = <T extends { readonly node: string }>(all: readonly T[]): T[] => all.filter(({ node }) => counted.has(node));

  const findings = view.findings.flatMap((group) => {
    const members = kept(group.findings);
    if (members.length === 0) return [];
    // A re-check or a dispute of a finding that is gone has nothing left to point at (KTD5).
    const ids = new Set(members.map(({ id }) => id));
    const rechecks = kept(group.rechecks).filter(({ record }) => ids.has(record.finding));
    const counterFindings = kept(group.counterFindings).filter(({ record }) => ids.has(record.finding));
    const nodes = nodesOf([...members, ...rechecks]);
    return [
      {
        ...group,
        findings: members,
        rechecks,
        counterFindings,
        nodes,
        confirmed: isConfirmed(nodes),
        criteria: criterionCounts(members, rechecks).map((count) => ({ ...count, nodes: [...count.nodes] })),
      },
    ];
  });

  const hosts = new Map<string, number>();
  for (const group of findings) {
    if (group.host !== undefined) hosts.set(group.host, (hosts.get(group.host) ?? 0) + group.findings.length);
  }

  const patches = view.patches.flatMap((group) => {
    const entries = group.patches.flatMap((patch) => {
      const records = kept(patch.records);
      if (records.length === 0) return [];
      const rechecks = kept(patch.rechecks);
      const nodes = patchConfirmations(patch.patchId, records.map(({ node }) => ({ node, patchId: patch.patchId })), rechecks);
      return [{ ...patch, records, rechecks, nodes, confirmed: isConfirmed(nodes) }];
    });
    return entries.length === 0 ? [] : [{ patches: entries }];
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
