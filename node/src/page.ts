// The node's own page (R47, KTD45): what the team repo holds, drawn as HTML for a person
// who opens the node's address. It stands outside the node contract, and no index and no
// command reads it.
//
// The page is the team's own list, and nothing on it was checked. It draws the parts of
// each record path, the head commit, the node's own address and the time of its walk, and
// reads no record file. Every other word on it is fixed in this file.

import { TEAM_REPO, open } from "./artifacts.ts";
import type { Store } from "./artifacts.ts";
import { PATHS, isNodeOrigin, recordPath } from "./contract.ts";
import type { RecordPath } from "./contract.ts";
import type { Env } from "./env.ts";
import { recordFiles } from "./tree.ts";

/** The most components the page draws, and the most records of one component. A page then holds at most 1,000 record links. */
const MOST_COMPONENTS = 20;
const MOST_RECORDS = 50;

/**
 * How long the node keeps a page, in milliseconds. A walk reads the binding for the head
 * and then once for each folder, for anyone who asks, and the kept page is what bounds it.
 */
const KEPT_FOR = 30_000;

/** The project's site. The project's name in the bar leads there, as it does on the index's pages, and it is the page's one link that is no record's. */
const SITE = "https://cairnfield.net";

/**
 * Every word the page says of its own. Each says what a thing on the page is, and none
 * tells a reader to do anything (R47).
 */
const WORDS = {
  project: "Cairnfield",
  here: "node",
  title: "Cairnfield team node",
  about: [
    "This page is this team's own list of the records it has published. Nothing on it was checked: a node validates no record, and this page takes each record's type and ID from the name of its file, which it does not open.",
    "Each record is listed under its component by type and ID. A component is one version of an AI tool: its Git repository at one commit.",
  ],
  address: "Node address",
  head: "Latest commit of the team repo",
  drawn: "Read at",
  component: "Component",
  nothingYet: "This team has published nothing yet.",
  noRecord: "The team repo holds no record.",
  unreadable: "The node could not read its team repo.",
  recordsLeft: "Records not shown here:",
  componentsLeft: "Components not shown here:",
  allRecords: "The address of this node with /records added lists every record.",
} as const;

/** One contour line of a hill: how far it stands from the hill's top, and how far across and down it is moved. */
type Contour = readonly [away: number, across: number, down: number];

/**
 * The contour lines of one hill of the map, as the shadows of one shape. A shadow follows
 * the shape it is cast by, so each line is two shadows: one in the line's color, and over
 * it one in the ground's color that covers all of the first but its rim. The top itself is
 * line 1, and every fifth line is an index line, drawn heavier, as the index's map has it.
 */
function hill(lines: readonly Contour[]): string {
  const rings = lines.flatMap(([away, across, down], at) => {
    const [color, weight] = (at + 2) % 5 === 0 ? ["var(--contour-5)", 1.5] : ["var(--contour)", 1];
    return [`${across}px ${down}px 0 ${away}px var(--fog)`, `${across}px ${down}px 0 ${away + weight}px ${color}`];
  });
  return ["inset 0 0 0 1px var(--contour)", ...rings].join(", ");
}

// Two hills. The lines of each stand at uneven distances and drift to one side, as the lines of a slope do.
const HILL = hill([
  [40, -5, 3], [88, -12, 9], [128, -15, 14], [198, -26, 20], [272, -36, 31], [326, -41, 37], [418, -55, 48], [520, -66, 62], [588, -71, 68], [706, -85, 80],
]);
const FAR_HILL = hill([[54, 6, -4], [98, 10, -9], [176, 21, -16], [244, 29, -26], [296, 33, -31]]);

