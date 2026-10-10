// The page of one component commit (R14): what it shows after each read of the data
// endpoint (KTD14). Every function here is pure, so the tests call them with no browser:
// from the page's address to the view it reads, from an answer of the endpoint to what
// was read, and from that and what the page held to what it draws now.
//
// The page is drawn as a tree of elements. A value of the view is only ever a text of
// that tree, the target of a link, or part of the name that a finding's or a patch's
// entry is linked by. It is never an element, the name of an attribute or a class, and
// `poll.ts` sets a text as text. Each text is one value of the view or words of the
// page's own, so every one can be traced to a field of the endpoint (R13). The page says
// what the index holds, and tells a reader nothing to do (R35).
//
// The browser runs this file as it is built, with nothing bundled in, so it takes only
// types from the protocol library.

import type { Criterion, View } from "@cairnfield/protocol";

/** One element of the page. A child that is a string is a text. */
export interface Drawing {
  readonly tag: string;
  readonly attributes: { readonly [name: string]: string };
  readonly children: readonly (Drawing | string)[];
}

/** What the page at one address shows: a component, and the view of it that the page reads. */
export interface Place {
  readonly component: string;
  /** The path and query of the data endpoint. A `teams` query of the address is passed on (KTD38). */
  readonly viewPath: string;
  /** Whether the address narrows the view to the teams it lists. */
  readonly narrowed: boolean;
}

/** What one read of the endpoint gave: a view, word that the commit is not registered, or neither. */
export type Read = { readonly kind: "view"; readonly view: View } | { readonly kind: "unknown" } | { readonly kind: "failed" };

/** What the page holds between two reads. */
export interface Held {
  /** The version of the view the last read that worked gave, or `unknown` for a commit that is not registered, and when. Nothing before the first one. */
  readonly last?: { readonly version: number | "unknown"; readonly at: number };
  /** Whether the read after it failed. */
  readonly failed: boolean;
}

/** What the page holds before its first read. */
export const NOTHING_READ: Held = { failed: false };

/** What a read leaves on the page. */
export interface Drawn {
  readonly held: Held;
  /** The page again, only when what it shows changed (KTD11). With none, what is on screen stays. */
  readonly body?: Drawing;
  /** The line that says when the view was read, drawn after every read. */
  readonly status: Drawing;
}

type Child = Drawing | string | undefined | readonly Child[];

function flat(children: readonly Child[]): (Drawing | string)[] {
  const parts: (Drawing | string)[] = [];
  for (const child of children) {
    if (child === undefined) continue;
    if (typeof child === "string" || "tag" in child) parts.push(child);
    else parts.push(...flat(child));
  }
  return parts;
}

/** An element. The attributes are the page's own, apart from the target of a link. */
function el(tag: string, attributes: { readonly [name: string]: string }, ...children: readonly Child[]): Drawing {
  return { tag, attributes, children: flat(children) };
}

// The three ways the page writes a value down: as it is, an enumerated value in words,
// and a hash by its first characters.

/** An enumerated value of the protocol in words: its hyphens as spaces. */
const words = (value: string): string => value.replaceAll("-", " ");

/** A record ID or a patch ID is shown by this many of its first characters. A link carries the whole of it. */
const SHORT_HASH_LENGTH = 8;
const short = (hash: string): string => hash.slice(0, SHORT_HASH_LENGTH);

const code = (value: string): Drawing => el("code", {}, value);

/** A number of things, with the word for them. */
const counted = (count: number, one: string, many: string): [string, string] => [String(count), count === 1 ? one : many];

/** Whether a value is an HTTPS address. Every link out of the page is one (KTD14). */
function isHttps(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:";
}

/** An address from a registration: a link when it is HTTPS, and text when it is not. */
const address = (url: string): Drawing | string => (isHttps(url) ? el("a", { href: url }, url) : url);

// A page of the address `/components/<commit>`. The commit is in its full form, the only one a component has (R8).
const PAGE_PATH = /^\/components\/([0-9a-f]{40})$/;

