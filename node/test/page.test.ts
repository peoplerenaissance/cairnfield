// The node's own page (R47, KTD45): what a person sees at a node's address. Each test
// asks the Worker's own `fetch` handler for the page, and reads the document it answers
// with the runtime's HTML parser. Every host, team and file here is invented.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeArtifacts } from "./fake-artifacts.ts";
import type { Files } from "./fake-artifacts.ts";
import { ADMIN_KEY, BASE, answer, freshNode, repoOf } from "./node.ts";
import type { TestNode } from "./node.ts";

/** When each test starts. A test moves the clock from here by hand. */
const START = Date.UTC(2026, 9, 11, 19, 40, 0);
const SECOND = 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

const COMPONENT = "1f".repeat(20);
/** A component whose commit sorts before `COMPONENT`. */
const EARLIER = "0e".repeat(20);
const idOf = (character: string): string => character.repeat(64);
const pathOf = (component: string, type: string, id: string): string => `records/${component}/${type}/${id}.json`;
// The node validates nothing, so a record's content can be any bytes. Each file says where it stands.
const contentOf = (path: string): string => JSON.stringify({ at: path });
const filesAt = (paths: readonly string[]): Files => Object.fromEntries(paths.map((path) => [path, contentOf(path)]));

const CLAIM = pathOf(COMPONENT, "claim", idOf("a"));
const FINDING = pathOf(COMPONENT, "finding", idOf("b"));
const PATCH = pathOf(EARLIER, "patch", idOf("c"));

const NOT_FOUND = { status: 404, body: { error: "not-found" } };
const BAD_REQUEST = { status: 400, body: { error: "bad-request" } };

// The page's own words. Each is written out here as a reader reads it.

/** The bar: the project's name, and what this page is of it. */
const BAR = ["Cairnfield", "node"];
const TITLE = "Cairnfield team node";
const ABOUT = [
  "This page is this team's own list of the records it has published. Nothing on it was checked: a node validates no record, and this page reads none.",
  "Each record stands under its component, by the type and the ID that the path of its file gives. A component is one version of an AI tool: its Git repository at one commit.",
];
const ADDRESS = "Node address";
const HEAD = "Team repo head";
const DRAWN = "Drawn at";
const NOTHING_YET = "This team has published nothing yet.";
const NO_RECORD = "The team repo holds no record.";
const UNREADABLE = "The node could not read its team repo.";
const RECORDS_LEFT = "Records not drawn here:";
const COMPONENTS_LEFT = "Components not drawn here:";
const ALL_RECORDS = "The node's records route lists every record.";

// Reading a page.

interface Link {
  href: string;
  text: string;
}

interface Page {
  readonly status: number;
  readonly headers: Headers;
  /** The document as the node served it. */
  readonly html: string;
  /** Every element in the order of the document, with its attributes. */
  readonly elements: readonly { readonly tag: string; readonly attributes: { readonly [name: string]: string } }[];
  readonly title: string;
  /** The text of each first-level heading. */
  readonly headings: readonly string[];
  /** Each second-level heading, with the links that stand between it and the next one. */
  readonly components: readonly { readonly heading: string; readonly records: readonly Link[] }[];
  /** Each link under the bar. */
  readonly links: readonly Link[];
  /** Each link in the bar. */
  readonly bar: readonly Link[];
  /** The text of each `time` element. */
  readonly times: readonly string[];
  /** The title and every text of the body, each as a reader reads it. */
  readonly texts: readonly string[];
}

const ENTITIES: { readonly [entity: string]: string } = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
/** A text or an attribute's value as a browser reads it. The parser hands both over as they are written. */
const plain = (written: string): string => written.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
/** A text as a reader reads it: with single spaces, and none at either end. */
const tidy = (written: string): string => plain(written).replace(/\s+/g, " ").trim();