// The page's one style. The colors, the spacing and the parts are those of the index's
// pages: the bar, the band under it, a team's stone before its address, and a block for
// each component as the index has one for each repo. The page loads no file, so each face
// is the index's only for a reader whose system has it, and after it stands a face that
// systems come with. The map behind the page is drawn here too, by `hill`, and it is
// decoration: it stays still, and it says nothing.
//
// The page follows the reader's color scheme. Every color a rule paints with is a token of
// the palette on `:root`, and the block after it gives those tokens other values for a
// reader whose system asks for dark. That block sets tokens and nothing else, and it
// stands in this one style, so the policy needs no word for it. The hills are drawn in
// tokens too, so they follow the palette. The shade of the stone stays written out: it
// reads the same on both grounds.
//
// An outline carries the meaning it has on the index: dashed is unconfirmed, and nothing
// on this page was checked. A type names itself once, beside its records. The word stays
// in each link for a reader who does not see the page. On a narrow screen it stands over them.
const STYLE = `
:root { color-scheme: light dark; --fog: #EDF0EE; --paper: #FAFBF9; --band: #F1F4F2; --ink: #1E2A2E; --muted: #5B6B70; --line: #C9D1CC; --line-soft: #DDE3DF; --mark: #9AA6A3; --focus: #5E6C76; --bar: rgba(250, 251, 249, .94); --veil: rgba(250, 251, 249, .62); --note: #FFF6D6; --note-line: #E8D79A; --contour: #DAE0DC; --contour-5: #C6CFCA; --display: "Routed Gothic", Bahnschrift, "DIN Alternate", "Hanken Grotesk", "Helvetica Neue", Arial, sans-serif; --body: "Hanken Grotesk", "Helvetica Neue", Arial, sans-serif; --mono: "Spline Sans Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace; --gutter: clamp(16px, 4vw, 48px); }
@media (prefers-color-scheme: dark) {
  :root { --fog: #131B1E; --paper: #1B2529; --band: #172024; --ink: #E3E9E5; --muted: #A3B0AE; --line: #3E4E56; --line-soft: #313F45; --mark: #74838A; --focus: #A9B8C3; --bar: rgba(27, 37, 41, .94); --veil: rgba(27, 37, 41, .62); --note: #383012; --note-line: #6E5F24; --contour: #1E282D; --contour-5: #27343A; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--fog); color: var(--ink); font: 400 16px/1.5 var(--body); }
p { margin: 0; }
ul { list-style: none; margin: 0; padding: 0; }
body::before, body::after { content: ""; position: fixed; z-index: -1; pointer-events: none; }
body::before { top: 148px; right: 13%; width: 132px; height: 76px; rotate: -16deg; border-radius: 58% 42% 52% 48% / 62% 56% 44% 38%; box-shadow: ${HILL}; }
body::after { left: -70px; bottom: -50px; width: 210px; height: 124px; rotate: 21deg; border-radius: 46% 54% 44% 56% / 55% 62% 38% 45%; box-shadow: ${FAR_HILL}; }
.wrap { max-width: calc(1280px + 2 * var(--gutter)); margin-inline: auto; padding-inline: var(--gutter); }
.bar { position: sticky; top: 0; z-index: 1; background: var(--bar); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); }
.bar .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 22px; min-height: 52px; padding-block: 8px; }
.trail { display: flex; align-items: baseline; gap: 10px; font: 500 13px/1 var(--mono); }
.mark { font: 400 24px/1 var(--display); letter-spacing: -0.01em; color: inherit; text-decoration: none; }
.here::before { content: "/"; margin-right: 10px; color: var(--mark); }
.status { margin-left: auto; font: 500 12px/1.4 var(--mono); color: var(--muted); }
.hero { background: var(--veil); border-bottom: 1px solid var(--line); }
.hero .wrap { padding-block: clamp(40px, 7vw, 76px) clamp(32px, 5vw, 52px); }
h1 { font: 400 clamp(34px, 4.6vw, 54px)/1.08 var(--display); letter-spacing: 0.005em; margin: 0 0 20px; }
.lead { max-width: 43em; font-size: clamp(17px, 1.55vw, 20px); text-wrap: pretty; }
dl { display: flex; flex-wrap: wrap; gap: 18px 56px; margin: clamp(26px, 3.4vw, 40px) 0 0; }
dt { margin-bottom: 8px; font: 500 12px/1 var(--mono); color: var(--muted); }
dd { margin: 0; font: 500 13px/1.5 var(--mono); overflow-wrap: anywhere; }
.org { font-weight: 600; }
.org::before { content: ""; display: inline-block; width: 15px; height: 8px; margin-right: 7px; border-radius: 58% 42% 52% 48% / 62% 56% 44% 38%; background: var(--muted); box-shadow: inset 0 -2px 0 rgba(0, 0, 0, .17); }
.list { padding-block: clamp(28px, 4vw, 44px) clamp(48px, 7vw, 80px); }
.about { max-width: 62em; font-size: 15px; color: var(--muted); text-wrap: pretty; }
.components { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(624px, 100%), 1fr)); gap: 20px; align-items: start; margin-top: 24px; }
section { min-width: 0; max-width: 760px; background: var(--paper); border: 1px dashed var(--mark); border-radius: 10px; }
h2 { margin: 0; padding: 12px 16px; background: var(--band); border-bottom: 1px solid var(--line-soft); border-radius: 9px 9px 0 0; font: 500 12.5px/1.4 var(--mono); color: var(--muted); }
h2 code { display: block; margin-top: 2px; font: 600 clamp(11.5px, 3.3vw, 14px)/1.4 var(--mono); color: var(--ink); overflow-wrap: anywhere; }
li a { display: grid; grid-template-columns: 130px minmax(0, 1fr); color: inherit; text-decoration: none; font: 400 12px/1.5 var(--mono); }
.type { padding: 10px 0 10px 16px; font-weight: 500; color: var(--muted); white-space: nowrap; }
li a code { grid-column: 2; padding: 10px 16px 10px 10px; border-top: 1px solid var(--line-soft); overflow-wrap: anywhere; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
li.first { border-top: 1px solid var(--line-soft); }
li.first code, li:first-child { border-top: 0; }
li:not(.first) .type { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
li a:hover code { background: var(--band); text-decoration-color: var(--ink); }
li:last-child a, li:last-child code { border-radius: 0 0 9px 9px; }
a:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
li a:focus-visible { outline-offset: -3px; border-radius: 6px; }
.none { max-width: 760px; margin-top: 24px; padding: 16px 20px; border-radius: 10px; background: var(--paper); }
.none.failed { background: var(--note); border: 1px solid var(--note-line); }
.left { margin-top: 20px; font-size: 15px; color: var(--muted); }
section .left { margin: 0; padding: 12px 16px; border-top: 1px solid var(--line-soft); font-size: 13.5px; }
.left span { display: inline-block; margin-right: 14px; }
.left b { font-weight: 600; color: var(--ink); }
@media (max-width: 1099px) { body::after { display: none; } }
@media (max-width: 719px) {
  .bar .wrap { column-gap: 14px; }
  .mark { font-size: 21px; }
  .here { display: none; }
  li a { grid-template-columns: minmax(0, 1fr); }
  .type { padding: 12px 14px 0; }
  li a code { grid-column: 1; padding: 8px 14px 10px; }
  li.first code { padding-top: 4px; }
  h2, section .left { padding-inline: 14px; }
}
`;

