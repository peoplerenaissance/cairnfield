// What the assembly tests share: a small component with one content at two paths, teams
// that hold patches made by hand, and the view an index would serve for them. Every
// patch here is a commit in a fork and a record in a team repo, as `patch` leaves them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION, recordPath } from "@cairnfield/protocol";
import type { AnyRecord } from "@cairnfield/protocol";
import { EXIT } from "../../src/outcome.ts";
import { INDEX, NODE, OTHER_NODE, THIRD_NODE, finding, forkCommit, git, holdRecords, patchIdOf, pinTree } from "../support.ts";
import type { Bench, Change, Entry, Site } from "../support.ts";

export const OTHER_NAMESPACE = "cairnfield-team-b";
const THIRD_NAMESPACE = "cairnfield-team-c";

export const RULES = ["allow read notes", "allow write notes", "allow fetch *", "allow run sync", "allow read env"];
export const text = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join("");

/** The rules file sits at two paths with one content, and the script may be run. */
export const TREE: readonly Entry[] = [
  { path: "config/rules.txt", content: text(RULES) },
  { path: "docs/rules.txt", content: text(RULES) },
  { path: "notes.md", content: "# Notes\n\nNothing here.\n" },
  { path: "run.sh", content: "#!/bin/sh\nexec sync\n", mode: "100755" },
];

/** The rules with some lines replaced. A line given as nothing is left out. */
export function rules(replaced: { readonly [line: number]: string | readonly string[] | undefined }): string {
  return text(RULES.flatMap((line, at) => (Object.hasOwn(replaced, at + 1) ? (replaced[at + 1] ?? []) : line)));
}

/** The rules with the third narrowed to one host: a change of one line. */
export const NARROWED = rules({ 3: "allow fetch notes.fellbeck.example" });

/** Both paths of the rules file, with new content. A patch must rewrite every copy (R24). */
export const bothRules = (content: string): Change[] => [
  { path: "config/rules.txt", content },
  { path: "docs/rules.txt", content },
];

export interface Lens {
  readonly patchLevel: number;
  readonly teams?: readonly string[];
  readonly patchKinds?: readonly string[];
  readonly publishRecipes?: boolean;
}

/** Writes the team's lens file. A lens here takes both kinds and publishes nothing, unless it says otherwise. */
export function useLens(on: Bench, lens: Lens, index = lens.patchLevel === 2): void {
  mkdirSync(join(on.home, "lenses"), { recursive: true });
  writeFileSync(
    join(on.home, "lenses/lens.json"),
    JSON.stringify({ teams: [], patchKinds: ["removes-only", "adds-or-changes"], publishRecipes: false, ...lens }),
  );
  on.configure({ node: NODE, lens: "lenses/lens.json", ...(index ? { index: INDEX } : {}) });
}

/** Pins the small component with a lens. Returns the pinned commit. */
export async function pinnedWith(on: Bench, lens: Lens, tree: readonly Entry[] = TREE): Promise<string> {
  useLens(on, lens);
  const { commit, outcome } = await pinTree(on, tree);
  if (outcome.code !== EXIT.ok) throw new Error(`the pin failed: ${JSON.stringify(outcome.output)}`);
  return commit;
}

/** A patch made by hand: where it is, and what an honest index would say of it. */
export interface Made {
  readonly node: string;
  readonly commit: string;
  readonly patchId: string;
  /** The patch record and its ID. */
  readonly record: object;
  readonly id: string;
}

export interface Wanted {
  /** The lines that the patch's findings cite, one finding for each range. */
  readonly cites: readonly (readonly [start: number, end: number])[];
  /** The file those lines are in, when it is not `config/rules.txt`. */
  readonly path?: string;
  readonly changes: readonly Change[];
  /** The commit the patch commit sits on, when it is not the component. */
  readonly parent?: string;
  /** The team whose repo holds the findings, when it is not the team that wrote the patch. */
  readonly findingsAt?: Site;
}

/**
 * Has a team publish findings and a patch for them: the findings and the patch record go
 * to its team repo, and the patch commit to its fork.
 */
export async function patchBy(on: Bench, at: Site, node: string, component: string, wanted: Wanted): Promise<Made> {
  const findings = wanted.cites.map(([start, end]) => finding(component, { location: { path: wanted.path ?? "config/rules.txt", start, end } }));
  const cited = await holdRecords(wanted.findingsAt ?? at, findings);
  const commit = forkCommit(at, on.repo(`copy-${component}`), component, wanted.changes, wanted.parent);
  const record = { version: SCHEMA_VERSION, type: "patch", component, commit, findings: [...cited].sort(), model: "none" };
  const [id = ""] = await holdRecords(at, [record]);
  return { node, commit, patchId: await patchIdOf(at.repo(`fork-${component}`), component, commit), record, id };
}

/** A patch of the team's own. */
export const ownPatch = (on: Bench, component: string, wanted: Wanted): Promise<Made> => patchBy(on, on, NODE, component, wanted);

/** The node of the second team, which a lens may name. */
export const otherTeam = (on: Bench): Site => on.another(OTHER_NODE, OTHER_NAMESPACE);
/** The node of a third team, which no lens here names. */
export const thirdTeam = (on: Bench): Site => on.another(THIRD_NODE, THIRD_NAMESPACE);

/** A patch as an index lists it. An honest index gives the patch ID the commit amounts to, and the record as its node holds it. */
export interface Listed extends Made {
  /** The patch ID the index gives in place of the true one. */
  readonly says?: string;
  /** What the index shows as the record, in place of what the node holds under that ID. */
  readonly shows?: object;
}

/** The view an index serves for a component: each patch as one entry. */
export function serveView(on: Bench, component: string, listed: readonly Listed[]): void {
  const nodes = [...new Set([NODE, ...listed.map(({ node }) => node)])];
  on.index.views.set(component, {
    version: SCHEMA_VERSION,
    component,
    state: "ready",
    viewVersion: 1,
    lag: 0,
    organizations: nodes.length,
    nodes: nodes.map((node) => ({ node, simulated: false, historyRewritten: false })),
    claims: [],
    findings: [],
    hosts: [],
    patches: listed.map((made) => ({
      patches: [
        {
          patchId: made.says ?? made.patchId,
          kind: "adds-or-changes",
          size: 2,
          changes: [],
          paths: ["config/rules.txt", "docs/rules.txt"],
          records: [
            { node: made.node, repo: "team", commit: component, path: recordPath(made.record as AnyRecord, made.id), id: made.id, record: made.shows ?? made.record },
          ],
          rechecks: [],
          nodes: [made.node],
          confirmed: false,
        },
      ],
    })),
    recipes: [],
    pending: [],
    rejected: [],
  });
}

export const COPIES = ".cairnfield/copies";

/** A file of the copy the command built. */
export const copied = (on: Bench, component: string, path: string): string => readFileSync(join(on.home, COPIES, component, path), "utf8");

/** Each ref of a repo with the commit it points to. */
export function refsOf(repo: string): string[] {
  const listed = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  return listed === "" ? [] : listed.split("\n");
}

/** What the command printed for the operator. */
export const printed = (on: Bench): string => on.warnings.join("");
