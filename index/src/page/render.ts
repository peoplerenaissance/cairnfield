// The index's two pages (R14): its own, which lists its components, and the page of one
// component commit. This file holds what each shows after a read of its data endpoint
// (KTD14). Every function here is pure, so the tests call them with no browser: from the
// page's address to what it reads there, from an answer of the endpoint to what was read,
// and from that and what the page held to what it draws now.
//
// A page is drawn as a tree of elements. A value of the view or of the list is only ever
// a text of that tree, the target of a link, the commit in the address of a component's
// page on this index, or part of the name that a finding's or a patch's entry is linked
// by. It is never an element, the name of an attribute or a class, and `poll.ts` sets a
// text as text. Each text is one value of the endpoint or words of the page's own, so
// every one can be traced to a field of the endpoint (R13). A page says what the index
// holds, and tells a reader nothing to do (R35).
//
// The page's own words say what a thing is to a reader who has not met the protocol:
// what each section holds, what a finding says of the component, what a criterion
// promises and what a label means. Each is keyed by a value of a closed list, and the
// type check fails when a list gains a value that has no words here. The one address the
// page holds that no record names is where the protocol defines those lists.
//
// The words and links that a page holds whatever was read are not drawn here. They are
// written in the page's HTML file, outside the element this drawing goes into.
//
// The browser runs this file as it is built, with nothing bundled in, so it takes only
// types from the protocol library.

import type { COMPONENT_LIST, Criterion, Infer, Observation, PatchKind, RejectionReason, View } from "@cairnfield/protocol";

/** The list of an index's components, as the index serves it. */
type ComponentList = Infer<typeof COMPONENT_LIST>;

/** One element of the page. A child that is a string is a text. */
export interface Drawing {
  readonly tag: string;
  readonly attributes: { readonly [name: string]: string };
  readonly children: readonly (Drawing | string)[];
}

/** The page of a component: the component, and the view of it that the page reads. */
interface ComponentPlace {
  readonly kind: "component";
  readonly component: string;
  /** The path and query of the data endpoint. A `teams` query of the address is passed on (KTD38). */
  readonly viewPath: string;
  /** Whether the address narrows the view to the teams it lists. */
  readonly narrowed: boolean;
}

/** The index's own page, which reads the list of the index's components. */
interface IndexPlace {
  readonly kind: "index";
  /** The path of the list. It takes no query, so nothing of the address is passed on. */
  readonly viewPath: string;
  /** The Git URL of the one repo whose versions the address asks for. With none, the page lists every component. The page narrows the list itself. */
  readonly repo?: string;
}

/** What the page at one address shows, and the data endpoint it reads there. */
export type Place = IndexPlace | ComponentPlace;

/** What one read of the endpoint gave: a view, the list of the index's components, word that the commit is not registered, word that the index does not take the teams of the address, or none of them. */
export type Read =
  | { readonly kind: "view"; readonly view: View }
  | { readonly kind: "list"; readonly list: ComponentList }
  | { readonly kind: "unknown" }
  | { readonly kind: "refused" }
  | { readonly kind: "failed" };