/**
 * The page's content security policy (KTD45). It allows the one style written into the
 * page, by the hash of its text, and nothing else: no script, no image, no font, no
 * frame, no form and no request. The style is written into the page because the node has
 * no assets binding and no build step to serve it from.
 */
async function policy(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return ["default-src 'none'", `style-src 'sha256-${hash}'`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
}

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // The kept page already bounds the walks. A browser's own copy on top would show a reader an older page than the node keeps.
  "cache-control": "no-store",
  // Each record link costs the node two reads of the binding that nothing keeps, so no crawler is invited to follow one.
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

const ESCAPES: { readonly [character: string]: string } = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** A value as HTML text, or as the value of an attribute in double quotes. Everything the page draws goes through here. */
function escaped(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? "");
}

/** The line that gives a number the page did not draw, or no line when it drew them all. */
function left(words: string, count: number): string[] {
  if (count <= 0) return [];
  return [`<p class="left"><span>${escaped(words)} <b>${count}</b></span> <span>${escaped(WORDS.allRecords)}</span></p>`];
}

/** One component with its records, each a link to that record's file at the head. */
function component(head: string, commit: string, records: readonly RecordPath[]): string[] {
  const links = records.slice(0, MOST_RECORDS).map(({ path, type, id }, at) => {
    // The link is relative, so it leads to the `file` route of the node the page came from.
    const href = `${PATHS.file}?commit=${head}&path=${path}`;
    // The records come in the order of their types, so the first of a type is the one where the type shows.
    const first = records[at - 1]?.type === type ? "" : ' class="first"';
    return `<li${first}><a href="${escaped(href)}"><span class="type">${escaped(type)}</span> <code>${escaped(id)}</code></a></li>`;
  });
  return [
    "<section>",
    `<h2>${escaped(WORDS.component)} <code>${escaped(commit)}</code></h2>`,
    "<ul>",
    ...links,
    "</ul>",
    ...left(WORDS.recordsLeft, records.length - MOST_RECORDS),
    "</section>",
  ];
}

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What one walk of the team repo gives the page: the head, when there is one, and the lines under the page's own. */
interface Listed {
  readonly head: string | undefined;
  readonly lines: readonly string[];
}