/** What the page at an address shows, or nothing for an address that is no component's page. */
export function placeOf(pathname: string, search: string): Place | undefined {
  const component = PAGE_PATH.exec(pathname)?.[1];
  if (component === undefined) return undefined;
  // Only the teams are passed on. The endpoint refuses a query it does not know.
  const teams = new URLSearchParams(search).getAll("teams");
  const query = teams.map((team) => `teams=${encodeURIComponent(team)}`).join("&");
  return { component, narrowed: teams.length > 0, viewPath: `/components/${component}/view${query === "" ? "" : `?${query}`}` };
}

/** What a body of the endpoint says. A refusal is a code of the protocol, and `not-found` names a commit that is not registered. */
export function readOf(body: unknown): Read {
  if (typeof body !== "object" || body === null) return { kind: "failed" };
  if ("error" in body) return body.error === "not-found" ? { kind: "unknown" } : { kind: "failed" };
  return "viewVersion" in body ? { kind: "view", view: body as View } : { kind: "failed" };
}

// The criteria in the order of the protocol's list, weakest first. The object must name
// every one, so the type check fails when that list changes.
const IN_ORDER: { readonly [C in Criterion]: true } = { "safe-to-read": true, "safe-to-run-sandboxed": true, "safe-to-run-with-access": true, "works-as-documented": true };
const CRITERIA = Object.keys(IN_ORDER) as Criterion[];