/** Reads an answer as an HTML document, with the parser of the Workers runtime. */
async function read(response: Response | Promise<Response>): Promise<Page> {
  const served = await response;
  const html = await served.text();
  const elements: { tag: string; attributes: { [name: string]: string } }[] = [];
  const title: string[] = [];
  const headings: string[] = [];
  const components: { heading: string; records: Link[] }[] = [];
  const links: Link[] = [];
  const bar: Link[] = [];
  const times: string[] = [];
  const texts: string[] = [];
  let text = "";
  /** Gathers the text under each element a selector matches. */
  const gather = (into: string[]) => ({
    element: () => void into.push(""),
    text: (chunk: { readonly text: string }) => void into.push((into.pop() ?? "") + chunk.text),
  });
  const parser = new HTMLRewriter()
    .on("*", {
      element(element) {
        const attributes = Object.fromEntries([...element.attributes].map(([name, value]) => [name ?? "", plain(value ?? "")]));
        elements.push({ tag: element.tagName, attributes });
      },
    })
    .on("title", gather(title))
    .on("h1", gather(headings))
    .on("time", gather(times))
    .on("h2", {
      element: () => void components.push({ heading: "", records: [] }),
      text(chunk) {
        const component = components.at(-1);
        if (component) component.heading += chunk.text;
      },
    })
    .on("header a", {
      element: (element) => void bar.push({ href: plain(element.getAttribute("href") ?? ""), text: "" }),
      text(chunk) {
        const link = bar.at(-1);
        if (link) link.text += chunk.text;
      },
    })
    .on("main a", {
      element(element) {
        const link = { href: plain(element.getAttribute("href") ?? ""), text: "" };
        links.push(link);
        components.at(-1)?.records.push(link);
      },
      text(chunk) {
        const link = links.at(-1);
        if (link) link.text += chunk.text;
      },
    })
    .on("body", {
      text(chunk) {
        text += chunk.text;
        if (!chunk.lastInTextNode) return;
        texts.push(text);
        text = "";
      },
    });
  await parser.transform(new Response(html)).text();
  for (const link of [...links, ...bar]) link.text = tidy(link.text);
  return {
    status: served.status,
    headers: served.headers,
    html,
    elements,
    title: tidy(title.join("")),
    headings: headings.map(tidy),
    components: components.map(({ heading, records }) => ({ heading: tidy(heading), records })),
    links,
    bar,
    times: times.map(tidy),
    texts: [...title, ...texts].map(tidy).filter((one) => one !== ""),
  };
}

/** The tag of each element with the names of its attributes, in the order of the document. */
const shapeOf = (page: Page): unknown[] => page.elements.map(({ tag, attributes }) => [tag, Object.keys(attributes)]);

/** The page's texts that are none of these values. */
const wordsOf = (page: Page, values: readonly string[]): string[] =>
  [...new Set(page.texts.filter((one) => !values.includes(one)))].sort();

/** The time a page says it was drawn at, in milliseconds. */
function drawnAt(page: Page): number {
  expect(page.times).toHaveLength(1);
  return Date.parse(page.times[0] ?? "");
}

type Settings = Parameters<typeof freshNode>[1];

/** A node in an isolate of its own, whose team repo holds these files at its head. */
async function published(
  files: Files,
  settings?: Settings,
  artifacts: FakeArtifacts = new FakeArtifacts(),
): Promise<{ artifacts: FakeArtifacts; node: TestNode; team: string; head: string }> {
  const node = await freshNode(artifacts, settings);
  const team = await repoOf(node.admin("team-repo"));
  return { artifacts, node, team, head: await artifacts.push(team, "main", files) };
}

