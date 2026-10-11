// An index for the scripts' tests. It stands behind `fetch` in a bench, reads the local
// repos that stand in for the nodes, and builds a view with the protocol's own rules:
// the record checks, the patch checks, the match groups and the patch groups. Those are
// the rules the index Worker applies, so a view here groups, collapses and rejects as the
// deployed index would. It does not keep the Worker's order of entries, and it counts no
// hosts, so a test sorts what it compares.
//
// It keeps what the scripts depend on in the Worker's behavior. It reads a node only
// when a notice names it. It never drops a record a node has stopped listing. A reset
// drops every record and reads every node again. A notice for a node it does not know
// answers not-found.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  REGISTRATION_KEY_HEADER,
  RESET_KEY_HEADER,
  SCHEMA_VERSION,
  TEAM_BRANCH,
  bySource,
  checkPatch,
  citedRanges,
  compare,
  isConfirmed,
  matchGroups,
  parseRecordPath,
  patchConfirmations,
  patchGroups,
  sha256Hex,
  validateRecordFile,
} from "@cairnfield/protocol";
import type { AnyRecord, FileListing, Finding, Patch, PatchFacts, Recipe, Sourced, View } from "@cairnfield/protocol";
import { INDEX, filesOf, git } from "../../cli/test/support.ts";
import type { Bench, Seen, Site } from "../../cli/test/support.ts";
import { PLUGIN } from "../demo-stage.ts";

/** A record file as the index read it from a node. */
interface Read {
  readonly node: string;
  readonly path: string;
  /** The head of the node's repo when the file was read. */
  readonly head: string;
  readonly content: Uint8Array;
}

interface Published<R extends AnyRecord = AnyRecord> extends Sourced<R> {
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
}

export interface TestIndex {
  /** Every request the index got, in order. */
  readonly requests: Seen[];
  /** How many record files the index holds. */
  held(): number;
  /** The view of one component commit, or nothing for a commit that is not registered. */
  view(component: string): Promise<View | undefined>;
}

const isOfType = <T extends AnyRecord["type"]>(entry: Published, type: T): entry is Published<Extract<AnyRecord, { type: T }>> => entry.record.type === type;

const blobOf = (repo: string, name: string): Uint8Array => new Uint8Array(execFileSync("git", ["-C", repo, "cat-file", "blob", name]));

/**
 * Puts an index at the bench's index address. `sites` holds each node by its base URL.
 * A node is read only once it is registered, and a record only once its component is.
 */
