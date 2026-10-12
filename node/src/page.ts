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

/** The most components the page draws, and the most records of one component. A page then holds at most 1,000 links. */
const MOST_COMPONENTS = 20;
const MOST_RECORDS = 50;

/**
 * How long the node keeps a page, in milliseconds. A walk reads the binding for the head
 * and then once for each folder, for anyone who asks, and the kept page is what bounds it.
 */
const KEPT_FOR = 30_000;

/**
 * Every word the page says of its own. Each says what a thing on the page is, and none
 * tells a reader to do anything (R47).
 */
const WORDS = {
  title: "Cairnfield team node",
  about: [
    "This page is this team's own list of the records it has published. Nothing on it was checked: a node validates no record, and this page reads none.",
    "Each record stands under its component, by the type and the ID that the path of its file gives. A component is one version of an AI tool: its Git repository at one commit.",
  ],
  address: "Node address",
  head: "Team repo head",
  drawn: "Drawn at",
  component: "Component",
  nothingYet: "This team has published nothing yet.",
  noRecord: "The team repo holds no record.",
  unreadable: "The node could not read its team repo.",
  recordsLeft: "Records not drawn here:",
  componentsLeft: "Components not drawn here:",
  allRecords: "The node's records route lists every record.",
} as const;

// The page's one style. The colors and the spacing are those of the index's pages, with
// the faces a reader's own system has, because the page loads no file. An outline carries
// the meaning it has there: dashed is unconfirmed, and nothing on this page was checked.
// On a narrow screen a record's type stands above its ID, so the ID has the whole line.
const STYLE = `
:root { --fog: #EDF0EE; --paper: #FAFBF9; --ink: #1E2A2E; --muted: #5B6B70; --line: #C9D1CC; --line-soft: #DDE3DF; --slate: #5E6C76; --body: "Helvetica Neue", Arial, sans-serif; --mono: ui-monospace, "SF Mono", Menlo, monospace; --gutter: clamp(16px, 4vw, 48px); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--fog); color: var(--ink); font: 400 16px/1.5 var(--body); }
main { max-width: calc(900px + 2 * var(--gutter)); margin-inline: auto; padding: clamp(36px, 7vw, 76px) var(--gutter) clamp(48px, 7vw, 80px); }
h1 { font: 400 clamp(30px, 4.6vw, 46px)/1.08 var(--body); letter-spacing: -0.01em; margin: 0 0 20px; }
p { margin: 0; }
.about { max-width: 43em; font-size: clamp(16px, 1.55vw, 18px); text-wrap: pretty; }
.about + .about { margin-top: 10px; font-size: 15px; color: var(--muted); }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 20px; margin: 28px 0 0; padding-top: 18px; border-top: 1px solid var(--line); font-size: 14px; }
dt { color: var(--muted); }
dd { margin: 0; }
dd, code, .type { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
section { margin-top: 20px; padding: 20px 22px 22px; background: var(--paper); border: 1px dashed #9AA6A3; border-radius: 10px; }
h2 { font: 400 14px/1.5 var(--body); color: var(--muted); margin: 0 0 10px; }
h2 code { display: block; font-size: 15px; font-weight: 600; color: var(--ink); }
ul { list-style: none; margin: 0; padding: 0; }
li { border-top: 1px solid var(--line-soft); }
a { display: flex; flex-wrap: wrap; gap: 0 16px; padding: 9px 0; color: inherit; text-decoration: none; }
.type { flex: 0 0 10em; font-weight: 600; color: var(--muted); }
a code { flex: 1 1 20ch; min-width: 0; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
a:hover code { text-decoration-color: var(--ink); }
a:focus-visible { outline: 3px solid var(--slate); outline-offset: 2px; }
.none { margin-top: 24px; }
.left { margin-top: 20px; font-size: 15px; color: var(--muted); }
section .left { margin-top: 0; padding-top: 12px; border-top: 1px solid var(--line-soft); font-size: 14px; }
.left span { display: inline-block; margin-right: 14px; }
.left b { font-weight: 600; color: var(--ink); }
@media (max-width: 560px) { .type { flex-basis: 100%; } h2 code { font-size: 12.5px; } }
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
  const links = records.slice(0, MOST_RECORDS).map(({ path, type, id }) => {
    // The link is relative, so it leads to the `file` route of the node the page came from.
    const href = `${PATHS.file}?commit=${head}&path=${path}`;
    return `<li><a href="${escaped(href)}"><span class="type">${escaped(type)}</span> <code>${escaped(id)}</code></a></li>`;
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
  return { head: held.head, lines: [...sections, ...left(WORDS.componentsLeft, commits.length - MOST_COMPONENTS)] };
}

/** One fact about the page: the words for what a value is, and the value as HTML. */
function fact(words: string, value: string): string {
  return `<dt>${escaped(words)}</dt><dd>${value}</dd>`;
}

/** The whole document: the page's own words, the node's address, the head and the time of the walk, and then what the walk gave. */
function documentOf(address: string | undefined, at: number, { head, lines }: Listed): string {
  // The time is that of the walk, to the second, so a reader of a kept page can tell its age.
  const time = new Date(at).toISOString().replace(/\.\d+Z$/, "Z");
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
    "<main>",
    `<h1>${escaped(WORDS.title)}</h1>`,
    ...WORDS.about.map((words) => `<p class="about">${escaped(words)}</p>`),
    "<dl>",
    ...(address === undefined ? [] : [fact(WORDS.address, escaped(address))]),
    ...(head === undefined ? [] : [fact(WORDS.head, escaped(head))]),
    fact(WORDS.drawn, `<time>${escaped(time)}</time>`),
    "</dl>",
    ...lines,
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

// The page of the last walk that ended well. It is kept as a value and not as the promise
// of its walk, so a walk that fails waits on no walk before it: one that never ended
// would hold every failed walk after it.
let lastRead: Page | undefined;

/** The page of a walk that begins at `at`. */
async function drawn(env: Env, at: number): Promise<Page> {
  // The address is drawn only in the one spelling in which it is this Worker's origin (KTD8).
  const address = isNodeOrigin(env.NODE_URL) ? env.NODE_URL : undefined;
  try {
    lastRead = { status: 200, html: documentOf(address, at, await listed(env.ARTIFACTS)) };
    return lastRead;
  } catch {
    // Artifacts failed. The last page that came from a walk is served on: it says when it
    // was drawn. With none, the answer says in fixed words that the repo could not be read.
    // Either is kept as any page is, so a failing Artifacts is asked once in that time.
    if (lastRead) return lastRead;
    const lines = [`<p class="none">${escaped(WORDS.unreadable)}</p>`];
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