/** Walks the team repo as the listing does, and draws what the record path pattern admits of it. */
async function listed(store: Store): Promise<Listed> {
  const team = await open(store, TEAM_REPO);
  // No team repo, one that is still being made and one with no push have nothing to list.
  const held = typeof team === "string" ? undefined : await recordFiles(team);
  if (!held) return { head: undefined, lines: [`<p class="none">${escaped(WORDS.nothingYet)}</p>`] };
  // The node validates nothing, so a file under the records folder can have any name. The
  // page draws a file only by the parts the pattern captures, and any other file not at all.
  const components = new Map<string, RecordPath[]>();
  for (const { path } of held.files) {
    const record = recordPath(path);
    if (!record) continue;
    const records = components.get(record.component) ?? [];
    records.push(record);
    components.set(record.component, records);
  }
  if (components.size === 0) return { head: held.head, lines: [`<p class="none">${escaped(WORDS.noRecord)}</p>`] };
  // The order is the page's own: components by commit, and a component's records by type and then by ID.
  const commits = [...components.keys()].sort(ascending);
  const sections = commits.slice(0, MOST_COMPONENTS).flatMap((commit) => {
    const records = components.get(commit) ?? [];
    records.sort((a, b) => ascending(a.type, b.type) || ascending(a.id, b.id));
    return component(held.head, commit, records);
  });
  const blocks = ['<div class="components">', ...sections, "</div>"];
  return { head: held.head, lines: [...blocks, ...left(WORDS.componentsLeft, commits.length - MOST_COMPONENTS)] };
}

/** One fact about the node: the words for what a value is, and the value. The node's address stands after the team's stone. */
function fact(words: string, value: string, stone = false): string {
  return `<div><dt>${escaped(words)}</dt><dd${stone ? ' class="org"' : ""}>${escaped(value)}</dd></div>`;
}