export function testIndex(on: Bench, sites: ReadonlyMap<string, Site>, keys: { readonly registration: string; readonly reset: string }): TestIndex {
  const requests: Seen[] = [];
  const nodes: string[] = [];
  const components = new Set<string>();
  const read = new Map<string, Read>();
  const processed = new Map<string, string>();
  // A commit names its files for good, and a hash its content, so each is read from Git once.
  const copies = new Map<string, FileListing>();
  const content = new Map<string, Uint8Array>();

  /** Reads what a node lists that the index has not read yet. */
  function sync(node: string): void {
    const team = sites.get(node)?.repo("team");
    if (team === undefined || !existsSync(team)) return;
    const head = git(team, ["rev-parse", "--verify", "--quiet", `refs/heads/${TEAM_BRANCH}`]);
    const listed = git(team, ["ls-tree", "-r", "--name-only", head]);
    for (const path of listed === "" ? [] : listed.split("\n")) {
      const named = parseRecordPath(path);
      const key = `${node} ${path}`;
      if (!named || !components.has(named.component) || read.has(key)) continue;
      read.set(key, { node, path, head, content: blobOf(team, `${head}:${path}`) });
    }
    processed.set(node, head);
  }

  async function view(component: string): Promise<View | undefined> {
    if (!components.has(component)) return undefined;
    let base = copies.get(component);
    if (!base) {
      const copy = [...sites.values()].map((site) => site.repo(`copy-${component}`)).find((repo) => existsSync(repo));
      if (copy === undefined) throw new Error(`no node of the bench holds a copy of ${component}`);
      base = filesOf(copy, component);
      copies.set(component, base);
    }

    const valid: Published[] = [];
    const pending: View["pending"][number][] = [];
    const rejected: View["rejected"][number][] = [];
    for (const { node, path, head, content } of read.values()) {
      const named = parseRecordPath(path);
      if (named?.component !== component) continue;
      const verdict = await validateRecordFile(path, content);
      if (verdict.ok) valid.push({ node, repo: "team", commit: head, path, id: verdict.id, record: verdict.record });
      else rejected.push({ node, hash: await sha256Hex(content), type: named.type, reason: verdict.reason });
    }
    valid.sort(bySource);

    // A patch record is shown once its commit passed the patch checks against the lines its findings cite.
    const findings = new Map<string, Finding>(valid.filter((entry) => isOfType(entry, "finding")).map((entry) => [entry.id, entry.record]));
    const facts = new Map<Published, PatchFacts>();
    for (const entry of valid) {
      if (!isOfType(entry, "patch")) continue;
      const fork = sites.get(entry.node)?.repo(`fork-${component}`) ?? "";
      const cited = entry.record.findings.flatMap((id) => findings.get(id) ?? []);
      let patched: FileListing;
      try {
        patched = filesOf(fork, entry.record.commit);
      } catch {
        // The fork does not hold the commit yet.
        pending.push({ node: entry.node, hash: entry.id, type: "patch" });
        continue;
      }
      if (cited.length !== entry.record.findings.length) {
        pending.push({ node: entry.node, hash: entry.id, type: "patch" });
        continue;
      }
      for (const { blob } of [...base, ...patched]) if (!content.has(blob)) content.set(blob, blobOf(fork, blob));
      const verdict = await checkPatch({ base: { files: base, content }, patched: { files: patched, content }, cited: citedRanges(cited, base) });
      if (verdict.ok) facts.set(entry, verdict);
      else rejected.push({ node: entry.node, hash: entry.id, type: "patch", reason: verdict.reason });
    }
    const shown = valid.filter((entry) => !isOfType(entry, "patch") || facts.has(entry));

    const known = new Map<Sourced, Published>(shown.map((entry) => [entry, entry]));
    const entries = <R extends AnyRecord>(matched: readonly Sourced<R>[]): Published<R>[] => matched.flatMap((sourced) => (known.get(sourced) as Published<R> | undefined) ?? []);

    // A claim is closed once a finding or a patch of its own node cites it.
    const closed = new Set(shown.flatMap(({ node, record }) => ((record.type === "finding" || record.type === "patch") && record.claim !== undefined ? [`${node} ${record.claim}`] : [])));

    const identities = new Map<string, { readonly facts: PatchFacts; readonly records: Published<Patch>[] }>();
    for (const [entry, computed] of facts) {
      if (!isOfType(entry, "patch")) continue;
      const held = identities.get(computed.patchId);
      if (held) held.records.push(entry);
      else identities.set(computed.patchId, { facts: computed, records: [entry] });
    }
    const patches = [...identities].map(([patchId, { facts: computed, records }]) => {
      const authors = patchConfirmations(patchId, records.map(({ node }) => ({ node, patchId })), []);
      return {
        patchId,
        kind: computed.kind,
        size: computed.size,
        changes: computed.changes.map(({ blob, hunks }) => ({ blob, hunks: [...hunks] })),
        paths: [...computed.paths],
        records,
        rechecks: [],
        nodes: authors,
        confirmed: isConfirmed(authors),
      };
    });

    const byTree = new Map<string, Published<Recipe>[]>();
    for (const entry of shown) {
      if (!isOfType(entry, "recipe")) continue;
      byTree.set(entry.record.tree, [...(byTree.get(entry.record.tree) ?? []), entry]);
    }

    return {
      version: SCHEMA_VERSION,
      component,
      gitUrl: PLUGIN.url,
      state: "ready",
      viewVersion: read.size,
      lag: 0,
      organizations: nodes.length,
      nodes: nodes.map((node) => ({ node, ...(processed.has(node) ? { processed: processed.get(node) ?? "" } : {}), simulated: false, historyRewritten: false })),
      claims: shown.flatMap((entry) => (isOfType(entry, "claim") ? [{ ...entry, state: closed.has(`${entry.node} ${entry.id}`) ? ("closed" as const) : ("live" as const) }] : [])),
      findings: matchGroups(shown, base).map((group) => ({
        blob: group.blob,
        observation: group.observation,
        ...(group.host === undefined ? {} : { host: group.host }),
        paths: [...group.paths],
        findings: entries(group.findings),
        rechecks: entries(group.rechecks),
        counterFindings: entries(group.counterFindings),
        nodes: [...group.nodes],
        confirmed: group.confirmed,
        criteria: group.criteria.map((count) => ({ ...count, nodes: [...count.nodes] })),
      })),
      hosts: [],
      patches: patchGroups(patches).map((group) => ({ patches: group.sort((a, b) => compare(a.patchId, b.patchId)) })),
      recipes: [...byTree].map(([tree, records]) => ({ tree, records, nodes: [...new Set(records.map(({ node }) => node))].sort() })),
      pending,
      rejected,
    };
  }

  const answer = (body: object, status = 200): Response => Response.json({ version: SCHEMA_VERSION, ...body }, { status });
  const refuse = (error: string, status: number): Response => answer({ error }, status);

  async function respond(seen: Seen, path: string): Promise<Response> {
    const body = (seen.body ?? {}) as { readonly url?: string; readonly commit?: string; readonly node?: string };
    if (seen.method === "POST" && (path === "/nodes" || path === "/components")) {
      if (seen.headers.get(REGISTRATION_KEY_HEADER) !== keys.registration) return refuse("unauthorized", 401);
      if (path === "/nodes") {
        if (nodes.includes(body.url ?? "")) return refuse("already-registered", 409);
        nodes.push(body.url ?? "");
        return answer({ node: body.url });
      }
      components.add(body.commit ?? "");
      return answer({ component: body.commit, state: "ready" });
    }
    if (seen.method === "POST" && path === "/notices") {
      if (!nodes.includes(body.node ?? "")) return refuse("not-found", 404);
      sync(body.node ?? "");
      return answer({});
    }
    if (seen.method === "POST" && path === "/reset") {
      if (seen.headers.get(RESET_KEY_HEADER) !== keys.reset) return refuse("unauthorized", 401);
      read.clear();
      processed.clear();
      for (const node of nodes) sync(node);
      return answer({});
    }
    const viewed = /^\/components\/([0-9a-f]{40})\/view$/.exec(path);
    const built = seen.method === "GET" && viewed ? await view(viewed[1] ?? "") : undefined;
    return built ? Response.json(built) : refuse("not-found", 404);
  }

  on.respond = (seen) => {
    const url = new URL(seen.url);
    if (url.origin !== INDEX) return undefined;
    requests.push(seen);
    return respond(seen, url.pathname);
  };
  return { requests, held: () => read.size, view };
}