describe("the node's page", () => {
  it("lists each component with each of its records by type and ID, as a link to that record's file at the head", async () => {
    const { node, head } = await published(filesAt([CLAIM, FINDING, PATCH]));
    const page = await read(node.get(""));

    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // A link is relative, so it leads to the `file` route of the node the page came from.
    expect(page.components).toEqual([
      { heading: `Component ${EARLIER}`, records: [{ text: `patch ${idOf("c")}`, href: `file?commit=${head}&path=${PATCH}` }] },
      {
        heading: `Component ${COMPONENT}`,
        records: [
          { text: `claim ${idOf("a")}`, href: `file?commit=${head}&path=${CLAIM}` },
          { text: `finding ${idOf("b")}`, href: `file?commit=${head}&path=${FINDING}` },
        ],
      },
    ]);
    expect(page.links).toEqual(page.components.flatMap(({ records }) => records));
    // Followed from the node's address, each link gives the record it names.
    const followed = await Promise.all(page.links.map(async ({ href }) => (await node.get(href)).text()));
    expect(followed).toEqual([PATCH, CLAIM, FINDING].map(contentOf));
    expect(page.texts).toContain(head);
  });

  it("has a title, a language, a viewport setting, one heading for the node and one for each component, and a text on every link", async () => {
    const { node } = await published(filesAt([CLAIM, FINDING, PATCH]));
    const page = await read(node.get(""));

    expect(page.title).toBe(TITLE);
    expect(page.elements.find(({ tag }) => tag === "html")?.attributes).toEqual({ lang: "en" });
    expect(page.elements.filter(({ attributes }) => attributes["name"] === "viewport")).toEqual([
      { tag: "meta", attributes: { name: "viewport", content: "width=device-width, initial-scale=1" } },
    ]);
    expect(page.headings).toEqual([TITLE]);
    expect(page.components.map(({ heading }) => heading)).toEqual([`Component ${EARLIER}`, `Component ${COMPONENT}`]);
    expect(page.links).toHaveLength(3);
    for (const { text } of page.links) expect(text).not.toBe("");
  });

  it("draws components in ascending order of commit, and a component's records in ascending order of type and then of ID", async () => {
    const later = "f0".repeat(20);
    const types = ["claim", "counter-finding", "finding", "patch", "patch-re-check", "re-check", "recipe"];
    const records = [...types.map((type) => pathOf(COMPONENT, type, idOf("5"))), pathOf(COMPONENT, "finding", idOf("3"))];
    const artifacts = new FakeArtifacts();
    // No order of a tree's children is the page's to rely on, so the store gives each tree backwards.
    artifacts.reversedTrees = true;
    const { node } = await published(filesAt([pathOf(later, "claim", idOf("a")), ...records, PATCH]), undefined, artifacts);
    const page = await read(node.get(""));

    expect(page.components.map(({ heading }) => heading)).toEqual([EARLIER, COMPONENT, later].map((commit) => `Component ${commit}`));
    expect(page.components[1]?.records.map(({ text }) => text)).toEqual([
      `claim ${idOf("5")}`,
      `counter-finding ${idOf("5")}`,
      `finding ${idOf("3")}`,
      `finding ${idOf("5")}`,
      `patch ${idOf("5")}`,
      `patch-re-check ${idOf("5")}`,
      `re-check ${idOf("5")}`,
      `recipe ${idOf("5")}`,
    ]);
  });

  it("marks the first record of each type of a component and no other, and keeps the type in the text of every link", async () => {
    const records = [CLAIM, pathOf(COMPONENT, "finding", idOf("3")), FINDING, pathOf(COMPONENT, "finding", idOf("d")), PATCH];
    const { node } = await published(filesAt([...records, pathOf(EARLIER, "patch", idOf("e"))]));
    const page = await read(node.get(""));

    // The page shows a type beside the first of its records. A component's first record is the first of its type, whatever the component before it ended with.
    const marks = page.elements.filter(({ tag }) => tag === "li").map(({ attributes }) => attributes["class"] ?? "");
    expect(marks).toEqual(["first", "", "first", "first", "", ""]);
    expect(page.links.map(({ text }) => text)).toEqual([
      `patch ${idOf("c")}`,
      `patch ${idOf("e")}`,
      `claim ${idOf("a")}`,
      `finding ${idOf("3")}`,
      `finding ${idOf("b")}`,
      `finding ${idOf("d")}`,
    ]);
  });

  it("holds no list of facts when it has neither an address nor a head to draw", async () => {
    const node = await freshNode(new FakeArtifacts(), { ADMIN_KEY, NODE_URL: "" });
    const page = await read(node.get(""));

    expect(page.status).toBe(200);
    expect(page.elements.filter(({ tag }) => ["dl", "dt", "dd"].includes(tag))).toEqual([]);
    expect(page.texts).toContain(NOTHING_YET);
  });

  it("holds one link that is no record's: the project's name in the bar, which leads to the project's site", async () => {
    const site = [{ href: "https://cairnfield.net", text: "Cairnfield" }];
    const { artifacts, node } = await published(filesAt([CLAIM, FINDING, PATCH]));
    const page = await read(node.get(""));
    expect(page.bar).toEqual(site);
    expect(page.elements.filter(({ tag }) => tag === "a")).toHaveLength(page.links.length + 1);

    // A page with no record, and the answer of a node that cannot read its repo, hold that link and no other.
    const empty = await read((await freshNode(new FakeArtifacts())).get(""));
    vi.setSystemTime(START + 31 * SECOND);
    artifacts.getFailures = 1;
    const kept = await read(node.get(""));
    const failing = new FakeArtifacts();
    failing.getFailures = 1;
    const failed = await read((await freshNode(failing)).get(""));
    expect([empty.status, kept.status, failed.status]).toEqual([200, 200, 503]);
    for (const other of [empty, failed]) {
      expect(other.bar).toEqual(site);
      expect(other.elements.filter(({ tag }) => tag === "a")).toHaveLength(1);
    }
    expect(kept.html).toBe(page.html);
  });

  it("covers AE19: draws no file under the records folder whose name holds markup or is no record path, and has the same elements as without them", async () => {
    const records = filesAt([CLAIM, FINDING, PATCH]);
    const others: Files = {
      "records/notes.txt": "not a record\n",
      [`records/${COMPONENT}/claim/<img src=x onerror=alert(1)>.json`]: "{}",
      [`records/${COMPONENT}/claim/<script>alert(1)</script>.json`]: "{}",
      [`records/${COMPONENT}/"><b>finding</b>/${idOf("d")}.json`]: "{}",
      [`records/<h2>${COMPONENT}</h2>/claim/${idOf("d")}.json`]: "{}",
      // A type the protocol does not have, an ID of 63 characters, hashes in upper case, and a path that goes on after a record path.
      [pathOf(COMPONENT, "verdict", idOf("d"))]: "{}",
      [pathOf(COMPONENT, "claim", idOf("d").slice(1))]: "{}",
      [pathOf(COMPONENT, "claim", idOf("D"))]: "{}",
      [pathOf(COMPONENT.toUpperCase(), "claim", idOf("d"))]: "{}",
      [`${pathOf(COMPONENT, "claim", idOf("d"))}/more.json`]: "{}",
      [`${pathOf("2a".repeat(20), "claim", idOf("d"))}.txt`]: "{}",
    };
    const without = await published(records);
    const expected = await read(without.node.get(""));
    const { node, head } = await published({ ...records, ...others });
    const page = await read(node.get(""));

    // The node validates nothing, so its listing names every one of those files.
    const { body } = await answer(node.get("records"));
    expect((body as { records: unknown[] }).records).toHaveLength(Object.keys(records).length + Object.keys(others).length);
    expect(page.links).toHaveLength(3);
    expect(shapeOf(page)).toEqual(shapeOf(expected));
    // The two pages differ by the head they were drawn at, and by nothing else.
    expect(page.html.replaceAll(head, without.head)).toBe(expected.html);
  });

  it("writes a value that holds markup as text, so the page keeps its elements", async () => {
    // No Git hash holds markup. This store names its head with some, to show that the page escapes whatever it draws.
    const markup = `<b onmouseover="x('y')">&amp;</b>`;
    class MarkupHead extends FakeArtifacts {
      override async get(name: string): Promise<ArtifactsRepo> {
        const repo = await super.get(name);
        return { ...repo, log: async (opts) => (await repo.log(opts)).map((commit) => ({ ...commit, hash: markup })) };
      }
    }
    const expected = await read((await published(filesAt([CLAIM]))).node.get(""));
    const { node } = await published(filesAt([CLAIM]), undefined, new MarkupHead());
    const page = await read(node.get(""));

    expect(shapeOf(page)).toEqual(shapeOf(expected));
    expect(page.texts).toContain(markup);
    expect(page.links.map(({ text }) => text)).toEqual([`claim ${idOf("a")}`]);
  });

  it("covers AE20: answers 200 and says in fixed words that nothing is published, for a node with no team repo, a team repo still being made, a team repo with no push and a head with no records folder", async () => {
    const artifacts = new FakeArtifacts();
    const node = await freshNode(artifacts);
    const time = new Date(START).toISOString().replace(".000Z", "Z");
    const nothingYet = [...BAR, TITLE, ...ABOUT, ADDRESS, DRAWN, NOTHING_YET].sort();
    /** The page a request draws once the kept one has run out. */
    const next = async (): Promise<Page> => {
      vi.setSystemTime(Date.now() + 31 * SECOND);
      return read(node.get(""));
    };

    const noRepo = await read(node.get(""));
    expect(noRepo.status).toBe(200);
    expect(wordsOf(noRepo, [BASE, time])).toEqual(nothingYet);

    const team = await repoOf(node.admin("team-repo"));
    artifacts.unfinished(team);
    const beingMade = await next();
    expect(beingMade.status).toBe(200);
    expect(wordsOf(beingMade, [BASE, ...beingMade.times])).toEqual(nothingYet);

    artifacts.finish();
    const noPush = await next();
    expect(noPush.status).toBe(200);
    expect(wordsOf(noPush, [BASE, ...noPush.times])).toEqual(nothingYet);

    const head = await artifacts.push(team, "main", { "README.md": "The records of team A\n" });
    const noFolder = await next();
    expect(noFolder.status).toBe(200);
    expect(wordsOf(noFolder, [BASE, head, ...noFolder.times])).toEqual([...BAR, TITLE, ...ABOUT, ADDRESS, HEAD, DRAWN, NO_RECORD].sort());
    expect(noFolder.texts).toContain(head);

    for (const page of [noRepo, beingMade, noPush, noFolder]) {
      expect(page.links).toEqual([]);
      expect(page.components).toEqual([]);
      expect(page.headings).toEqual([TITLE]);
    }
  });

  it("serves the page it kept when Artifacts fails, and asks Artifacts again only after 30 seconds", async () => {
    const { artifacts, node, team, head } = await published(filesAt([CLAIM]));
    const kept = await read(node.get(""));
    expect(kept.texts).toContain(head);

    vi.setSystemTime(START + 31 * SECOND);
    const later = await artifacts.push(team, "main", filesAt([CLAIM, FINDING]));
    artifacts.getFailures = 1;
    const failed = await read(node.get(""));
    expect([failed.status, failed.html]).toEqual([200, kept.html]);

    // Artifacts would answer now. The failed walk is kept as any walk is, so it is not asked.
    vi.setSystemTime(START + 51 * SECOND);
    expect((await read(node.get(""))).html).toBe(kept.html);
    expect(artifacts.getFailures).toBe(0);

    vi.setSystemTime(START + 62 * SECOND);
    const again = await read(node.get(""));
    expect(again.status).toBe(200);
    expect(again.texts).toContain(later);
    expect(again.links).toHaveLength(2);
  });

  it("serves the last page a walk gave through one failed walk after another, until a walk succeeds", async () => {
    const { artifacts, node, team } = await published(filesAt([CLAIM]));
    const kept = await read(node.get(""));

    // Artifacts fails for longer than the node keeps a page. Each walk asks it once, and each serves the page of the last walk that ended well.
    for (const seconds of [31, 62, 93]) {
      vi.setSystemTime(START + seconds * SECOND);
      artifacts.getFailures = 1;
      const failed = await read(node.get(""));
      expect([failed.status, failed.html]).toEqual([200, kept.html]);
      expect(artifacts.getFailures).toBe(0);
    }

    vi.setSystemTime(START + 124 * SECOND);
    const later = await artifacts.push(team, "main", filesAt([CLAIM, FINDING]));
    const again = await read(node.get(""));
    expect(again.status).toBe(200);
    expect(again.texts).toContain(later);
    expect(drawnAt(again)).toBe(START + 124 * SECOND);
  });

  it("answers a failed walk without waiting on a walk before it that never ended", async () => {
    const { artifacts, node } = await published(filesAt([CLAIM]));
    // Artifacts never answers the first walk, so the page that walk would give is never there.
    artifacts.hangs = true;
    void node.get("");

    // The node has kept that walk for its 30 seconds. The next one fails, and it has no page of an earlier walk to serve.
    vi.setSystemTime(START + 31 * SECOND);
    artifacts.hangs = false;
    artifacts.getFailures = 1;
    const failed = await read(node.get(""));
    expect(failed.status).toBe(503);
    expect(drawnAt(failed)).toBe(START + 31 * SECOND);
  });

  it("serves the page of the later walk when Artifacts fails, though the walk before it ended after it", async () => {
    // This store holds one walk between its read of the head and its read of the tree, until the test lets it go.
    let hold: Promise<void> | undefined;
    let waiting = (): void => {};
    let letGo = (): void => {};
    class Holding extends FakeArtifacts {
      override async get(name: string): Promise<ArtifactsRepo> {
        const repo = await super.get(name);
        return {
          ...repo,
          log: async (opts) => {
            const commits = await repo.log(opts);
            const held = hold;
            hold = undefined;
            if (held) {
              waiting();
              await held;
            }
            return commits;
          },
        };
      }
    }
    const { artifacts, node, team, head } = await published(filesAt([CLAIM]), undefined, new Holding());
    const reached = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    hold = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const first = read(node.get(""));
    await reached;

    // The node has kept that walk for its 30 seconds, and the team has pushed. The next walk reads the new head and ends first.
    vi.setSystemTime(START + 31 * SECOND);
    const pushed = await artifacts.push(team, "main", filesAt([CLAIM, FINDING]));
    const later = await read(node.get(""));
    expect(later.texts).toContain(pushed);
    expect(drawnAt(later)).toBe(START + 31 * SECOND);

    // The first walk ends now, with the head it read before the push. Whoever waited on it gets its page.
    letGo();
    const earlier = await first;
    expect(earlier.texts).toContain(head);
    expect(drawnAt(earlier)).toBe(START);

    // The walk after both fails. The page that began later is the one the node serves.
    vi.setSystemTime(START + 62 * SECOND);
    artifacts.getFailures = 1;
    const failed = await read(node.get(""));
    expect([failed.status, failed.html]).toEqual([200, later.html]);
    expect(artifacts.getFailures).toBe(0);
  });

  it("answers 503 with fixed words when Artifacts fails and no page is kept, and keeps that answer for 30 seconds", async () => {
    const { artifacts, node, head } = await published(filesAt([CLAIM]));
    artifacts.getFailures = 1;
    const failed = await read(node.get(""));

    expect(failed.status).toBe(503);
    expect(wordsOf(failed, [BASE, ...failed.times])).toEqual([...BAR, TITLE, ...ABOUT, ADDRESS, DRAWN, UNREADABLE].sort());
    expect(drawnAt(failed)).toBe(START);
    expect(failed.links).toEqual([]);

    // Artifacts would answer now, and is not asked.
    vi.setSystemTime(START + 20 * SECOND);
    const second = await read(node.get(""));
    expect([second.status, second.html]).toEqual([503, failed.html]);

    // A second failure once that time has passed is a new answer, with its own time.
    vi.setSystemTime(START + 31 * SECOND);
    artifacts.getFailures = 1;
    const third = await read(node.get(""));
    expect(third.status).toBe(503);
    expect(drawnAt(third)).toBe(START + 31 * SECOND);

    vi.setSystemTime(START + 62 * SECOND);
    const fourth = await read(node.get(""));
    expect(fourth.status).toBe(200);
    expect(fourth.texts).toContain(head);
  });

  it("draws 20 of 21 components, and gives the number of the one it did not draw", async () => {
    const commits = Array.from({ length: 21 }, (_, at) => at.toString(16).padStart(2, "0").repeat(20));
    const { node } = await published(filesAt(commits.map((commit) => pathOf(commit, "claim", idOf("a")))));
    const page = await read(node.get(""));

    expect(page.components.map(({ heading }) => heading)).toEqual(commits.slice(0, 20).map((commit) => `Component ${commit}`));
    expect(page.links).toHaveLength(20);
    expect(page.texts.slice(page.texts.indexOf(COMPONENTS_LEFT))).toEqual([COMPONENTS_LEFT, "1", ALL_RECORDS]);
    expect(page.texts).not.toContain(RECORDS_LEFT);
  });

  it("draws 50 of a component's 51 records, and gives the number of the one it did not draw", async () => {
    const ids = Array.from({ length: 51 }, (_, at) => at.toString(16).padStart(64, "0"));
    const { node } = await published(filesAt(ids.map((id) => pathOf(COMPONENT, "claim", id))));
    const page = await read(node.get(""));

    expect(page.links.map(({ text }) => text)).toEqual(ids.slice(0, 50).map((id) => `claim ${id}`));
    expect(page.texts.slice(page.texts.indexOf(RECORDS_LEFT))).toEqual([RECORDS_LEFT, "1", ALL_RECORDS]);
    expect(page.texts).not.toContain(COMPONENTS_LEFT);
  });

  it("says only its own fixed words beside what it draws: the parts of each record path, the head, the node's address, the time it was drawn and each number it did not draw", async () => {
    const commits = Array.from({ length: 22 }, (_, at) => at.toString(16).padStart(2, "0").repeat(20));
    const ids = Array.from({ length: 53 }, (_, at) => at.toString(16).padStart(64, "0"));
    const [first = "", ...rest] = commits;
    const { node, head } = await published(
      filesAt([...ids.map((id) => pathOf(first, "finding", id)), ...rest.map((commit) => pathOf(commit, "claim", idOf("a")))]),
    );
    const page = await read(node.get(""));

    const values = [...commits, ...ids, idOf("a"), "claim", "finding", head, BASE, ...page.times, "2", "3"];
    // Each of the page's own words says what a thing on the page is. None tells a reader to do anything.
    const words = [...BAR, TITLE, ...ABOUT, ADDRESS, HEAD, DRAWN, "Component", RECORDS_LEFT, COMPONENTS_LEFT, ALL_RECORDS];
    expect(wordsOf(page, values)).toEqual([...words].sort());
    expect(drawnAt(page)).toBe(START);
    expect(page.links).toHaveLength(50 + 19);
  });

  it("is served under a policy that allows the page's one style by its hash and nothing else, and with headers that keep it out of caches, search engines and referrers", async () => {
    const { node } = await published(filesAt([CLAIM]));
    const page = await read(node.get(""));

    expect(page.elements.filter(({ tag }) => tag === "style")).toEqual([{ tag: "style", attributes: {} }]);
    const [, style = ""] = /<style>([\s\S]*?)<\/style>/.exec(page.html) ?? [];
    expect(style).not.toBe("");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style));
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(page.headers.get("content-security-policy")).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("holds no script element, no style attribute and no attribute whose name starts with `on`", async () => {
    const { node } = await published(filesAt([CLAIM, FINDING, PATCH]));
    const page = await read(node.get(""));

    expect(page.elements.length).toBeGreaterThan(10);
    expect(page.elements.filter(({ tag }) => tag === "script")).toEqual([]);
    const names = page.elements.flatMap(({ attributes }) => Object.keys(attributes));
    expect(names.filter((name) => name === "style" || name.startsWith("on"))).toEqual([]);
  });

  it("refuses a request with a query, and is no answer to another method", async () => {
    const { node } = await published(filesAt([CLAIM]));
    expect(await answer(node.get("?x=1"))).toEqual(BAD_REQUEST);
    expect(await answer(node.post(""))).toEqual(NOT_FOUND);
  });

  it("walks the team repo once for requests that arrive together and for a request within 30 seconds, and again after 30 seconds", async () => {
    const { artifacts, node, team } = await published(filesAt([CLAIM, FINDING]));

    const burst = await Promise.all(Array.from({ length: 5 }, () => node.get("")));
    expect(burst.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    const walk = artifacts.treeReads(team).length;
    expect(walk).toBeGreaterThan(0);

    vi.setSystemTime(START + 29 * SECOND);
    expect((await node.get("")).status).toBe(200);
    expect(artifacts.treeReads(team)).toHaveLength(walk);

    // One more walk reads as many trees as the first. Had the five walked each, it would read a fifth as many.
    vi.setSystemTime(START + 31 * SECOND);
    expect((await node.get("")).status).toBe(200);
    expect(artifacts.treeReads(team)).toHaveLength(2 * walk);
  });

  it("shows the time of the walk, and not of the request, on a kept copy served 20 seconds later", async () => {
    const { node } = await published(filesAt([CLAIM]));
    const first = await read(node.get(""));
    vi.setSystemTime(START + 20 * SECOND);
    const second = await read(node.get(""));

    expect(drawnAt(first)).toBe(START);
    expect(drawnAt(second)).toBe(START);
    expect(second.html).toBe(first.html);
  });

  it("leaves the records route its own read: after a push it answers the new head at once, while the page still shows the kept copy", async () => {
    const { artifacts, node, team, head } = await published(filesAt([CLAIM]));
    const kept = await read(node.get(""));
    const pushed = await artifacts.push(team, "main", filesAt([CLAIM, FINDING]));

    expect(await answer(node.get("records"))).toMatchObject({ status: 200, body: { head: pushed } });
    const page = await read(node.get(""));
    expect(page.html).toBe(kept.html);
    expect(page.texts).toContain(head);
    expect(page.texts).not.toContain(pushed);
  });

  it("draws the node's address only when it is the node's origin in the accepted spelling", async () => {
    const drawn = await read((await published(filesAt([CLAIM]))).node.get(""));
    expect(drawn.texts.slice(drawn.texts.indexOf(ADDRESS), drawn.texts.indexOf(ADDRESS) + 2)).toEqual([ADDRESS, BASE]);

    const others: readonly (readonly [why: string, address: string])[] = [
      ["no address", ""],
      ["an address with a path", "https://nodes.cairnfield.example/team-a"],
      ["an address with a slash at its end", `${BASE}/`],
    ];
    for (const [why, address] of others) {
      const { node } = await published(filesAt([CLAIM]), { ADMIN_KEY, NODE_URL: address });
      const page = await read(node.get(""));
      expect(page.status, why).toBe(200);
      expect(page.texts, why).not.toContain(ADDRESS);
      expect(page.html, why).not.toContain(".example");
    }
  });
});

// The page follows the reader's color scheme. Its one style holds every color it paints
// with as a token of the palette on `:root`, and one block gives those tokens other values
// for a reader whose system asks for dark. So a rule reads the same in both schemes, and
// the dashed outline of a component stands in both. No test opens the page in a browser,
// so these read the style as text and work out each contrast from its two palettes.

/** The rules of a style, each as its selectors and what it sets: every property with its value. */
function rulesOf(style: string): { selectors: string[]; set: string[][] }[] {
  const rules = [...style.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules.map(([, selectors = "", set = ""]) => ({
    selectors: selectors.split(",").map((one) => one.trim()),
    set: set.split(";").flatMap((one) => (one.includes(":") ? [[one.slice(0, one.indexOf(":")).trim(), one.slice(one.indexOf(":") + 1).trim()]] : [])),
  }));
}

const DARK_BLOCK = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;

/** One rule of a style, as `rulesOf` reads it. */
type Rule = ReturnType<typeof rulesOf>[number];

/** A style in three parts: what its `:root` rules set, the rules of each block for a dark scheme, and every other rule. */
function schemesOf(style: string): { root: string[][][]; dark: Rule[][]; rest: Rule[] } {
  const outside = rulesOf(style.replace(DARK_BLOCK, ""));
  const isRoot = ({ selectors }: Rule): boolean => selectors.join() === ":root";
  return { root: outside.filter(isRoot).map(({ set }) => set), dark: [...style.matchAll(DARK_BLOCK)].map(([, inside = ""]) => rulesOf(inside)), rest: outside.filter((rule) => !isRoot(rule)) };
}

/** A color of a palette: its three channels, and how much of it covers what lies under it. */
interface Color {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

/** A color as the palette writes one, with six hex digits or as `rgba()`. Nothing for a value that is no color, as a font stack is none. */
function colorOf(value: string): Color | undefined {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    const [, red = "", green = "", blue = ""] = hex;
    return { red: parseInt(red, 16), green: parseInt(green, 16), blue: parseInt(blue, 16), alpha: 1 };
  }
  const [, red, green, blue, alpha] = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value) ?? [];
  return red === undefined ? undefined : { red: Number(red), green: Number(green), blue: Number(blue), alpha: Number(alpha) };
}

/** A color that lets the one under it through, as the two show together. */
function over(top: Color, under: Color): Color {
  const mixed = (above: number, below: number): number => Math.round(above * top.alpha + below * (1 - top.alpha));
  return { red: mixed(top.red, under.red), green: mixed(top.green, under.green), blue: mixed(top.blue, under.blue), alpha: 1 };
}

/** How light a color is, as WCAG 2 measures it. */
function luminance({ red, green, blue }: Color): number {
  const linear = (channel: number): number => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** The contrast of two colors, as WCAG 2 measures it: from 1 for the same color to 21 for black on white. */
function ratio(one: Color, other: Color): number {
  const [lighter = 0, darker = 0] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The colors a rule sets as tokens, by token. */
const tokensOf = (set: string[][] = []): Map<string, Color> =>
  new Map(
    set.flatMap(([token = "", value = ""]) => {
      const color = colorOf(value);
      return color ? [[token, color] as const] : [];
    }),
  );

/** The style's two palettes. A token that the dark block does not set keeps its color in a dark scheme. */
function palettesOf(style: string): { light: Map<string, Color>; dark: Map<string, Color> } {
  const { root, dark } = schemesOf(style);
  const light = tokensOf(root[0]);
  return { light, dark: new Map([...light, ...tokensOf(dark[0]?.[0]?.set)]) };
}

/** A color of a palette by its token. A palette that does not hold it fails the test that asks. */
function held(palette: Map<string, Color>, token: string): Color {
  const color = palette.get(token);
  if (!color) throw new Error(`the palette holds no color ${token}`);
  return color;
}

/** The contrast of a token against a ground. The ground is named from its top down, so a translucent token lies over the one named after it. */
function contrast(palette: Map<string, Color>, token: string, ...ground: string[]): number {
  const under = ground.map((name) => held(palette, name)).reduceRight((below, layer) => over(layer, below));
  return ratio(over(held(palette, token), under), under);
}

describe("the node's page in a light and a dark scheme", () => {
  /** The page's three grounds, from darkest to lightest: the page, the head of a block, a block. */
  const GROUNDS = ["--fog", "--band", "--paper"];

  /** The page's one style, as a node serves it. */
  async function styleOf(): Promise<string> {
    const { node } = await published(filesAt([CLAIM]));
    const [, style = ""] = /<style>([\s\S]*?)<\/style>/.exec((await read(node.get(""))).html) ?? [];
    expect(style).not.toBe("");
    return style;
  }

  it("holds its dark look in its one style, as one block that gives colors of the palette other values and sets nothing else", async () => {
    const style = await styleOf();
    const { root, dark } = schemesOf(style);
    // One palette, and one block for a dark scheme with one rule in it.
    expect(style.match(/prefers-color-scheme/g)).toHaveLength(1);
    expect(root).toHaveLength(1);
    expect(dark.map((rules) => rules.map(({ selectors }) => selectors))).toEqual([[[":root"]]]);
    const light = tokensOf(root[0]);
    const set = dark[0]?.[0]?.set ?? [];
    expect(set.length).toBeGreaterThan(0);
    // Each thing it sets is a token that the palette holds as a color, and it sets a color.
    for (const [token = "", value = ""] of set) expect([token, token.startsWith("--"), light.has(token), colorOf(value) !== undefined]).toEqual([token, true, true, true]);
    // Beside its tokens the palette tells the browser that the page has both looks, and nothing else.
    expect((root[0] ?? []).filter(([property = ""]) => !property.startsWith("--"))).toEqual([["color-scheme", "light dark"]]);
  });

  it("writes out no color where it is used, apart from the shade of the stone before the node's address", async () => {
    const values = schemesOf(await styleOf()).rest.flatMap(({ set }) => set.map(([, value = ""]) => value));
    expect(values.filter((value) => /#[0-9a-f]{3,8}\b/i.test(value))).toEqual([]);
    // Black at part strength reads as a shade on the stone's own color in both schemes.
    expect(values.flatMap((value) => value.match(/(?:rgb|hsl)a?\([^)]*\)/g) ?? [])).toEqual(["rgba(0, 0, 0, .17)"]);
  });

  it("keeps text readable on every ground it stands on, in both schemes", async () => {
    const text: string[][] = [
      ...[...GROUNDS, "--note"].map((ground) => ["--ink", ground]),
      ...GROUNDS.map((ground) => ["--muted", ground]),
      // The bar and the hero let the page's ground through.
      ...["--bar", "--veil"].flatMap((ground) => [["--ink", ground, "--fog"], ["--muted", ground, "--fog"]]),
    ];
    const { light, dark } = palettesOf(await styleOf());
    for (const [token = "", ...ground] of text) {
      expect([token, ...ground, "light", contrast(light, token, ...ground) >= 4.5]).toEqual([token, ...ground, "light", true]);
      expect([token, ...ground, "dark", contrast(dark, token, ...ground) >= 4.5]).toEqual([token, ...ground, "dark", true]);
    }
  });

  it("draws the dashed outline of a component, a link's underline and the focus ring no fainter in a dark scheme than in a light one", async () => {
    const outlines: string[][] = [...GROUNDS.map((ground) => ["--line", ground]), ...["--fog", "--paper"].map((ground) => ["--mark", ground])];
    const { light, dark } = palettesOf(await styleOf());
    for (const [token = "", ground = ""] of outlines) expect([token, ground, contrast(dark, token, ground) >= contrast(light, token, ground)]).toEqual([token, ground, true]);
    for (const ground of GROUNDS) {
      expect([ground, "light", contrast(light, "--focus", ground) >= 3]).toEqual([ground, "light", true]);
      expect([ground, "dark", contrast(dark, "--focus", ground) >= 3]).toEqual([ground, "dark", true]);
    }
  });

  it("keeps the page's ground the darkest of its grounds in both schemes, under the head of a block and under a block", async () => {
    for (const [scheme, palette] of Object.entries(palettesOf(await styleOf()))) {
      const lightness = GROUNDS.map((ground) => luminance(held(palette, ground)));
      expect([scheme, lightness.every((value, at) => at === 0 || value > (lightness[at - 1] ?? 1))]).toEqual([scheme, true]);
    }
  });

  it("serves one document whatever scheme a reader's browser says it prefers, and asks a browser for no such word", async () => {
    const asked = async (headers?: { readonly [name: string]: string }): Promise<Page> => read((await published(filesAt([CLAIM, FINDING]))).node.get("", headers));
    // Each node is in an isolate of its own, so none serves a page that another one kept.
    const [plain, dark, light] = [await asked(), await asked({ "sec-ch-prefers-color-scheme": "dark" }), await asked({ "sec-ch-prefers-color-scheme": "light" })];
    expect(dark.html).toBe(plain.html);
    expect(light.html).toBe(plain.html);
    expect(dark.headers.get("content-security-policy")).toBe(plain.headers.get("content-security-policy"));
    for (const name of ["vary", "accept-ch", "critical-ch"]) expect([name, dark.headers.get(name)]).toEqual([name, null]);
  });
});