/** The whole document: the page's own words, the node's address, the head and the time of the walk, and then what the walk gave. */
function documentOf(address: string | undefined, at: number, { head, lines }: Listed): string {
  // The time is that of the walk, to the second, so a reader of a kept page can tell its age.
  // It is written in UTC as the index's pages write theirs, with the date, which a kept page needs.
  const time = new Date(at).toISOString().replace(/\.\d+Z$/, "Z");
  const shown = time.replace("T", " ").replace("Z", " UTC");
  const [lead, about] = WORDS.about;
  const facts = [...(address === undefined ? [] : [fact(WORDS.address, address, true)]), ...(head === undefined ? [] : [fact(WORDS.head, head)])];
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escaped(WORDS.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    // The bar is the index's: the project's name, which leads to the project's site, what this page is of it, and when the walk was made.
    '<header class="bar">',
    '<div class="wrap">',
    `<p class="trail"><a class="mark" href="${escaped(SITE)}">${escaped(WORDS.project)}</a> <span class="here">${escaped(WORDS.here)}</span></p>`,
    `<p class="status">${escaped(WORDS.drawn)} <time datetime="${escaped(time)}">${escaped(shown)}</time></p>`,
    "</div>",
    "</header>",
    "<main>",
    '<div class="hero">',
    '<div class="wrap">',
    `<h1>${escaped(WORDS.title)}</h1>`,
    `<p class="lead">${escaped(lead)}</p>`,
    ...(facts.length === 0 ? [] : ["<dl>", ...facts, "</dl>"]),
    "</div>",
    "</div>",
    '<div class="wrap list">',
    `<p class="about">${escaped(about)}</p>`,
    ...lines,
    "</div>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** A page as the node keeps it: a status and a document. No `Response` is kept, because one request alone can read one. */
interface Page {
  readonly status: 200 | 503;
  readonly html: string;
}

// The page this isolate keeps, with the time its walk began (KTD45). It is kept as a
// promise, so requests that arrive during a walk wait for that walk and start none.
let kept: { readonly at: number; readonly page: Promise<Page> } | undefined;

// The page of the walk that began last, of those that ended well, with the time that walk
// began. It is kept as a value and not as the promise of its walk, so a walk that fails
// waits on no walk before it: one that never ended would hold every failed walk after it.
let lastRead: { readonly at: number; readonly page: Page } | undefined;

/** The page of a walk that begins at `at`. */
async function drawn(env: Env, at: number): Promise<Page> {
  // The address is drawn only in the one spelling in which it is this Worker's origin (KTD8).
  const address = isNodeOrigin(env.NODE_URL) ? env.NODE_URL : undefined;
  try {
    const page: Page = { status: 200, html: documentOf(address, at, await listed(env.ARTIFACTS)) };
    // A walk that lasts longer than a page is kept can end after the walk that began next.
    // Its page is the older of the two, so it does not take the newer one's place.
    if (!lastRead || at >= lastRead.at) lastRead = { at, page };
    return page;
  } catch {
    // Artifacts failed. The last page that came from a walk is served on: it says when it
    // was drawn. With none, the answer says in fixed words that the repo could not be read.
    // Either is kept as any page is, so a failing Artifacts is asked once in that time.
    if (lastRead) return lastRead.page;
    const lines = [`<p class="none failed">${escaped(WORDS.unreadable)}</p>`];
    return { status: 503, html: documentOf(address, at, { head: undefined, lines }) };
  }
}

/** The kept page, or a new one when none is kept or the kept one has had its time. */
function current(env: Env, context: ExecutionContext): Promise<Page> {
  const now = Date.now();
  if (kept && now - kept.at < KEPT_FOR) return kept.page;
  const walked = drawn(env, now);
  kept = { at: now, page: walked };
  // The walk runs in the request that started it, and the others wait on it. A reader
  // who goes away must not take it along, so that request lives until the page is drawn.
  context.waitUntil(walked);
  return walked;
}

/** Answers a request for the node's own page. It takes nothing from the request. */
export async function page(env: Env, context: ExecutionContext): Promise<Response> {
  const { status, html } = await current(env, context);
  return new Response(html, { status, headers: { ...HEADERS, "content-security-policy": await policy() } });
}