type FindingGroup = View["findings"][number];
type FindingEntry = FindingGroup["findings"][number];
type PatchEntry = View["patches"][number]["patches"][number];
/** A file and the lines cited in it. */
interface Cited {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** The distinct members of a list, in the order they first come. */
function distinct<T, K>(all: readonly T[], key: (member: T) => K): T[] {
  const seen = new Set<K>();
  return all.filter((member) => {
    const named = key(member);
    if (seen.has(named)) return false;
    seen.add(named);
    return true;
  });
}

/** What the page reads from a view more than once: each node's tone, and each finding by its ID. */
interface Reading {
  readonly view: View;
  /** A node's place among the nodes of the view, which gives it one of four tones. The tone tells teams apart and says nothing else. */
  readonly tones: ReadonlyMap<string, number>;
  readonly findings: ReadonlyMap<string, FindingGroup>;
}

const TONES = 4;

function readingOf(view: View): Reading {
  return {
    view,
    tones: new Map(view.nodes.map(({ node }, at) => [node, at % TONES])),
    findings: new Map(view.findings.flatMap((group) => group.findings.map(({ id }) => [id, group]))),
  };
}

const toneOf = (reading: Reading, node: string): string => {
  const tone = reading.tones.get(node);
  return tone === undefined ? "" : ` tone-${tone}`;
};

/** A contributor: the node's base URL, which is its identity (KTD8, KTD38). */
const organization = (reading: Reading, node: string): Drawing => el("span", { class: `org${toneOf(reading, node)}` }, address(node));

const organizations = (reading: Reading, nodes: readonly string[]): Drawing => el("div", { class: "by" }, nodes.map((node) => organization(reading, node)));

/** One stone for each organization behind an entry. Decoration: the label beside it says the same. */
const cairn = (reading: Reading, nodes: readonly string[]): Drawing =>
  el("span", { class: "cairn", "aria-hidden": "true" }, nodes.map((node) => el("span", { class: `stone${toneOf(reading, node)}` })));

/** Two organizations make a finding or a patch confirmed (R10, R24). The view says whether, and the page says so in words. */
const confirmation = (confirmed: boolean, nodes: readonly string[]): Drawing =>
  confirmed ? el("span", { class: "tag ok" }, "confirmed by ", String(nodes.length)) : el("span", { class: "tag un" }, "unconfirmed");

/** A path with the line or lines cited in it. */
const where = ({ path, start, end }: Cited): (Drawing | string)[] => [code(path), el("span", { class: "lines" }, start === end ? ["line ", String(start)] : ["lines ", String(start), "–", String(end)])];

/** A link to a finding's entry on the page, by what the finding observed. A finding the view does not hold is named by its ID. */
function findingLink(reading: Reading, id: string): Drawing {
  const group = reading.findings.get(id);
  return group === undefined ? el("span", { class: "ref" }, "finding ", code(short(id))) : el("a", { href: `#finding-${id}` }, words(group.observation));
}

function section(id: string, title: string, ...children: readonly Child[]): Drawing {
  return el("section", { id }, el("h2", {}, title), children);
}

const empty = (label: string): Drawing => el("p", { class: "empty" }, label);

/** A record the page shows by its node, its type and its hash alone: pending work and rejected work (KTD31). */
const row = (reading: Reading, { node, type, hash }: { readonly node: string; readonly type: string; readonly hash: string }, tag: Drawing): Drawing =>
  el("li", { class: "row" }, organization(reading, node), el("span", { class: "kind" }, type), code(short(hash)), tag);

function header(view: View): Drawing {
  const patches = view.patches.reduce((count, group) => count + group.patches.length, 0);
  const count = ([number, word]: [string, string]): Drawing => el("div", {}, el("dt", {}, word), el("dd", {}, number));
  return el(
    "header",
    { class: "head" },
    el("div", {}, el("p", { class: "label" }, "Component"), el("h1", {}, address(view.gitUrl)), el("p", { class: "commit" }, "commit ", code(view.component))),
    el(
      "dl",
      { class: "counts" },
      count(counted(view.organizations, "organization", "organizations")),
      count(counted(view.findings.length, "finding", "findings")),
      count(counted(patches, "patch", "patches")),
    ),
  );
}

/** The page shows only live claims (R15). A closed or expired claim keeps its state in the endpoint (KTD15). */
function claims(reading: Reading): Drawing {
  const live = reading.view.claims.filter(({ state }) => state === "live");
  if (live.length === 0) return section("claims", "Live claims", empty("No live claims"));
  const shown = live.map(({ node, record, state }) =>
    el(
      "li",
      { class: "claim" },
      organization(reading, node),
      el("span", { class: "kind" }, record.kind),
      // A review claim names its kind of check and no file. A patch claim names the findings it is for.
      record.check === undefined ? undefined : code(record.check),
      record.intent === undefined ? undefined : el("span", { class: "intent" }, words(record.intent)),
      (record.findings ?? []).map((id) => findingLink(reading, id)),
      el("span", { class: "tag live" }, state),
    ),
  );
  return section("claims", "Live claims", el("span", { class: "count" }, String(live.length), " live"), el("ul", { class: "chips" }, shown));
}

function pending(reading: Reading): Drawing | undefined {
  const waiting = reading.view.pending;
  if (waiting.length === 0) return undefined;
  return section("pending", "Being checked", el("ul", { class: "rows" }, waiting.map((record) => row(reading, record, el("span", { class: "tag un" }, "pending")))));
}

/**
 * A group of matching findings, under one criterion that its findings name. The
 * organizations and the label are those of that criterion: which criterion a content
 * breaks is a judgment, so each criterion is confirmed apart (R10).
 */
function finding(reading: Reading, group: FindingGroup, criterion: Criterion, named: readonly FindingEntry[]): Drawing {
  const count = group.criteria.find((held) => held.criterion === criterion);
  const behind = count?.nodes ?? [];
  const ids = new Set(named.map(({ id }) => id));
  const disputes = group.counterFindings.filter(({ record }) => ids.has(record.finding));
  return el(
    "li",
    { class: "finding" },
    cairn(reading, behind),
    el(
      "div",
      { class: "what" },
      el("strong", {}, words(group.observation)),
      group.host === undefined ? undefined : el("code", { class: "host" }, group.host),
      // Two nodes that publish the same record give one ID, which is one target on the page.
      el(
        "ul",
        { class: "where" },
        distinct(named, ({ id }) => id).map(({ id, record }) =>
          el(
            "li",
            { id: `finding-${id}` },
            where(record.location),
            record.contradicts === undefined ? undefined : el("span", { class: "contradicts" }, "contradicts ", where(record.contradicts)),
            el("span", { class: "ref" }, "finding ", code(short(id))),
          ),
        ),
      ),
      organizations(reading, behind),
    ),
    confirmation(count?.confirmed ?? false, behind),
    // A dispute sits beside the finding it names. It hides nothing and changes no count.
    disputes.length === 0
      ? undefined
      : el(
          "ul",
          { class: "disputes" },
          disputes.map(({ node, record }) =>
            el(
              "li",
              { class: "dispute" },
              organization(reading, node),
              el("span", {}, "disputes this: ", words(record.reason)),
              record.cites === undefined ? undefined : el("span", { class: "cites" }, "citing ", where(record.cites)),
            ),
          ),
        ),
  );
}

function findings(reading: Reading): Drawing {
  const groups = reading.view.findings;
  // An empty list is no all-clear, and the page never calls a version safe (R14).
  if (groups.length === 0) return section("findings", "Findings", empty("No findings published"), el("p", { class: "note" }, "This is not a statement that the version is safe."));
  const byCriterion = CRITERIA.flatMap((criterion) => {
    const entries = groups.flatMap((group) => {
      const named = group.findings.filter(({ record }) => record.criterion === criterion);
      return named.length === 0 ? [] : [finding(reading, group, criterion, named)];
    });
    return entries.length === 0 ? [] : [el("h3", {}, "Counts against ", code(criterion)), el("ul", { class: "findings" }, entries)];
  });
  return section("findings", "Findings", byCriterion);
}

/** One patch identity: a column of its group. Identical patches are one entry that lists its organizations (R16). */
function patch(reading: Reading, entry: PatchEntry): Drawing {
  // The organizations that wrote it, in the order of their addresses, so an entry reads the same after every read.
  const authors = [...new Set(entry.records.map(({ node }) => node))].sort();
  const named = [...new Set(entry.records.flatMap(({ record }) => record.findings))];
  return el(
    "article",
    { class: "patch", id: `patch-${entry.patchId}` },
    organizations(reading, authors),
    el("div", { class: "tags" }, el("span", { class: "tag" }, words(entry.kind)), confirmation(entry.confirmed, entry.nodes)),
    // The paths it changes, and its changed lines in each content: where, how many it takes out and how many it puts in.
    el("div", { class: "paths" }, entry.paths.map(code)),
    el(
      "ul",
      { class: "changes" },
      entry.changes.flatMap(({ hunks }) =>
        hunks.map(({ oldStart, removed, added }) =>
          el("li", {}, el("span", { class: "lines" }, "line ", String(oldStart)), el("span", { class: "removed" }, "−", String(removed)), el("span", { class: "added" }, "+", String(added))),
        ),
      ),
    ),
    entry.rechecks.length === 0
      ? undefined
      : el(
          "ul",
          { class: "rechecks" },
          entry.rechecks.map(({ node, record }) => el("li", { class: "recheck" }, organization(reading, node), el("span", {}, "re-check: ", words(record.verdict)))),
        ),
    el("div", { class: "foot" }, el("span", { class: "ref" }, "patch ", code(short(entry.patchId))), named.map((id) => el("span", {}, "for ", findingLink(reading, id)))),
  );
}

/** Patches whose changed lines overlap or adjoin stand side by side, one column each (R16). */
function patches(reading: Reading): Drawing {
  const groups = reading.view.patches;
  if (groups.length === 0) return section("patches", "Patches", empty("No patches published"));
  return section(
    "patches",
    "Patches",
    groups.map((group) =>
      el(
        "div",
        { class: "group" },
        el(
          "div",
          { class: "group-head" },
          el("span", { class: "paths" }, [...new Set(group.patches.flatMap(({ paths }) => paths))].map(code)),
          el("span", { class: "count" }, counted(group.patches.length, " patch", " patches side by side")),
        ),
        el("div", { class: "cols" }, group.patches.map((entry) => patch(reading, entry))),
      ),
    ),
  );
}

/** A patch of a recipe: a link to its entry when the view shows that patch. */
function patchLink(reading: Reading, id: string): Drawing {
  const shown = reading.view.patches.some((group) => group.patches.some(({ patchId }) => patchId === id));
  const label = ["patch ", code(short(id))];
  return shown ? el("a", { href: `#patch-${id}` }, label) : el("span", { class: "ref" }, label);
}

/** Each distinct file tree and the organizations that published it. The tree hash is published, not checked (KTD5). */
function recipes(reading: Reading): Drawing {
  const published = reading.view.recipes;
  if (published.length === 0) return section("recipes", "Recipes", empty("No recipes published"));
  const shown = published.map(({ tree, records, nodes }) =>
    el(
      "li",
      { class: "recipe" },
      el("div", { class: "used" }, el("b", {}, String(nodes.length)), nodes.length === 1 ? " organization published this copy" : " organizations published this copy"),
      el("div", { class: "tree" }, "tree ", code(tree), el("span", { class: "tag un" }, "published, not checked")),
      organizations(reading, nodes),
      el("ul", { class: "taken" }, [...new Set(records.flatMap(({ record }) => record.patches))].map((id) => el("li", {}, patchLink(reading, id)))),
    ),
  );
  return section("recipes", "Recipes", el("ul", { class: "recipes" }, shown));
}

/** Rejected work is its contributor, its type, its hash and its reason, and nothing more (KTD31). */
function rejected(reading: Reading): Drawing | undefined {
  const refused = reading.view.rejected;
  if (refused.length === 0) return undefined;
  return section("rejected", "Rejected work", el("ul", { class: "rows" }, refused.map((record) => row(reading, record, el("span", { class: "tag rej" }, words(record.reason))))));
}

/** The label of a component whose copy the index does not hold yet, or never will. */
const NOT_READY = { importing: "The index is still importing this version", failed: "The index could not import this version" } as const;

/** The page of a registered component. */
function viewed(place: Place, view: View): Drawing {
  const reading = readingOf(view);
  const narrowed = place.narrowed
    ? el(
        "div",
        { id: "narrowed", class: "notice" },
        el("strong", {}, "Narrowed view"),
        el("span", {}, "Only the work of the listed organizations is shown and counted."),
        organizations(reading, view.nodes.map(({ node }) => node)),
      )
    : undefined;
  // Until the index holds its own copy it has checked nothing against it, so the page shows no section of checked work.
  const work =
    view.state === "ready"
      ? el("div", { class: "work" }, el("div", { class: "part" }, claims(reading), pending(reading), findings(reading)), el("div", { class: "part" }, patches(reading), recipes(reading), rejected(reading)))
      : [el("section", { id: "state" }, el("h2", {}, NOT_READY[view.state]), el("span", { class: view.state === "failed" ? "tag rej" : "tag un" }, view.state)), pending(reading), rejected(reading)];
  return el("div", { class: "view" }, narrowed, header(view), work);
}

/** The page of a commit that is not registered, in the origin's words. The commit is the one the address names. */
function unregistered(place: Place): Drawing {
  return el("div", { class: "view" }, el("section", { id: "state" }, el("h2", {}, "No reviews published for this version"), el("p", { class: "commit" }, "commit ", code(place.component))));
}

/** A time of the page's own clock, in UTC, so it reads the same wherever the page is open. */
function time(at: number): Drawing {
  const iso = new Date(at).toISOString();
  return el("time", { datetime: iso }, `${iso.slice(11, 19)} UTC`);
}

function status(held: Held): Drawing {
  if (held.last === undefined) return el("p", { id: "status", class: "status stale" }, "The index could not be read.");
  if (held.failed) return el("p", { id: "status", class: "status stale" }, "The last read of the index failed. This page shows what was read at ", time(held.last.at), ".");
  return el("p", { id: "status", class: "status" }, "Read at ", time(held.last.at));
}

/**
 * What the page shows after one read. A read that failed leaves what is on screen and
 * says when that was read. A view is drawn again only when its version changed (KTD11):
 * the version moves with every change the view can show, a claim that passes its time
 * included.
 */
export function draw(place: Place, held: Held, read: Read, now: number): Drawn {
  if (read.kind === "failed") {
    const after: Held = { ...held, failed: true };
    return { held: after, status: status(after) };
  }
  const version = read.kind === "view" ? read.view.viewVersion : "unknown";
  const after: Held = { last: { version, at: now }, failed: false };
  if (held.last !== undefined && held.last.version === version) return { held: after, status: status(after) };
  return { held: after, status: status(after), body: read.kind === "view" ? viewed(place, read.view) : unregistered(place) };
}