/** What the page holds between two reads. */
export interface Held {
  /** What the last read that worked gave, and when: the version of a view, the list as one text, `unknown` for a commit that is not registered or `refused` for teams the index does not take. Nothing before the first one. */
  readonly last?: { readonly version: number | string; readonly at: number };
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

/** Whether a value is an HTTPS address. Every link that leaves the index is one (KTD14). */
function isHttps(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:";
}

/** An address from a registration: a link when it is HTTPS, and text when it is not. */
const address = (url: string): Drawing | string => (isHttps(url) ? el("a", { href: url }, url) : url);

// A page of the address `/components/<commit>`. The commit is in its full form, the only one a component has (R8).
const PAGE_PATH = /^\/components\/([0-9a-f]{40})$/;

/** What the page at an address shows, or nothing for an address where no page stands. */
export function placeOf(pathname: string, search: string): Place | undefined {
  // The index's own page. The list refuses every query, so none is passed on. A `repo` in the address narrows what the page draws of the list.
  if (pathname === "/") {
    const repo = new URLSearchParams(search).get("repo");
    return repo === null ? { kind: "index", viewPath: "/view" } : { kind: "index", viewPath: "/view", repo };
  }
  const component = PAGE_PATH.exec(pathname)?.[1];
  if (component === undefined) return undefined;
  // Only the teams are passed on. The endpoint refuses a query it does not know.
  const teams = new URLSearchParams(search).getAll("teams");
  const query = teams.map((team) => `teams=${encodeURIComponent(team)}`).join("&");
  return { kind: "component", component, narrowed: teams.length > 0, viewPath: `/components/${component}/view${query === "" ? "" : `?${query}`}` };
}

/**
 * What a body of the endpoint says. A refusal is a code of the protocol. `not-found`
 * names a commit that is not registered. `bad-request` names a query the endpoint does
 * not take, and the page passes on only the teams of its address (KTD38). A refusal with
 * any other code says nothing the page can show. Any other body is told by its shape: a
 * view carries its version, and the list carries the components.
 */
export function readOf(body: unknown): Read {
  if (typeof body !== "object" || body === null) return { kind: "failed" };
  if ("error" in body) {
    if (body.error === "not-found") return { kind: "unknown" };
    return body.error === "bad-request" ? { kind: "refused" } : { kind: "failed" };
  }
  if ("viewVersion" in body) return { kind: "view", view: body as View };
  return "components" in body ? { kind: "list", list: body as ComponentList } : { kind: "failed" };
}

// The criteria in the order of the protocol's list, and what each promises. The first
// three are in order: a component that breaks one breaks each later one too, so the most
// basic promise comes first. The object must name every one, so the type check fails
// when that list changes.
const PROMISE: { readonly [C in Criterion]: string } = {
  "safe-to-read": "The promise that loading the component's text into an agent's context is safe.",
  "safe-to-run-sandboxed": "The promise that running the component with no credentials and no network access is safe.",
  "safe-to-run-with-access": "The promise that running the component with the permissions and network access it asks for is safe.",
  "works-as-documented": "The promise that the component does what its documentation says.",
};
const CRITERIA = Object.keys(PROMISE) as Criterion[];

/** Where the protocol defines the criteria and the observations. No record names this address: it is the page's own. */
const DEFINED_AT = "https://github.com/peoplerenaissance/cairnfield/blob/main/reference/protocol.md#criteria-and-observations";
const DEFINED = "The protocol defines each criterion. This label leads to that definition.";

/**
 * What a finding says of the component, by its observation: one sentence, in the words
 * before its host and the words after it. An observation that names no host has all its
 * words before. The sentence is the finding's, and the line under it names who reports it.
 */
const SAYS: { readonly [O in Observation]: readonly [before: string, after: string] } = {
  "sends-data-to-host": ["This component sends data to ", "."],
  "fetches-instructions-from-host": ["This component fetches instructions for an agent from ", "."],
  "loads-resource-from-host": ["This component loads code or another resource from ", "."],
  "network-access-any-host": ["This component allows network access to any host.", ""],
  "environment-access-all-variables": ["This component allows access to every environment variable.", ""],
  "reads-outside-workspace": ["This component reads files outside the workspace.", ""],
  "writes-outside-workspace": ["This component writes files outside the workspace.", ""],
  "runs-shell-command": ["This component runs a shell command.", ""],
  "runs-with-permissions-bypassed": ["This component runs something with permission checks switched off.", ""],
  "runs-install-script": ["This component runs a script when it is installed.", ""],
  "hidden-instruction": ["This component contains a hidden instruction for an agent.", ""],
  "overrides-host-instructions": ["This component tells an agent to set aside the instructions of its host or its user.", ""],
  "requests-broad-credential-scope": ["This component asks for a credential that reaches more than its documented feature needs.", ""],
  "stores-credential-in-plain-text": ["This component stores a credential in plain text.", ""],
  "installs-unpinned-dependency": ["This component installs a dependency with no pinned version.", ""],
  "documented-control-not-read": ["This component acts without reading a setting that its documentation says controls it.", ""],
  "fails-on-documented-input": ["This component fails on an input that its documentation says works.", ""],
};

/** What a finding says, as one sentence with its host in place. An observation that this page has no sentence for stands in the protocol's own words. */
function said({ observation, host }: { readonly observation: Observation; readonly host?: string | undefined }): (Drawing | string)[] {
  const named = host === undefined ? [] : [el("code", { class: "host" }, host)];
  const sentence: readonly [string, string] | undefined = SAYS[observation];
  return sentence === undefined ? [words(observation), ...named] : [sentence[0], ...named, sentence[1]].filter((part) => part !== "");
}

/**
 * What each section of a component's page holds, in plain words under its heading: what
 * the thing is, and what stands first where the section is ordered. None tells a reader
 * to do something (R35).
 */
const ABOUT = {
  claims: "A claim is a team's notice that it has started a review or a fix. It stays live until that team publishes the result or the claim runs out.",
  pending: "These records have reached the index, which has not finished checking them. Nothing here counts until it has.",
  findings: "A finding is something a team's review reports seeing in this version, at the lines it names. It is that team's report, and no verdict of this index. The ones more organizations report stand first, and two organizations make a finding confirmed.",
  patches: "A patch is a fix one team wrote for a finding, and it changes only the lines that finding names. Patches for the same lines stand side by side, the ones more organizations stand behind first.",
  recipes: "A recipe records the copy a team built for itself: the patches it took and the hash of the files that came out. The copies more organizations published come first.",
  rejected: "The index refused these records, because each failed one of its checks. A refused record counts for nothing on this page.",
} as const;

/** What the two words at the head of a component's page mean. */
const COMPONENT = "A component is one version of an AI tool, such as a plugin, a skill or a server: its Git repository at one commit.";
const ORGANIZATIONS = "The teams with records on this version. A team is counted by the address of its node, and nothing more is proven about who runs it. Each has a stone of its own color, which tells the teams apart and says nothing else.";
const CAIRN = "One stone for each organization that reports this finding, in that organization's color.";

/** What "confirmed" and "unconfirmed" mean on a finding and on a patch (R10, R24). */
const CONFIRMATION = {
  finding: {
    confirmed: "Two or more organizations report this or have re-checked it, and their reports count against this criterion.",
    unconfirmed: "Fewer than two organizations report this against this criterion. Two make it confirmed.",
  },
  patch: {
    confirmed: "Two or more organizations stand behind this patch. Each wrote the same patch, or re-checked it and found that it resolves its finding.",
    unconfirmed: "Fewer than two organizations stand behind this patch. An organization stands behind a patch by writing the same one, or by re-checking it and finding that it resolves its finding.",
  },
} as const;

/** What each kind of patch is. The index works the kind out from the commit. */
const KIND: { readonly [K in PatchKind]: string } = {
  "removes-only": "This patch only takes lines out. It adds no line and changes no file's mode.",
  "adds-or-changes": "This patch adds or rewrites lines, or changes a file's mode.",
};

const PENDING = "The index has this record and has not finished checking it.";
const NOT_CHECKED = "The team published this hash of its copy's files. The index has not built the copy, so it has not checked the hash.";
/** What "declared" means before the model of a patch record: the team states the value, and no check of the index reaches it (R14). */
const DECLARED = "This team's record states which model, if any, wrote the patch. The index cannot check that, and has not.";

/** Why the index refuses a record, by the reason it stores (KTD31). Each says what the check found. */
const REFUSED: { readonly [R in RejectionReason]: string } = {
  "unknown-field": "The record holds a field its type does not have, or its file is not written exactly as a record is.",
  "unknown-value": "The record holds a value outside the protocol's lists and forms, or lacks a field it needs.",
  "too-large": "The record, a list in it, or content it points at is larger than the protocol allows.",
  "bad-path": "The record cites a path that breaks the path rule, or that is no regular file in the index's copy.",
  "lines-out-of-range": "The record cites lines that its file does not have.",
  "host-not-in-lines": "The finding names a host that does not stand in the lines it cites.",
  "hash-mismatch": "The record's file is not named by the hash of its content, or sits under another component or type.",
  "unsupported-version": "The record is of a protocol version that this index does not read.",
  "unknown-component": "The index could not import this version, so it could check no record of it.",
  "unresolved-reference": "The record names another record that could not be found.",
  "patch-out-of-scope": "The patch adds a file, changes content that its findings do not cite, or changes lines outside the ones they cite.",
  "patch-too-large": "The patch makes more than 3 replacements, changes more than 60 lines or adds more than 8 KB.",
  "wrong-parent": "The patch commit is not built on the pinned commit.",
  "blob-mismatch": "Content that the node served for the patch does not match its hash.",
  "bad-mode": "The patch changes something that is not a regular file, such as a link.",
  "patch-incomplete": "The patch changes nothing, leaves an identical copy of the content it replaces as it was, or rewrites two such copies differently.",
};

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
  /** A node's place among the nodes of the view, which gives it one of four tones. The tone tells teams apart and says nothing else: it colors the team's stones, and never its name. */
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

/**
 * A label with what it means. The meaning is the next text of the page, so every reader
 * gets it. The stylesheet shows it under the label only while the label is pointed at or
 * focused, and a label can be focused, so it shows for a reader with a keyboard as for
 * one with a pointer. `end` is for a label that stands at the end of its row. A value
 * that this page has no words for stands as its label alone.
 */
const explained = (label: Drawing, means: string | undefined, end = false): Drawing =>
  means === undefined ? label : el("span", { class: end ? "explained end" : "explained" }, label, el("span", { class: "tip" }, means));

/** A label that can be focused: a status label by its class, or a plain word with none. */
const focusable = (kind: string, ...text: readonly Child[]): Drawing => el("span", kind === "" ? { tabindex: "0" } : { class: kind, tabindex: "0" }, text);

/**
 * A contributor: the node's base URL, which is its identity (KTD8, KTD38). An HTTPS
 * address is shown without the scheme that every such address has, and its link carries
 * the whole of it. An address that is not HTTPS is no link, and is shown whole, so it
 * never reads as the HTTPS address of the same host.
 */
const organization = (reading: Reading, node: string): Drawing => el("span", { class: `org${toneOf(reading, node)}` }, isHttps(node) ? el("a", { href: node }, node.replace(/^https:\/\//i, "")) : node);

/** Organizations in a row, after the word for what they did where the row has one. */
const organizations = (reading: Reading, nodes: readonly string[], did?: string): Drawing =>
  did === undefined
    ? el("div", { class: "by" }, nodes.map((node) => organization(reading, node)))
    : el("div", { class: "by" }, el("span", { class: "did" }, did), el("span", { class: "orgs" }, nodes.map((node) => organization(reading, node))));

/** One stone for each organization behind an entry, with what the stones are. Decoration: the label beside it says the same. */
const cairn = (reading: Reading, nodes: readonly string[]): Drawing =>
  explained(el("span", { class: "cairn", "aria-hidden": "true" }, nodes.map((node) => el("span", { class: `stone${toneOf(reading, node)}` }))), CAIRN);

/** Two organizations make a finding or a patch confirmed (R10, R24). The view says whether, and the page says so in words, with what the word means there. */
const confirmation = (of: keyof typeof CONFIRMATION, confirmed: boolean, nodes: readonly string[], end = false): Drawing =>
  confirmed ? explained(focusable("tag ok", "confirmed by ", String(nodes.length)), CONFIRMATION[of].confirmed, end) : explained(focusable("tag un", "unconfirmed"), CONFIRMATION[of].unconfirmed, end);

/** The members of a list with the ones more organizations stand behind first. Members with as many keep the order of the view, so a page reads the same after every read. */
const mostBacked = <T>(all: readonly T[], backing: (member: T) => number): T[] => all.map((member, at) => ({ member, at })).sort((one, other) => backing(other.member) - backing(one.member) || one.at - other.at).map(({ member }) => member);

/** A path with the line or lines cited in it. */
const where = ({ path, start, end }: Cited): (Drawing | string)[] => [code(path), el("span", { class: "lines" }, start === end ? ["line ", String(start)] : ["lines ", String(start), "–", String(end)])];

/** A link to a finding's entry on the page, by what the finding observed. A finding the view does not hold is named by its ID. */
function findingLink(reading: Reading, id: string): Drawing {
  const group = reading.findings.get(id);
  return group === undefined ? el("span", { class: "ref" }, "finding ", code(short(id))) : el("a", { href: `#finding-${id}` }, words(group.observation));
}

/** A section of a page: its heading, a count beside it where it has one, what the section holds in plain words, and its entries. */
function section({ id, title, count, about }: { readonly id: string; readonly title: string; readonly count?: Child; readonly about?: string }, ...children: readonly Child[]): Drawing {
  return el("section", { id }, el("div", { class: "section-head" }, el("h2", {}, title), count), about === undefined ? undefined : el("p", { class: "intro" }, about), children);
}

const empty = (label: string): Drawing => el("p", { class: "empty" }, label);

/** A record the page shows by its node, its type and its hash alone: pending work and rejected work (KTD31). */
const row = (reading: Reading, { node, type, hash }: { readonly node: string; readonly type: string; readonly hash: string }, label: Drawing): Drawing =>
  el("li", { class: "row" }, organization(reading, node), el("span", { class: "kind" }, type), code(short(hash)), label);

function header(view: View): Drawing {
  const patches = view.patches.reduce((count, group) => count + group.patches.length, 0);
  const count = ([number, word]: [string, string], means?: string): Drawing => el("div", {}, el("dt", {}, means === undefined ? word : explained(focusable("", word), means, true)), el("dd", {}, number));
  // Until the index holds its own copy it has checked nothing against it. A count of findings or of patches would be nought then, and would read as an all-clear (R14).
  const checked = view.state === "ready" ? [count(counted(view.findings.length, "finding", "findings")), count(counted(patches, "patch", "patches"))] : undefined;
  return el(
    "header",
    { class: "head" },
    el(
      "div",
      {},
      el("p", { class: "label" }, explained(focusable("", "Component"), COMPONENT)),
      el("h1", {}, address(view.gitUrl)),
      el("p", { class: "commit" }, "commit ", code(view.component)),
      // The other versions of this repo are on the index's own page, narrowed to the repo. The link stays on the index, whatever the Git URL holds.
      el("p", { class: "versions" }, el("a", { href: `/?repo=${encodeURIComponent(view.gitUrl)}` }, "Every version of this repo on this index")),
    ),
    el("dl", { class: "counts" }, count(counted(view.organizations, "organization", "organizations"), ORGANIZATIONS), checked),
  );
}

/** The page shows only live claims (R15). A closed or expired claim keeps its state in the endpoint (KTD15). */
function claims(reading: Reading): Drawing {
  const live = reading.view.claims.filter(({ state }) => state === "live");
  if (live.length === 0) return section({ id: "claims", title: "Live claims", about: ABOUT.claims }, empty("No live claims"));
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
  return section({ id: "claims", title: "Live claims", count: el("span", { class: "count" }, String(live.length), " live"), about: ABOUT.claims }, el("ul", { class: "claims" }, shown));
}

function pending(reading: Reading): Drawing | undefined {
  const waiting = reading.view.pending;
  if (waiting.length === 0) return undefined;
  return section({ id: "pending", title: "Being checked", about: ABOUT.pending }, el("ul", { class: "rows" }, waiting.map((record) => row(reading, record, explained(focusable("tag un", "pending"), PENDING, true)))));
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
      // What the finding says, as one sentence about the component, with its host where it names one.
      el("strong", {}, said(group)),
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
      organizations(reading, behind, "Reported by: "),
    ),
    confirmation("finding", count?.confirmed ?? false, behind, true),
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
  if (groups.length === 0) return section({ id: "findings", title: "Findings", about: ABOUT.findings }, empty("No findings published"), el("p", { class: "note" }, "This is not a statement that the version is safe."));
  // A criterion and the findings that count against it are one block, so a reader sees which heading a finding stands under.
  const byCriterion = CRITERIA.flatMap((criterion) => {
    const named = groups.flatMap((group) => {
      const records = group.findings.filter(({ record }) => record.criterion === criterion);
      return records.length === 0 ? [] : [{ group, records }];
    });
    if (named.length === 0) return [];
    // The findings more organizations report under this criterion stand first.
    const entries = mostBacked(named, ({ group }) => group.criteria.find((held) => held.criterion === criterion)?.nodes.length ?? 0);
    return [
      el(
        "div",
        { class: "criterion" },
        // The criterion is a link to where the protocol defines it, and the head says in a line what it promises.
        el("div", { class: "criterion-head" }, el("h3", {}, "Counts against ", el("a", { class: "badge", href: DEFINED_AT }, code(criterion))), el("span", { class: "tip" }, DEFINED), el("p", { class: "promise" }, PROMISE[criterion])),
        el("ul", { class: "findings" }, entries.map(({ group, records }) => finding(reading, group, criterion, records))),
      ),
    ];
  });
  return section({ id: "findings", title: "Findings", about: ABOUT.findings }, byCriterion);
}

/** One patch identity: a column of its group. Identical patches are one entry that lists its organizations (R16). */
function patch(reading: Reading, entry: PatchEntry): Drawing {
  // The organizations that wrote it, in the order of their addresses, so an entry reads the same after every read.
  const authors = [...new Set(entry.records.map(({ node }) => node))].sort();
  // The findings it is for, in the order its records name them. Each team's record names
  // that team's own finding records, and two of them can be records of one group of
  // matching findings. The entry links once to each group, by the first of the group's
  // records that is named. A finding the view does not hold stands for itself.
  const cited = entry.records.flatMap(({ record }) => record.findings);
  const named = distinct(cited, (id) => reading.findings.get(id) ?? id);
  return el(
    "article",
    { class: "patch", id: `patch-${entry.patchId}` },
    organizations(reading, authors, "Written by: "),
    el("div", { class: "tags" }, explained(focusable("tag", words(entry.kind)), KIND[entry.kind]), confirmation("patch", entry.confirmed, entry.nodes)),
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
    // What each record of the patch declares, a line for each: its team, then the word and the model as one label (R14). The line is set
    // as a re-check's is, with no outline: a declared value is a statement and no status. The teams stand in the order of the row above.
    // A model is drawn as the record holds it: with its hyphens as spaces it would read as another name.
    el(
      "ul",
      { class: "declarations" },
      authors
        .flatMap((author) => entry.records.filter(({ node }) => node === author))
        .map(({ node, record }) => el("li", { class: "declared" }, organization(reading, node), explained(focusable("", "declared: ", code(record.model)), DECLARED))),
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
  if (groups.length === 0) return section({ id: "patches", title: "Patches", about: ABOUT.patches }, empty("No patches published"));
  // The patches more organizations stand behind come first: within a group, and among the groups by the best of each.
  const ordered = mostBacked(
    groups.map((group) => ({ ...group, patches: mostBacked(group.patches, ({ nodes }) => nodes.length) })),
    ({ patches: held }) => Math.max(...held.map(({ nodes }) => nodes.length)),
  );
  return section(
    { id: "patches", title: "Patches", about: ABOUT.patches },
    ordered.map((group) =>
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
  if (published.length === 0) return section({ id: "recipes", title: "Recipes", about: ABOUT.recipes }, empty("No recipes published"));
  // The copies more organizations published come first.
  const shown = mostBacked(published, ({ nodes }) => nodes.length).map(({ tree, records, nodes }) =>
    el(
      "li",
      { class: "recipe" },
      el("div", { class: "used" }, el("b", {}, String(nodes.length)), nodes.length === 1 ? " organization published this copy" : " organizations published this copy"),
      el("div", { class: "tree" }, "tree ", code(tree), explained(focusable("tag un", "published, not checked"), NOT_CHECKED)),
      organizations(reading, nodes),
      el("ul", { class: "taken" }, [...new Set(records.flatMap(({ record }) => record.patches))].map((id) => el("li", {}, patchLink(reading, id)))),
    ),
  );
  return section({ id: "recipes", title: "Recipes", about: ABOUT.recipes }, el("ul", { class: "recipes" }, shown));
}

/** Rejected work is its contributor, its type, its hash and its reason, and nothing more (KTD31). */
function rejected(reading: Reading): Drawing | undefined {
  const refused = reading.view.rejected;
  if (refused.length === 0) return undefined;
  return section({ id: "rejected", title: "Rejected work", about: ABOUT.rejected }, el("ul", { class: "rows" }, refused.map((record) => row(reading, record, explained(focusable("tag rej", words(record.reason)), REFUSED[record.reason], true)))));
}

/** The label of a component whose copy the index does not hold yet, or never will. */
const NOT_READY = { importing: "The index is still importing this version", failed: "The index could not import this version" } as const;

/** The page of a registered component. */
function viewed(place: ComponentPlace, view: View): Drawing {
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

/** The label of an address the index serves no view for: a commit that is not registered, in the origin's words (R14), and teams the index does not take (KTD38). */
const NO_VIEW = { unknown: "No reviews published for this version", refused: "The index does not take the teams in this address" } as const;

/** The page of an address the index serves no view for: its label, and the commit the address names. */
function unviewed(place: ComponentPlace, kind: keyof typeof NO_VIEW): Drawing {
  return el("div", { class: "view" }, el("section", { id: "state" }, el("h2", {}, NO_VIEW[kind]), el("p", { class: "commit" }, "commit ", code(place.component))));
}

type Listed = ComponentList["components"][number];

/**
 * The import state of a listed component, in words: its label, the class of the label
 * and what the label means, which the page shows when the label is pointed at or
 * focused. The index stores a copy it holds as `ready`, which would read as an
 * all-clear (R14), so the label says what the index holds and nothing of the component.
 * The object must name every state, so the type check fails when that list changes.
 */
const IMPORT: { readonly [S in Listed["state"]]: { readonly label: string; readonly tag: string; readonly means: string } } = {
  ready: { label: "copy held", tag: "tag", means: "The index holds its own copy of this version, and checks every record against it." },
  importing: { label: "importing", tag: "tag un", means: "The index is still fetching its own copy of this version. It checks no record until it holds one." },
  failed: { label: "import failed", tag: "tag rej", means: "The index could not fetch its own copy of this version, so it checks no record for it." },
};

/** The members of a list in groups by a key. A group stands where its first member stood, and its members keep their order. */
function grouped<T>(all: readonly T[], key: (member: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const member of all) {
    const held = groups.get(key(member));
    if (held === undefined) groups.set(key(member), [member]);
    else held.push(member);
  }
  return [...groups];
}

/** One version in the list: its commit, as a link to its page on this index, and its import state. The whole row leads where the link does. */
function listedRow({ component, state }: Listed): Drawing {
  const { label, tag, means } = IMPORT[state];
  return el("li", { class: "row" }, el("a", { class: "commit", href: `/components/${component}` }, "commit ", code(short(component))), explained(focusable(tag, label), means, true));
}

/**
 * The index's own page: every component the index holds. The versions of one repo stand
 * together under its Git URL, and in it the versions of one branch. A repo stands where
 * its first version was registered, a branch likewise, and the versions of a branch in the
 * order they were registered. The way out to a repo is a mark beside its address, and only
 * for an HTTPS address (KTD14).
 *
 * An address that names a repo narrows the page to that repo's versions, and the page
 * says so. It never writes down what the address names: it shows a Git URL only as the
 * list holds it.
 */
function listed({ components: all }: ComponentList, repo?: string): Drawing {
  const components = repo === undefined ? all : all.filter(({ url }) => url === repo);
  const narrowed =
    repo === undefined ? undefined : el("div", { id: "narrowed", class: "notice" }, el("strong", {}, "One repo"), el("span", {}, "Only the versions of one repo are listed."), el("a", { href: "/" }, "Every component of this index"));
  // An index with no component says so in words of its own. A count of nought is not drawn, as on a component's page (R14).
  if (components.length === 0) return el("div", { class: "view" }, narrowed, section({ id: "components", title: "Components" }, empty(repo === undefined ? "No component registered" : "No version of this repo registered")));
  const repos = grouped(components, ({ url }) => url).map(([url, versions]) =>
    el(
      "li",
      { class: "repo" },
      el("div", { class: "repo-head" }, el("h3", {}, url), isHttps(url) ? el("a", { class: "source", href: url }, el("span", {}, "source")) : undefined),
      el(
        "ul",
        { class: "branches" },
        grouped(versions, ({ branch }) => branch).map(([branch, held]) => el("li", { class: "branch" }, el("span", { class: "branch-name" }, "branch ", code(branch)), el("ul", { class: "rows" }, held.map(listedRow)))),
      ),
    ),
  );
  return el("div", { class: "view" }, narrowed, section({ id: "components", title: "Components", count: el("span", { class: "count" }, String(components.length)) }, el("ul", { class: "repos" }, repos)));
}

/**
 * The list as one text. The list carries no version, so the page holds this between two
 * reads to tell whether the list changed. Each component gives its four values in one
 * order, so two answers that say the same are one text.
 */
const keyOf = ({ components }: ComponentList): string => JSON.stringify(components.map(({ component, url, branch, state }) => [component, url, branch, state]));

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
 * What a read gives the page at a place: what the page holds it by between two reads,
 * and its drawing. Nothing for a read that failed, and nothing for an answer of the
 * other page's endpoint. The index's own page shows the list and no other answer: it
 * names no commit and passes on no teams, so a refusal says nothing it can show.
 */
function shownAt(place: Place, read: Read): { readonly version: number | string; readonly body: () => Drawing } | undefined {
  if (place.kind === "index") return read.kind === "list" ? { version: keyOf(read.list), body: () => listed(read.list, place.repo) } : undefined;
  if (read.kind === "view") return { version: read.view.viewVersion, body: () => viewed(place, read.view) };
  return read.kind === "unknown" || read.kind === "refused" ? { version: read.kind, body: () => unviewed(place, read.kind) } : undefined;
}

/**
 * What the page shows after one read. A read that failed leaves what is on screen and
 * says when that was read. So does an answer that is not this page's: a view on the
 * index's own page, or the list on the page of a component. A view is drawn again only
 * when its version changed (KTD11): the version moves with every change the view can
 * show, a claim that passes its time included. The list is drawn again only when what it
 * says changed. An answer that is no view is a state of its own on the page of a
 * component, drawn once: a commit that is not registered, and teams the index does not
 * take.
 */
export function draw(place: Place, held: Held, read: Read, now: number): Drawn {
  const shown = shownAt(place, read);
  if (shown === undefined) {
    const after: Held = { ...held, failed: true };
    return { held: after, status: status(after) };
  }
  const after: Held = { last: { version: shown.version, at: now }, failed: false };
  if (held.last !== undefined && held.last.version === shown.version) return { held: after, status: status(after) };
  return { held: after, status: status(after), body: shown.body() };
}
