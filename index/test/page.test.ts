// The public pages (R14, R15, R16): what the page of one component commit shows, and what
// the index's own page shows. A page's script reads only a data endpoint (KTD14). So each
// test asks the index for a view or for its list as the script does, and hands the answer
// to the functions that script calls. They give the page as a tree of elements, which the
// script turns into the document. The words and links a page holds apart from that are
// written in its HTML file, and a test reads them there. No test runs a browser.

import { VIEW, conforms, recordId } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NOTHING_READ, draw, placeOf, readOf } from "../src/page/render.ts";
import type { Drawing, Drawn, Held, Place } from "../src/page/render.ts";
import { BRANCH, FILES, HOST, INDEX, NODE_A, NODE_B, NODE_C, README, README_TEXT, SKILL, SKILL_FIXED, SKILL_TEXT, OTHER_UPSTREAM, START, UPSTREAM, bench, claim, clockAt, demoPlugin, edited, finding, fixture, fixturesUnder, freshIndexForEachTest, idOf, onReadme, patchRecord, publishPatch, synced, threeComponents } from "./bench.ts";
import type { Bench } from "./bench.ts";
import { FakeNode, nodesBehindFetch } from "./fake-node.ts";

const MINUTE = 60_000;

freshIndexForEachTest();

// The page, as its script reads and draws it.

/** What the page at an address reads, as the script works it out from the address. */
function placeAt(address: string): Place {
  const url = new URL(address, INDEX);
  const place = placeOf(url.pathname, url.search);
  if (!place) throw new Error(`no page stands at ${address}`);
  return place;
}

/** A page as its first read draws it. The body is handed over as the index would serve it. */
function firstDrawing(place: Place, served: unknown): Drawing {
  const { body } = draw(place, NOTHING_READ, readOf(JSON.parse(JSON.stringify(served))), START);
  if (!body) throw new Error("the first read drew no page");
  return body;
}

/** One read by the page at an address: the script asks the index for what its address names, a view or the list, and draws the answer. */
async function read(on: Bench, address: string, held: Held = NOTHING_READ, now: number = START): Promise<Drawn> {
  const place = placeAt(address);
  const { body } = await on.call("GET", place.viewPath);
  return draw(place, held, readOf(body), now);
}

/** The page of a component as its first read draws it. `query` is the query of the page's address. */
async function pageOf(on: Bench, component: string, query = ""): Promise<Drawing> {
  const { body } = await read(on, `/components/${component}${query}`);
  if (!body) throw new Error("the first read drew no page");
  return body;
}

// Reading the tree.

const isElement = (node: Drawing | string): node is Drawing => typeof node !== "string";

/** An element and every element under it, in the order of the document. */
function elements(root: Drawing | undefined): Drawing[] {
  return root === undefined ? [] : [root, ...root.children.filter(isElement).flatMap(elements)];
}

/** Every text under a node, in the order of the document. */
function texts(node: Drawing | string | undefined): string[] {
  if (node === undefined) return [];
  return isElement(node) ? node.children.flatMap(texts) : [node];
}

/** What a reader reads under a node. */
const textOf = (node: Drawing | undefined): string => texts(node).join("");

const classesOf = (element: Drawing): string[] => (element.attributes["class"] ?? "").split(" ");
const withClass = (root: Drawing | undefined, name: string): Drawing[] => elements(root).filter((element) => classesOf(element).includes(name));
const withTag = (root: Drawing | undefined, tag: string): Drawing[] => elements(root).filter((element) => element.tag === tag);
const byId = (root: Drawing | undefined, id: string): Drawing | undefined => elements(root).find((element) => element.attributes["id"] === id);

/** A node's address as a page shows it: an HTTPS address without its scheme. The link under it carries the whole address. */
const asShown = (node: string): string => node.replace(/^https:\/\//, "");

/** Where the protocol defines the criteria and the observations. It is the one address a component's page holds that no record names. */
const PROTOCOL = "https://github.com/peoplerenaissance/cairnfield/blob/main/reference/protocol.md#criteria-and-observations";

/** The status labels on an element, each as a reader reads it. */
const tagsOf = (root: Drawing | undefined): string[] => withClass(root, "tag").map(textOf);

/** The counts at the head of a page, each as its number and the word for what it counts. */
const countsOf = (root: Drawing | undefined): string[][] =>
  withClass(root, "counts").flatMap((list) => list.children.filter(isElement)).map((count) => [textOf(theOne(withTag(count, "dd"), "")), texts(theOne(withTag(count, "dt"), ""))[0] ?? ""]);

/** The one element under a root that a test names, by what it reads. */
function theOne(found: readonly Drawing[], holding: string): Drawing {
  const [only, ...more] = found.filter((element) => textOf(element).includes(holding));
  if (only === undefined || more.length > 0) throw new Error(`${more.length + (only ? 1 : 0)} elements hold "${holding}"`);
  return only;
}

/** The hosts a page links to, and the places in itself. */
const linksOf = (root: Drawing | undefined): string[] => withTag(root, "a").map((link) => link.attributes["href"] ?? "");

/** A view with every string that equals `from` replaced by `to`, wherever it stands. */
function replaced<T>(value: T, from: string, to: string): T {
  if (value === from) return to as T;
  if (Array.isArray(value)) return value.map((item: unknown) => replaced(item, from, to)) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, held]) => [key, replaced(held, from, to)])) as T;
}

/** One index with two registered nodes behind `fetch` and the small component, ready. */
async function twoNodes(): Promise<{ on: Bench; one: FakeNode; other: FakeNode; component: string }> {
  const on = bench();
  const [one, other] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
  nodesBehindFetch(one, other);
  const component = await on.component();
  await on.registerNode(NODE_A);
  await on.registerNode(NODE_B);
  return { on, one, other, component };
}

describe("a version with little to show (R14)", () => {
  it("shows 'No reviews published for this version' for a commit that is not registered", async () => {
    const on = bench();
    const unknown = "9a".repeat(20);

    const page = await pageOf(on, unknown);
    expect(textOf(page)).toContain("No reviews published for this version");
    // The version is named, and nothing is said about work on it.
    expect(textOf(page)).toContain(unknown);
    for (const section of ["claims", "findings", "patches", "recipes", "rejected"]) expect(byId(page, section)).toBeUndefined();
    expect(textOf(page)).not.toContain("No findings published");
  });

  it("shows 'No findings published' for a known commit with no findings, and never the word 'clean'", async () => {
    const on = bench();
    const component = await on.component();

    const drawn = await read(on, `/components/${component}`);
    expect(textOf(byId(drawn.body, "findings"))).toContain("No findings published");
    expect(textOf(drawn.body)).not.toContain("No reviews published for this version");
    // Nothing the page says reads as an all-clear: not what it draws, and not the page as it is served.
    expect(textOf(drawn.body)).not.toMatch(/clean/i);
    expect(textOf(drawn.status)).not.toMatch(/clean/i);
    expect(env.PAGE_FILES["page.html"]).not.toMatch(/clean/i);
    // The index holds its copy and checked against it, so the head counts all three, each of them nought here.
    expect(countsOf(drawn.body)).toEqual([
      ["0", "organizations"],
      ["0", "findings"],
      ["0", "patches"],
    ]);
  });

  it("gives a copy that is still importing and an import that failed each a label of its own, and never 'No findings published'", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.deliver();
    expect((await on.view(commit)).state).toBe("importing");

    const importing = await pageOf(on, commit);
    expect(textOf(byId(importing, "state"))).toContain("The index is still importing this version");
    expect(tagsOf(byId(importing, "state"))).toEqual(["importing"]);
    expect(textOf(importing)).not.toContain("No findings published");

    // The copy is not ready when its time is up, so the import is given up.
    clockAt(START + 6 * MINUTE);
    await on.drain();
    expect((await on.view(commit)).state).toBe("failed");

    const failed = await pageOf(on, commit);
    expect(textOf(byId(failed, "state"))).toContain("The index could not import this version");
    expect(tagsOf(byId(failed, "state"))).toEqual(["failed"]);
    expect(textOf(failed)).not.toContain("No findings published");
    expect(textOf(failed)).not.toContain("still importing");
    // Neither says anything about findings, patches or recipes: the index checked nothing against a copy.
    for (const page of [importing, failed]) {
      for (const section of ["claims", "findings", "patches", "recipes"]) expect(byId(page, section)).toBeUndefined();
      // The head keeps the Git URL, the commit and the organizations. It counts no findings and no patches: a nought there would read as an all-clear.
      const [head] = withTag(page, "header");
      expect(textOf(theOne(withTag(head, "h1"), UPSTREAM))).toBe(UPSTREAM);
      expect(textOf(head)).toContain(commit);
      expect(countsOf(head)).toEqual([["0", "organizations"]]);
      expect(textOf(head)).not.toMatch(/finding|patch/i);
    }
  });

  it("shows a record the index is still checking as pending, with its node and its type", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const [cited] = await node.publish(finding(component));
    // The node does not serve the commit this patch record names, so the record waits.
    const [waiting = ""] = await node.publish(patchRecord(component, "3d".repeat(20), [cited]));
    await synced(on, NODE_A);
    expect((await on.view(component)).pending).toEqual([{ node: NODE_A, hash: waiting, type: "patch" }]);

    const page = await pageOf(on, component);
    const [row, ...more] = withTag(byId(page, "pending"), "li");
    expect(more).toEqual([]);
    expect(textOf(row)).toContain(asShown(NODE_A));
    expect(textOf(row)).toContain("patch");
    expect(textOf(row)).toContain(waiting.slice(0, 8));
    expect(tagsOf(row)).toEqual(["pending"]);
    // It is no patch yet.
    expect(withClass(byId(page, "patches"), "patch")).toEqual([]);
    expect(textOf(byId(page, "patches"))).toContain("No patches published");
  });

  it("draws no pending section and no rejected section when the view holds no such work", async () => {
    const on = bench();
    const component = await on.component();
    const page = await pageOf(on, component);
    expect(byId(page, "pending")).toBeUndefined();
    expect(byId(page, "rejected")).toBeUndefined();
  });
});

describe("the sections of a page (R14)", () => {
  it("come in the origin's order: live claims, findings, patches, recipes, rejected work", async () => {
    const { on, one, component } = await twoNodes();
    await one.publish(finding(component, { location: { path: README, start: 400, end: 410 } }));
    await synced(on, NODE_A);

    const page = await pageOf(on, component);
    const order = elements(page).flatMap((element) => (element.tag === "section" ? (element.attributes["id"] ?? []) : []));
    expect(order).toEqual(["claims", "findings", "patches", "recipes", "rejected"]);
    expect(withTag(page, "h2").map(textOf)).toEqual(["Live claims", "Findings", "Patches", "Recipes", "Rejected work"]);
  });

  it("heads the page with the component's Git URL, its commit and counts of organizations, findings and patches", async () => {
    const { on, one, other, component } = await twoNodes();
    await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    await other.publish(finding(component, onReadme(12)));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const [head] = withTag(await pageOf(on, component), "header");
    expect(textOf(theOne(withTag(head, "h1"), UPSTREAM))).toBe(UPSTREAM);
    expect(textOf(head)).toContain(component);
    expect(countsOf(head)).toEqual([
      ["2", "organizations"],
      ["2", "findings"],
      ["1", "patch"],
    ]);
  });
});

describe("live claims (R15, KTD15)", () => {
  it("shows a live claim, and neither a closed claim nor an expired one", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    const closed = { ...claim(component, 1), check: "code" };
    const expired = { ...claim(component, 2), check: "instructions" };
    // A finding cites the first claim, which closes it. Nothing cites the second.
    await node.publish(closed, expired, finding(component, { claim: await recordId(closed) }));
    await synced(on, NODE_A);
    clockAt(START + 15 * MINUTE);
    const live = { ...claim(component, 3), check: "permissions" };
    await node.publish(live);
    await synced(on, NODE_A);
    expect((await on.view(component)).claims.map(({ state, record }) => [state, record.check]).sort()).toEqual([
      ["closed", "code"],
      ["expired", "instructions"],
      ["live", "permissions"],
    ]);

    const section = byId(await pageOf(on, component), "claims");
    const [shown, ...more] = withClass(section, "claim");
    expect(more).toEqual([]);
    expect(textOf(shown)).toContain(asShown(NODE_A));
    expect(textOf(shown)).toContain("review");
    expect(textOf(shown)).toContain("permissions");
    expect(tagsOf(shown)).toEqual(["live"]);
    expect(textOf(section)).toContain("1 live");
    expect(textOf(section)).not.toContain("instructions");
    expect(textOf(section)).not.toContain("code");
    expect(textOf(section)).not.toMatch(/closed|expired/);
  });

  it("says that no claim is live when none is", async () => {
    const on = bench();
    const component = await on.component();
    expect(textOf(byId(await pageOf(on, component), "claims"))).toContain("No live claims");
  });

  it("shows what a live patch claim is for: its intent, and a link to each finding it names", async () => {
    const { on, one, component } = await twoNodes();
    const [cited = ""] = await one.publish(finding(component));
    await one.publish({ version: "1", type: "claim", component, kind: "patch", number: 1, findings: [cited], intent: "competing" });
    await synced(on, NODE_A);

    // A second claim names a finding that the view does not hold.
    const absent = "b".repeat(64);
    await one.publish({ version: "1", type: "claim", component, kind: "patch", number: 2, findings: [absent], intent: "new" });
    await synced(on, NODE_A);

    const page = await pageOf(on, component);
    const shown = theOne(withClass(byId(page, "claims"), "claim"), "competing");
    expect(textOf(shown)).toContain("patch");
    expect(linksOf(shown)).toContain(`#finding-${cited}`);
    expect(byId(page, `finding-${cited}`)).toBeDefined();
    // That finding is named by its ID, and nothing links to an entry the page does not have.
    const other = theOne(withClass(byId(page, "claims"), "claim"), `finding ${absent.slice(0, 8)}`);
    expect(linksOf(other).filter((href) => href.startsWith("#"))).toEqual([]);
    expect(byId(page, `finding-${absent}`)).toBeUndefined();
  });
});

describe("findings (R14)", () => {
  it("labels a finding with one organization behind it 'unconfirmed', and one with two 'confirmed by 2'", async () => {
    const { on, one, other, component } = await twoNodes();
    const sends = { observation: "sends-data-to-host", host: HOST };
    await one.publish(finding(component), finding(component, sends));
    // The second team saw the same thing on lines that overlap the first team's.
    await other.publish(finding(component, { ...sends, location: { path: SKILL, start: 2, end: 3 } }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const rows = withClass(byId(await pageOf(on, component), "findings"), "finding");
    expect(rows).toHaveLength(2);
    const alone = theOne(rows, "hidden instruction");
    expect(tagsOf(alone)).toEqual(["unconfirmed"]);
    expect(textOf(alone)).toContain(asShown(NODE_A));
    expect(textOf(alone)).not.toContain(asShown(NODE_B));
    const shared = theOne(rows, "This component sends data to ");
    expect(tagsOf(shared)).toEqual(["confirmed by 2"]);
    expect(textOf(shared)).toContain(asShown(NODE_A));
    expect(textOf(shared)).toContain(asShown(NODE_B));
    expect(textOf(shared)).toContain(HOST);
  });

  it("shows where a finding points: its path and lines, and the line it contradicts", async () => {
    const { on, one, component } = await twoNodes();
    await one.publish(
      finding(component, { location: { path: README, start: 11, end: 13 }, criterion: "works-as-documented", observation: "documented-control-not-read", contradicts: { path: SKILL, start: 2, end: 2 }, check: "code" }),
    );
    await synced(on, NODE_A);

    const [row] = withClass(byId(await pageOf(on, component), "findings"), "finding");
    expect(textOf(row)).toContain("This component acts without reading a setting that its documentation says controls it.");
    expect(textOf(row)).toContain(`${README}lines 11–13`);
    expect(textOf(row)).toContain(`contradicts ${SKILL}line 2`);
  });

  it("groups findings by the criterion they name, in the order of the criteria", async () => {
    const { on, one, other, component } = await twoNodes();
    await one.publish(
      finding(component, { ...onReadme(5), criterion: "works-as-documented", observation: "fails-on-documented-input", check: "code" }),
      finding(component, { ...onReadme(7), criterion: "safe-to-run-with-access", observation: "runs-shell-command", check: "code" }),
      finding(component),
    );
    await other.publish(finding(component, { ...onReadme(9), criterion: "safe-to-run-with-access", observation: "reads-outside-workspace", check: "code" }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const section = byId(await pageOf(on, component), "findings");
    expect(withTag(section, "h3").map(textOf)).toEqual(["Counts against safe-to-read", "Counts against safe-to-run-with-access", "Counts against works-as-documented"]);
    // Each heading is followed by the findings that name its criterion.
    const lists = withTag(section, "ul").filter((list) => classesOf(list).includes("findings"));
    expect(lists.map((list) => withClass(list, "finding").length)).toEqual([1, 2, 1]);
    expect(textOf(lists[0])).toContain("This component contains a hidden instruction for an agent.");
    expect(textOf(lists[2])).toContain("This component fails on an input that its documentation says works.");
  });

  it("puts the findings that more organizations report first under a criterion, and leaves the others in the order of the view", async () => {
    const { on, one, other, component } = await twoNodes();
    const under = { criterion: "safe-to-run-with-access", check: "code" };
    await one.publish(
      finding(component, { ...onReadme(5), ...under, observation: "runs-shell-command" }),
      finding(component, { ...onReadme(7), ...under, observation: "reads-outside-workspace" }),
      finding(component, { ...onReadme(9), ...under, observation: "writes-outside-workspace" }),
    );
    // The second team reports one of the three as well.
    await other.publish(finding(component, { ...onReadme(9), ...under, observation: "writes-outside-workspace" }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const says: { readonly [observation: string]: string } = {
      "runs-shell-command": "This component runs a shell command.",
      "reads-outside-workspace": "This component reads files outside the workspace.",
      "writes-outside-workspace": "This component writes files outside the workspace.",
    };
    const inTheView = (await on.view(component)).findings.map(({ observation }) => says[observation]);
    const rows = withClass(byId(await pageOf(on, component), "findings"), "finding");
    expect(rows.map(tagsOf)).toEqual([["confirmed by 2"], ["unconfirmed"], ["unconfirmed"]]);
    // The one that two organizations report stands first, wherever the view holds it.
    expect(rows.map((row) => texts(withTag(row, "strong")[0])[0])).toEqual([says["writes-outside-workspace"], ...inTheView.filter((said) => said !== says["writes-outside-workspace"])]);
    // The section says in its own words how it is ordered.
    expect(textOf(byId(await pageOf(on, component), "findings"))).toContain("The ones more organizations report stand first");
  });

  it("counts the organizations behind a finding for the criterion it sits under", async () => {
    const { on, one, other, component } = await twoNodes();
    // Both teams saw the hidden instruction. One says it breaks the weakest criterion, the other a stricter one.
    await one.publish(finding(component));
    await other.publish(finding(component, { location: { path: SKILL, start: 2, end: 3 }, criterion: "safe-to-run-sandboxed" }));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const rows = withClass(byId(await pageOf(on, component), "findings"), "finding");
    expect(rows).toHaveLength(2);
    // One organization says it breaks safe-to-read. Its finding counts against the stricter criterion too (R5, R10).
    expect(tagsOf(rows[0])).toEqual(["unconfirmed"]);
    expect(textOf(rows[0])).not.toContain(asShown(NODE_B));
    expect(tagsOf(rows[1])).toEqual(["confirmed by 2"]);
  });

  it("shows a counter-finding beside the finding it disputes, and keeps both", async () => {
    const on = bench();
    const [one, third] = [new FakeNode(NODE_A), new FakeNode(NODE_C)];
    nodesBehindFetch(one, third);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_C);
    const [target] = await one.publish(finding(component));
    await third.publish({ version: "1", type: "counter-finding", component, finding: target, reason: "documented-behavior", cites: { path: README, start: 30, end: 30 }, model: "none" });
    await synced(on, NODE_A);
    await synced(on, NODE_C);

    const [row, ...more] = withClass(byId(await pageOf(on, component), "findings"), "finding");
    expect(more).toEqual([]);
    expect(textOf(row)).toContain("hidden instruction");
    const dispute = theOne(withClass(row, "dispute"), asShown(NODE_C));
    expect(textOf(dispute)).toContain("documented behavior");
    expect(textOf(dispute)).toContain(`${README}line 30`);
    // A dispute changes no count.
    expect(tagsOf(row)).toEqual(["unconfirmed"]);
  });
});

describe("patches (R16)", () => {
  /** The foot of a patch's entry, as a reader reads it: the patch, and what it is for. */
  const footOf = (entry: Drawing | undefined): string => textOf(theOne(withClass(entry, "foot"), "patch "));
  /** The places on the page that a patch's entry links to. */
  const placesFrom = (entry: Drawing | undefined): string[] => linksOf(entry).filter((href) => href.startsWith("#"));

  it("covers AE3: lists both organizations on a patch that two teams wrote identically, as one entry that names the finding of both once", async () => {
    const { on, one, other, component } = await twoNodes();
    const first = await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    const second = await publishPatch(other, component, { location: { path: SKILL, start: 2, end: 3 } }, [{ path: SKILL, content: SKILL_FIXED }]);
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const page = await pageOf(on, component);
    const [entry, ...more] = withClass(byId(page, "patches"), "patch");
    expect(more).toEqual([]);
    expect(textOf(entry)).toContain(asShown(NODE_A));
    expect(textOf(entry)).toContain(asShown(NODE_B));
    expect(tagsOf(entry)).toEqual(["removes only", "confirmed by 2"]);
    const id = await idOf(SKILL_TEXT, SKILL_FIXED);
    expect(entry?.attributes["id"]).toBe(`patch-${id}`);

    // Each team's patch record names its own team's finding record. The two records are one finding on the page.
    expect(first.finding).not.toBe(second.finding);
    const [seen, ...others] = withClass(byId(page, "findings"), "finding");
    expect(others).toEqual([]);
    for (const record of [first.finding, second.finding]) expect(elements(seen)).toContain(byId(page, `finding-${record}`));
    // So the entry names that finding once, and its one link leads to a record of it that the patch names.
    expect(footOf(entry)).toBe(`patch ${id.slice(0, 8)}for hidden instruction`);
    const [target = "", ...targets] = placesFrom(entry);
    expect(targets).toEqual([]);
    expect([`#finding-${first.finding}`, `#finding-${second.finding}`]).toContain(target);
  });

  it("links a patch once to each finding its records name, when they name two, and in one order on every read", async () => {
    const { on, one, other, component } = await twoNodes();
    // Line 3 of the skill file hides an instruction, and the instruction names a host. Each team saw both and took the line out.
    const sends = { observation: "sends-data-to-host", host: HOST };
    for (const [node, where] of [[one, {}], [other, { location: { path: SKILL, start: 2, end: 3 } }]] as const) {
      const cited = await node.publish(finding(component, where), finding(component, { ...sends, ...where }));
      await node.publish(patchRecord(component, await node.patchCommit(component, [{ path: SKILL, content: SKILL_FIXED }]), cited));
    }
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const page = await pageOf(on, component);
    const [entry, ...more] = withClass(byId(page, "patches"), "patch");
    expect(more).toEqual([]);
    expect(tagsOf(entry)).toEqual(["removes only", "confirmed by 2"]);
    // The two records of the patch name four finding records, two of each finding on the page.
    const rows = withClass(byId(page, "findings"), "finding");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(withTag(theOne(withClass(row, "where"), ""), "li")).toHaveLength(2);

    const links = withTag(entry, "a").filter((link) => (link.attributes["href"] ?? "").startsWith("#"));
    expect(links.map(textOf).sort()).toEqual(["hidden instruction", "sends data to host"]);
    // Each link leads into the entry of one finding, and the two lead into two.
    const led = links.map((link) => rows.filter((row) => elements(row).some((element) => `#${element.attributes["id"]}` === link.attributes["href"])));
    expect(led.map((entries) => entries.length)).toEqual([1, 1]);
    expect(new Set(led.flat()).size).toBe(2);

    const again = byId(await pageOf(on, component), entry?.attributes["id"] ?? "");
    expect(placesFrom(again)).toEqual(placesFrom(entry));
    expect(footOf(again)).toBe(footOf(entry));
  });

  it("names a finding that the view does not hold by its ID, each one once and with no link", async () => {
    const { on, one, other, component } = await twoNodes();
    const first = await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    const second = await publishPatch(other, component, { location: { path: SKILL, start: 2, end: 3 } }, [{ path: SKILL, content: SKILL_FIXED }]);
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    // The index shows no patch whose finding it does not hold. The page is handed such a view as an index that did would serve it.
    const view = await on.view(component);
    const { body } = draw(placeAt(`/components/${component}`), NOTHING_READ, readOf({ ...view, findings: [] }), START);
    const [entry, ...more] = withClass(byId(body, "patches"), "patch");
    expect(more).toEqual([]);
    expect(placesFrom(entry)).toEqual([]);
    const named = withClass(theOne(withClass(entry, "foot"), "patch "), "ref").map(textOf);
    expect(named.sort()).toEqual([`patch ${view.patches[0]?.patches[0]?.patchId.slice(0, 8)}`, ...[first.finding, second.finding].map((record) => `finding ${record?.slice(0, 8)}`)].sort());
  });

  it("shows two patches on adjoining lines side by side in one group, and a patch further down in a group of its own", async () => {
    const { on, one, other, component } = await twoNodes();
    await publishPatch(one, component, onReadme(12), [{ path: README, content: edited(README_TEXT, { 12: "line twelve" }) }]);
    await publishPatch(other, component, onReadme(13), [{ path: README, content: edited(README_TEXT, { 13: "line thirteen" }) }]);
    await publishPatch(other, component, onReadme(40), [{ path: README, content: edited(README_TEXT, { 40: undefined }) }]);
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const groups = withClass(byId(await pageOf(on, component), "patches"), "group");
    expect(groups).toHaveLength(2);
    const together = theOne(groups, "line 12");
    // The two are columns of one row, each under its own team.
    const [columns, ...rows] = withClass(together, "cols");
    expect(rows).toEqual([]);
    expect(columns?.children.filter(isElement).map((column) => classesOf(column).includes("patch"))).toEqual([true, true]);
    const [first, second] = [theOne(withClass(together, "patch"), "line 12"), theOne(withClass(together, "patch"), "line 13")];
    expect(textOf(first)).toContain(asShown(NODE_A));
    expect(textOf(first)).not.toContain(asShown(NODE_B));
    expect(textOf(second)).toContain(asShown(NODE_B));
    expect(textOf(second)).not.toContain(asShown(NODE_A));
    expect(textOf(together)).toContain("2 patches side by side");

    const alone = theOne(groups, "line 40");
    expect(withClass(alone, "patch")).toHaveLength(1);
    expect(textOf(alone)).toContain("1 patch");
    expect(textOf(alone)).not.toContain("side by side");
  });

  it("shows each patch with its team, its kind, its changed lines and a link to its finding on the page", async () => {
    const { on, one, component } = await twoNodes();
    const made = await publishPatch(one, component, onReadme(12), [{ path: README, content: edited(README_TEXT, { 12: "line twelve" }) }]);
    await synced(on, NODE_A);

    const page = await pageOf(on, component);
    const [entry] = withClass(byId(page, "patches"), "patch");
    expect(textOf(entry)).toContain(asShown(NODE_A));
    expect(tagsOf(entry)).toEqual(["adds or changes", "unconfirmed"]);
    // One line taken out and one put in, at line 12 of the readme.
    expect(textOf(entry)).toContain(README);
    expect(textOf(entry)).toContain("line 12−1+1");
    expect(linksOf(entry)).toContain(`#finding-${made.finding}`);
    // The link leads to that finding's entry, which stands in the findings section.
    expect(elements(byId(page, "findings"))).toContain(byId(page, `finding-${made.finding}`));
  });

  it("shows a re-check of a patch beside it, with the organization and what it says", async () => {
    const on = bench();
    const [one, other, third] = [new FakeNode(NODE_A), new FakeNode(NODE_B), new FakeNode(NODE_C)];
    nodesBehindFetch(one, other, third);
    const component = await on.component();
    for (const node of [NODE_A, NODE_B, NODE_C]) await on.registerNode(node);
    await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    const recheck = { version: "1", type: "patch-re-check", component, patch: await idOf(SKILL_TEXT, SKILL_FIXED), model: "none" };
    await other.publish({ ...recheck, verdict: "resolves" });
    await third.publish({ ...recheck, verdict: "does-not-resolve" });
    for (const node of [NODE_A, NODE_B, NODE_C]) await synced(on, node);

    const [entry] = withClass(byId(await pageOf(on, component), "patches"), "patch");
    expect(tagsOf(entry)).toEqual(["removes only", "confirmed by 2"]);
    expect(textOf(theOne(withClass(entry, "recheck"), asShown(NODE_B)))).toContain("resolves");
    expect(textOf(theOne(withClass(entry, "recheck"), asShown(NODE_C)))).toContain("does not resolve");
  });
});

describe("recipes (KTD5)", () => {
  it("shows each file tree with the organizations that published it, and labels the tree hash as published, not checked", async () => {
    const { on, one, other, component } = await twoNodes();
    await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    const patch = await idOf(SKILL_TEXT, SKILL_FIXED);
    // The recipe also names a patch that no node published for this view.
    const absent = "a".repeat(64);
    const tree = "4c".repeat(20);
    const recipe = { version: "1", type: "recipe", component, patches: [patch, absent].sort(), tree };
    await one.publish(recipe);
    await other.publish(recipe);
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const page = await pageOf(on, component);
    const [shown, ...more] = withClass(byId(page, "recipes"), "recipe");
    expect(more).toEqual([]);
    expect(textOf(shown)).toContain(tree);
    expect(tagsOf(shown)).toEqual(["published, not checked"]);
    expect(textOf(shown)).toContain("2 organizations published this copy");
    expect(textOf(shown)).toContain(asShown(NODE_A));
    expect(textOf(shown)).toContain(asShown(NODE_B));
    // A patch of the copy that the view shows leads to its entry on the page. The other is named, and is no link.
    expect(linksOf(shown).filter((href) => href.startsWith("#"))).toEqual([`#patch-${patch}`]);
    expect(byId(page, `patch-${patch}`)).toBeDefined();
    expect(textOf(shown)).toContain(`patch ${absent.slice(0, 8)}`);
  });

  it("says that no recipe is published when none is", async () => {
    const on = bench();
    const component = await on.component();
    expect(textOf(byId(await pageOf(on, component), "recipes"))).toContain("No recipes published");
  });
});

describe("rejected work (R14, KTD31)", () => {
  it("covers AE2: shows a rejected patch with its contributor and the label of its reason", async () => {
    const { on, other, component } = await twoNodes();
    // The commit also changes a file that its finding does not cite.
    const { patch = "" } = await publishPatch(other, component, {}, [
      { path: SKILL, content: SKILL_FIXED },
      { path: README, content: edited(README_TEXT, { 1: "line one" }) },
    ]);
    await synced(on, NODE_B);
    expect((await on.view(component)).rejected).toEqual([{ node: NODE_B, hash: patch, type: "patch", reason: "patch-out-of-scope" }]);

    const page = await pageOf(on, component);
    const [row, ...more] = withTag(byId(page, "rejected"), "li");
    expect(more).toEqual([]);
    expect(textOf(row)).toContain(asShown(NODE_B));
    expect(textOf(row)).toContain("patch");
    expect(textOf(row)).toContain(patch.slice(0, 8));
    expect(tagsOf(row)).toEqual(["patch out of scope"]);
    // It is listed as rejected work and as nothing else.
    expect(withClass(byId(page, "patches"), "patch")).toEqual([]);
  });
});

describe("a page narrowed by a teams query (KTD38)", () => {
  it("passes the query on to the endpoint, shows no work of a node that is not listed, and says the view is narrowed", async () => {
    const { on, one, other, component } = await twoNodes();
    await one.publish(finding(component));
    await other.publish(finding(component, onReadme(12)), claim(component, 4));
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const address = `/components/${component}?teams=${encodeURIComponent(NODE_A)}`;
    expect(placeAt(address)).toEqual({ kind: "component", component, narrowed: true, viewPath: `/components/${component}/view?teams=${encodeURIComponent(NODE_A)}` });
    const narrowed = await pageOf(on, component, `?teams=${encodeURIComponent(NODE_A)}`);
    expect(textOf(narrowed)).not.toContain(asShown(NODE_B));
    expect(textOf(narrowed)).toContain(asShown(NODE_A));
    expect(withClass(byId(narrowed, "findings"), "finding")).toHaveLength(1);
    expect(textOf(byId(narrowed, "claims"))).toContain("No live claims");
    const notice = byId(narrowed, "narrowed");
    expect(textOf(notice)).toContain("Narrowed view");
    // It names the organizations whose work is shown.
    expect(textOf(notice)).toContain(asShown(NODE_A));

    // The whole view shows both teams, and says nothing of the kind.
    expect(placeAt(`/components/${component}`)).toEqual({ kind: "component", component, narrowed: false, viewPath: `/components/${component}/view` });
    const whole = await pageOf(on, component);
    expect(textOf(whole)).toContain(asShown(NODE_B));
    expect(withClass(byId(whole, "findings"), "finding")).toHaveLength(2);
    expect(byId(whole, "narrowed")).toBeUndefined();
    expect(textOf(whole)).not.toMatch(/narrowed/i);
  });

  it("passes each team of the query on, and no other part of the address", async () => {
    const component = "1f".repeat(20);
    const both = `teams=${encodeURIComponent(NODE_A)}&teams=${encodeURIComponent(NODE_B)}`;
    expect(placeAt(`/components/${component}?${both}&shown=all#patches`).viewPath).toBe(`/components/${component}/view?${both}`);
  });

  it("gives teams that the index does not take a label of their own, and never says that the read failed", async () => {
    const on = bench();
    const component = await on.component();
    // A team in a spelling the index does not accept: the endpoint refuses the query the page passes on.
    const address = `/components/${component}?teams=${encodeURIComponent(`${NODE_A}/`)}`;
    const place = placeAt(address);
    expect(await on.call("GET", place.viewPath)).toEqual({ status: 400, body: { version: "1", error: "bad-request" } });

    const refused = await read(on, address, NOTHING_READ, START);
    // The page is one section: the label, and the commit the address names.
    expect(withTag(refused.body, "section").map((section) => section.attributes["id"])).toEqual(["state"]);
    expect(textOf(theOne(withTag(refused.body, "h2"), ""))).toBe("The index does not take the teams in this address");
    expect(textOf(byId(refused.body, "state"))).toContain(component);
    expect(textOf(refused.body)).not.toContain("No reviews published for this version");
    expect(byId(refused.body, "narrowed")).toBeUndefined();
    // The index was read and it answered, so the status line gives the time and says nothing of a failure.
    expect(textOf(refused.status)).toContain("12:00:00 UTC");
    expect(textOf(refused.status)).not.toMatch(/failed|could not be read/i);

    // It is drawn once, as a view is.
    const again = await read(on, address, refused.held, START + 2000);
    expect(again.body).toBeUndefined();
    expect(textOf(again.status)).toContain("12:00:02 UTC");
    expect(textOf(again.status)).not.toMatch(/failed|could not be read/i);

    // A read that gives a view draws the view in its place.
    const taken = draw(place, again.held, readOf(await on.view(component)), START + 4000);
    expect(textOf(byId(taken.body, "findings"))).toContain("No findings published");
    expect(textOf(taken.body)).not.toContain("The index does not take the teams in this address");
    expect(byId(taken.body, "state")).toBeUndefined();
    expect(textOf(taken.status)).toContain("12:00:04 UTC");
  });

  it("reads a refusal with any other code as a failed read", () => {
    expect(readOf({ version: "1", error: "bad-request" })).toEqual({ kind: "refused" });
    expect(readOf({ version: "1", error: "not-found" })).toEqual({ kind: "unknown" });
    for (const error of ["unauthorized", "not-allowed", "limit-reached", "already-registered"]) expect([error, readOf({ version: "1", error })]).toEqual([error, { kind: "failed" }]);
  });

  it("stands at the address of a component, and at no other but the index's own", () => {
    expect(placeOf("/components/not-a-commit", "")).toBeUndefined();
    expect(placeOf(`/components/${"1F".repeat(20)}`, "")).toBeUndefined();
    expect(placeOf(`/components/${"1f".repeat(20)}/view`, "")).toBeUndefined();
    // The list is data. No page stands at its address.
    expect(placeOf("/view", "")).toBeUndefined();
  });
});

describe("the index's own page (R14, KTD14)", () => {
  /** The page of a list as its first read draws it. The list is handed over as the index would serve it. */
  const drawnFrom = (components: readonly unknown[]): Drawing => firstDrawing(placeAt("/"), { version: "1", components });

  /** The labels a row puts before a value. */
  const LABELS = ["branch ", "commit "];
  /** The word of the mark that leads out to a component's repo. */
  const WAY_OUT = "source";
  /** What a row calls each import state, and what it says the label means. */
  const HELD = ["copy held", "The index holds its own copy of this version, and checks every record against it."] as const;
  const IMPORTING = ["importing", "The index is still fetching its own copy of this version. It checks no record until it holds one."] as const;
  const FAILED = ["import failed", "The index could not fetch its own copy of this version, so it checks no record for it."] as const;

  it("stands at the index's own address, where it reads the list and passes on no query", () => {
    expect(placeOf("/", "")).toEqual({ kind: "index", viewPath: "/view" });
    // The list takes no query, so none of the address reaches it: not the teams a component's page passes on, and no other.
    expect(placeOf("/", "?teams=x")).toEqual({ kind: "index", viewPath: "/view" });
    expect(placeOf("/", `?teams=${encodeURIComponent(NODE_A)}&shown=all`)).toEqual({ kind: "index", viewPath: "/view" });
  });

  it("lists the components under 'Components' with their count, the versions of a repo together and in it the versions of a branch: each with its commit as a link to its page and its import state in words", async () => {
    const { on, components } = await threeComponents();
    expect(await on.call("GET", "/view")).toEqual({ status: 200, body: { version: "1", components } });

    const { body, status } = await read(on, "/");
    expect(withTag(body, "section").map((section) => section.attributes["id"])).toEqual(["components"]);
    const section = byId(body, "components");
    expect(withTag(section, "h2").map(textOf)).toEqual(["Components"]);
    expect(withClass(section, "count").map(textOf)).toEqual(["3"]);

    // A block for each repo, where its first version was registered. The first and the third component are of one repo, so they stand together.
    const repos = withClass(section, "repo");
    expect(repos.map((repo) => withTag(repo, "h3").map(textOf))).toEqual([[UPSTREAM], [OTHER_UPSTREAM]]);
    // In a repo, a group for each branch, and in it one row for each version. A commit is shown by its first eight characters.
    const branchesOf = (repo: Drawing | undefined): string[][] => withClass(repo, "branch").map((branch) => texts(branch).filter((text) => !LABELS.includes(text)));
    expect(repos.map(branchesOf)).toEqual([
      [
        [BRANCH, "c3c3c3c3", ...HELD],
        ["gone", "b2b2b2b2", ...FAILED],
      ],
      [["next", "a1a1a1a1", ...IMPORTING]],
    ]);
    // A repo's address stands once, however many of its versions the index holds, and each has the way out to the repo beside it.
    expect(texts(section).filter((text) => text === UPSTREAM)).toHaveLength(1);
    expect(repos.map((repo) => withClass(repo, "source").map((link) => [link.tag, link.attributes["href"], textOf(link)]))).toEqual([[["a", UPSTREAM, WAY_OUT]], [["a", OTHER_UPSTREAM, WAY_OUT]]]);

    const rows = withClass(section, "row");
    expect(rows.map(tagsOf)).toEqual([[HELD[0]], [FAILED[0]], [IMPORTING[0]]]);
    // Each label has its meaning beside it, and can be focused, so the meaning shows without a pointer too.
    expect(rows.map((row) => withClass(row, "tip").map(textOf))).toEqual([[HELD[1]], [FAILED[1]], [IMPORTING[1]]]);
    expect(rows.map((row) => withClass(row, "tag").map((tag) => tag.attributes["tabindex"]))).toEqual([["0"], ["0"], ["0"]]);
    // The outline of a label carries meaning: solid for a copy the index holds, dashed for one it does not hold yet, and the rejected one for an import that failed.
    expect(rows.map((row) => withClass(row, "tag").map((tag) => tag.attributes["class"]))).toEqual([["tag"], ["tag rej"], ["tag un"]]);
    // The state is never drawn as the index stores it: "ready" would read as an all-clear.
    expect(textOf(body)).not.toMatch(/ready/i);
    expect(textOf(status)).not.toMatch(/ready/i);

    // A row's one link is its commit, to the page of that commit on this index.
    const [first, second, third] = components;
    const inOrder = [first, third, second].flatMap((listed) => (listed ? [listed] : []));
    expect(rows.map(linksOf)).toEqual(inOrder.map(({ component }) => [`/components/${component}`]));
    for (const [at, { component }] of inOrder.entries()) {
      expect(withTag(rows[at], "a").map(textOf)).toEqual([`commit ${component.slice(0, 8)}`]);
      // The link carries the commit whole, and a component's page stands there.
      expect(placeAt(`/components/${component}`)).toMatchObject({ kind: "component", component });
      expect(textOf(rows[at])).not.toContain(component);
    }

    // Every text is a value of the list, the count of its components or one of the page's own words. Each word is a label or says what a label means, and none says what to do.
    const values = new Set(components.flatMap(({ component, url, branch }) => [url, branch, component.slice(0, 8)]));
    const words = ["Components", "3", ...LABELS, WAY_OUT, ...HELD, ...IMPORTING, ...FAILED];
    expect([...new Set(texts(body).filter((text) => !values.has(text)))].sort()).toEqual([...words].sort());
    // No element carries anything but a class, a target, the address of a link and the mark of a label that can be focused.
    for (const element of elements(body)) {
      for (const name of Object.keys(element.attributes)) expect(["class", "id", "href", "tabindex"]).toContain(name);
    }
  });

  it("narrows the list to one repo when the address names it, says so, and never writes down what the address names", async () => {
    const { on, components } = await threeComponents();
    // The page of a component links here, with the component's Git URL in the address. The list still takes no query.
    const address = `/?repo=${encodeURIComponent(UPSTREAM)}`;
    expect(placeAt(address)).toEqual({ kind: "index", viewPath: "/view", repo: UPSTREAM });
    const { body } = await read(on, address);
    expect(withClass(body, "repo").map((repo) => withTag(repo, "h3").map(textOf))).toEqual([[UPSTREAM]]);
    expect(withClass(body, "row")).toHaveLength(components.filter(({ url }) => url === UPSTREAM).length);
    expect(withClass(body, "count").map(textOf)).toEqual(["2"]);
    const notice = byId(body, "narrowed");
    expect(texts(notice)).toEqual(["One repo", "Only the versions of one repo are listed.", "Every component of this index"]);
    expect(linksOf(notice)).toEqual(["/"]);

    // A repo the index holds no version of gives no row, in words of its own. What the address named is no text of the page.
    const named = '<img src=x onerror=alert(1)>"';
    const place = placeAt(`/?repo=${encodeURIComponent(named)}`);
    const none = firstDrawing(place, { version: "1", components });
    expect(withClass(none, "row")).toEqual([]);
    expect(withClass(none, "empty").map(textOf)).toEqual(["No version of this repo registered"]);
    expect(textOf(none)).not.toContain("img");
    expect(linksOf(none)).toEqual(["/"]);
    // With no repo in the address the page says nothing of narrowing.
    expect(byId((await read(on, "/")).body, "narrowed")).toBeUndefined();
  });

  it("shows 'No component registered' for an index that holds none, and no row", async () => {
    const on = bench();
    expect(await on.call("GET", "/view")).toEqual({ status: 200, body: { version: "1", components: [] } });

    const { body, status } = await read(on, "/");
    const section = byId(body, "components");
    expect(withTag(section, "h2").map(textOf)).toEqual(["Components"]);
    expect(withClass(section, "empty").map(textOf)).toEqual(["No component registered"]);
    expect(withTag(body, "li")).toEqual([]);
    expect(linksOf(body)).toEqual([]);
    // The index was read and it answered: an empty list is no failed read.
    expect(textOf(status)).toContain("12:00:00 UTC");
    expect(textOf(status)).not.toMatch(/failed|could not be read/i);
  });

  it("shows a Git URL and a branch that hold markup as text, and makes no element from either", () => {
    const component = "1f".repeat(20);
    // The index takes neither spelling in a registration. The page is handed them as an index that did would serve them.
    const gitUrl = "https://git.fellbeck-tools.example/<img src=x onerror=alert(1)>.git";
    const branch = '"><script>alert(1)</script><b class="tag">';
    const plain = drawnFrom([{ component, url: UPSTREAM, branch: BRANCH, state: "ready" }]);
    const hostile = drawnFrom([{ component, url: gitUrl, branch, state: "ready" }]);

    // Each is one text of the page, whole and unchanged.
    expect(texts(hostile).filter((text) => text === gitUrl)).toHaveLength(1);
    expect(texts(hostile).filter((text) => text === branch)).toHaveLength(1);
    // The page is made of the same elements as with plain values: no value became an element or the name of an attribute.
    const shape = (page: Drawing): unknown[] => elements(page).map((element) => [element.tag, Object.keys(element.attributes)]);
    expect(shape(hostile)).toEqual(shape(plain));
    expect(withTag(hostile, "img")).toEqual([]);
    expect(withTag(hostile, "script")).toEqual([]);
    // The address reaches an attribute only as the target of its own link, and the branch reaches none.
    for (const element of elements(hostile)) {
      for (const [name, value] of Object.entries(element.attributes)) {
        if (name === "href") expect([gitUrl, `/components/${component}`]).toContain(value);
        else expect(value).not.toMatch(/[<>"]/);
      }
    }
  });

  it("keeps the link of a commit on the index, whatever the list gives as the commit", () => {
    // The index holds a component only by its full commit hash. The page is handed these as an index that held another value would serve them.
    for (const component of ["//git.fellbeck-tools.example/x", "javascript:alert(1)", "../../view", "\\\\git.fellbeck-tools.example/x"]) {
      const page = drawnFrom([{ component, url: UPSTREAM, branch: BRANCH, state: "ready" }]);
      const [toPage = ""] = linksOf(page).filter((href) => href !== UPSTREAM);
      expect(toPage).toBe(`/components/${component}`);
      // Read as a browser reads it, the link leads nowhere but the index.
      expect(new URL(toPage, INDEX).origin).toBe(INDEX);
    }
  });

  it("shows a Git URL that is not HTTPS as text, and gives it no way out", () => {
    const component = "1f".repeat(20);
    for (const spelling of ["http://git.fellbeck-tools.example/fellbeck-sync.git", "javascript:alert(1)//git.fellbeck-tools.example", "//git.fellbeck-tools.example/fellbeck-sync.git", "git.fellbeck-tools.example/fellbeck-sync.git"]) {
      const page = drawnFrom([{ component, url: spelling, branch: BRANCH, state: "ready" }]);
      expect(texts(page)).toContain(spelling);
      // The one link of the page is the commit's, to its page on this index. The address heads its block as text, and is the target of no link.
      expect(linksOf(page)).toEqual([`/components/${component}`]);
      expect(withTag(page, "a").map(textOf)).toEqual(["commit 1f1f1f1f"]);
      expect(withTag(page, "h3").map(textOf)).toEqual([spelling]);
      expect(withClass(page, "source")).toEqual([]);
      expect(texts(page)).not.toContain(WAY_OUT);
    }
  });

  it("says each time when the list was read, and draws it again only when it changed", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    await on.deliver();

    const first = await read(on, "/", NOTHING_READ, START);
    expect(withClass(first.body, "row").map(tagsOf)).toEqual([["importing"]]);
    expect(textOf(first.status)).toContain("12:00:00 UTC");

    // Two seconds on, the index serves the same list.
    const second = await read(on, "/", first.held, START + 2000);
    expect(second.body).toBeUndefined();
    expect(textOf(second.status)).toContain("12:00:02 UTC");

    // The copy is ready, so the state of the one component changes.
    on.artifacts.finish();
    await on.drain();
    const third = await read(on, "/", second.held, START + 4000);
    expect(withClass(third.body, "row").map(tagsOf)).toEqual([["copy held"]]);
    expect(textOf(third.status)).toContain("12:00:04 UTC");
  });

  it("reads the view of a component at the index's address, and the list at a component's, as a failed read that keeps the last drawing", async () => {
    const on = bench();
    const component = await on.component();
    const view = await on.view(component);
    const { body: list } = await on.call("GET", "/view");

    // The index's own page is handed a view. Nothing is drawn over the list on screen.
    const listed = await read(on, "/", NOTHING_READ, START);
    expect(listed.body).toBeDefined();
    const atIndex = draw(placeAt("/"), listed.held, readOf(view), START + 2000);
    expect(atIndex.body).toBeUndefined();
    expect(atIndex.held.last).toEqual(listed.held.last);
    expect(textOf(atIndex.status)).toMatch(/failed/i);
    expect(textOf(atIndex.status)).toContain("12:00:00 UTC");
    expect(textOf(atIndex.status)).not.toContain("12:00:02 UTC");

    // A component's page is handed the list. The view on screen stays.
    const viewed = await read(on, `/components/${component}`, NOTHING_READ, START);
    expect(viewed.body).toBeDefined();
    const atComponent = draw(placeAt(`/components/${component}`), viewed.held, readOf(list), START + 2000);
    expect(atComponent.body).toBeUndefined();
    expect(atComponent.held.last).toEqual(viewed.held.last);
    expect(textOf(atComponent.status)).toMatch(/failed/i);
    expect(textOf(atComponent.status)).toContain("12:00:00 UTC");

    // A refusal says nothing of the list, whatever its code: the index's own page names no commit and passes on no teams.
    for (const error of ["not-found", "bad-request", "unauthorized"]) {
      const refused = draw(placeAt("/"), listed.held, readOf({ version: "1", error }), START + 2000);
      expect([error, refused.body]).toEqual([error, undefined]);
      expect(refused.held.last).toEqual(listed.held.last);
      expect(textOf(refused.status)).toMatch(/failed/i);
    }

    // The next read of the list shows its own time again, and draws nothing: the list is the one on screen.
    const again = await read(on, "/", atIndex.held, START + 4000);
    expect(again.body).toBeUndefined();
    expect(textOf(again.status)).not.toMatch(/failed/i);
    expect(textOf(again.status)).toContain("12:00:04 UTC");
  });

  it("says that the index could not be read when the first read fails, and draws no list", () => {
    for (const answer of [{ kind: "failed" } as const, readOf({ version: "1", error: "not-found" }), readOf("<html>")]) {
      const failed = draw(placeAt("/"), NOTHING_READ, answer, START);
      expect(failed.body).toBeUndefined();
      expect(failed.held.last).toBeUndefined();
      expect(textOf(failed.status)).toContain("The index could not be read");
    }
  });
});

describe("reading the view again (KTD11, KTD14)", () => {
  it("draws the page again only when the view version changes, and says each time when the view was read", async () => {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    await synced(on, NODE_A);
    const address = `/components/${component}`;

    const first = await read(on, address, NOTHING_READ, START);
    expect(first.body).toBeDefined();
    expect(textOf(first.status)).toContain("12:00:00 UTC");

    // Two seconds on, the index serves the same version.
    clockAt(START + 2000);
    const second = await read(on, address, first.held, START + 2000);
    expect(second.body).toBeUndefined();
    expect(textOf(second.status)).toContain("12:00:02 UTC");

    await node.publish(finding(component, onReadme(12)));
    await synced(on, NODE_A);
    const third = await read(on, address, second.held, START + 4000);
    expect(withClass(byId(third.body, "findings"), "finding")).toHaveLength(2);
    expect(textOf(third.status)).toContain("12:00:04 UTC");
  });

  it("keeps the last view after a failed read, and shows the time that view was read", async () => {
    const on = bench();
    const component = await on.component();
    const address = `/components/${component}`;
    const first = await read(on, address, NOTHING_READ, START);
    expect(textOf(first.status)).not.toMatch(/failed/i);

    // The index answers with a refusal that says nothing of this version and nothing of the teams in the address.
    const failed = draw(placeAt(address), first.held, readOf({ version: "1", error: "unauthorized" }), START + 2000);
    // Nothing is drawn over the view on screen.
    expect(failed.body).toBeUndefined();
    expect(failed.held.last).toEqual(first.held.last);
    expect(textOf(failed.status)).toMatch(/failed/i);
    expect(textOf(failed.status)).toContain("12:00:00 UTC");
    expect(textOf(failed.status)).not.toContain("12:00:02 UTC");

    // The same holds for an answer that is no JSON object at all, and for no answer.
    expect(readOf(undefined)).toEqual({ kind: "failed" });
    expect(readOf("<html>")).toEqual({ kind: "failed" });

    // The next read that works shows its own time again, and draws nothing: the version is the one on screen.
    const again = await read(on, address, failed.held, START + 4000);
    expect(again.body).toBeUndefined();
    expect(textOf(again.status)).not.toMatch(/failed/i);
    expect(textOf(again.status)).toContain("12:00:04 UTC");
  });

  it("says that the index could not be read when the first read fails", () => {
    const failed = draw(placeAt(`/components/${"1f".repeat(20)}`), NOTHING_READ, { kind: "failed" }, START);
    expect(failed.body).toBeUndefined();
    expect(failed.held.last).toBeUndefined();
    expect(textOf(failed.status)).toContain("The index could not be read");
  });

  it("draws a version that was unknown once it is registered, and an unknown version once", async () => {
    const on = bench();
    const commit = await on.artifacts.host(UPSTREAM, BRANCH, FILES);
    const address = `/components/${commit}`;
    const unknown = await read(on, address, NOTHING_READ, START);
    expect(textOf(unknown.body)).toContain("No reviews published for this version");
    expect((await read(on, address, unknown.held, START + 2000)).body).toBeUndefined();

    await on.registerComponent({ url: UPSTREAM, branch: BRANCH, commit });
    const registered = await read(on, address, unknown.held, START + 4000);
    expect(textOf(registered.body)).toContain("The index is still importing this version");
    expect(textOf(registered.body)).not.toContain("No reviews published for this version");
  });
});

describe("a value from a record or a registration (KTD14, KTD33)", () => {
  /** A view of a ready component with one finding by one node, as the index serves it. */
  async function served(): Promise<{ place: Place; view: View }> {
    const on = bench();
    const node = new FakeNode(NODE_A);
    nodesBehindFetch(node);
    const component = await on.component();
    await on.registerNode(NODE_A);
    await node.publish(finding(component));
    await synced(on, NODE_A);
    return { place: placeAt(`/components/${component}`), view: await on.view(component) };
  }

  it("is shown as text when it holds markup: a Git URL and a node URL", async () => {
    const { place, view } = await served();
    // The index takes neither spelling in a registration. The page is handed them as an index that did would serve them.
    const gitUrl = "https://git.fellbeck-tools.example/<img src=x onerror=alert(1)>.git";
    const nodeUrl = 'https://node.team-a.example/"><script>alert(1)</script><b class="org">';
    const plain = firstDrawing(place, view);
    const hostile = firstDrawing(place, replaced(replaced(view, UPSTREAM, gitUrl), NODE_A, nodeUrl));

    // Each is one text of the page, whole and unchanged.
    expect(texts(hostile)).toContain(gitUrl);
    expect(texts(hostile)).toContain(asShown(nodeUrl));
    expect(texts(hostile).filter((text) => text === asShown(nodeUrl))).toHaveLength(texts(plain).filter((text) => text === asShown(NODE_A)).length);
    // The page is made of the same elements as with plain values: no value became an element or the name of an attribute.
    const shape = (page: Drawing): unknown[] => elements(page).map((element) => [element.tag, Object.keys(element.attributes)]);
    expect(shape(hostile)).toEqual(shape(plain));
    expect(withTag(hostile, "img")).toEqual([]);
    expect(withTag(hostile, "script")).toEqual([]);
    // Neither address reaches an attribute but as the target of its own link, and no class is made from one.
    for (const element of elements(hostile)) {
      for (const [name, value] of Object.entries(element.attributes)) {
        if (name === "href") expect([gitUrl, nodeUrl, PROTOCOL, `/?repo=${encodeURIComponent(gitUrl)}`]).toContain(value);
        else expect(value).not.toMatch(/[<>"]/);
      }
    }
  });

  it("shows a node's HTTPS address without its scheme, and keeps the whole of it in the link", async () => {
    const { place, view } = await served();
    const page = firstDrawing(place, view);
    const names = withClass(page, "org");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(textOf(name)).toBe("node.team-a.example");
      expect(linksOf(name)).toEqual([NODE_A]);
    }
    // The address stands nowhere on the page with its scheme: the scheme is in the link alone.
    expect(texts(page)).not.toContain(NODE_A);
  });

  it("draws a value it has no words for as the value alone, and still draws the page", async () => {
    const { place, view } = await served();
    // The index takes no observation outside the protocol's list. The page is handed one as an index of a later protocol would serve it.
    const page = firstDrawing(place, replaced(view, "hidden-instruction", "an-observation-of-a-later-protocol"));
    const [row, ...more] = withClass(page, "finding");
    expect(more).toEqual([]);
    expect(texts(withTag(row, "strong")[0])).toEqual(["an observation of a later protocol"]);
    expect(textOf(row)).toContain("node.team-a.example");
    expect(tagsOf(row)).toEqual(["unconfirmed"]);
  });

  it("is no link when it is a node URL that is not HTTPS, and is shown as text", async () => {
    const { place, view } = await served();
    const plain = firstDrawing(place, view);
    // An HTTPS node URL is a link to the node, and the Git URL a link to the repo.
    expect(linksOf(plain)).toContain(NODE_A);
    expect(linksOf(plain)).toContain(UPSTREAM);

    for (const spelling of ["http://node.team-a.example", "javascript:alert(1)//node.team-a.example", "//node.team-a.example", "node.team-a.example"]) {
      const page = firstDrawing(place, replaced(replaced(view, NODE_A, spelling), UPSTREAM, spelling));
      // An address that is not HTTPS is shown whole, scheme and all, so it never reads as the HTTPS address of that host.
      expect(texts(page)).toContain(spelling);
      // The one link that leaves the index is the page's own, to where the protocol defines a criterion. The other stays on the index, whatever the Git URL holds.
      const away = [...new Set(linksOf(page).filter((href) => !href.startsWith("#")))];
      expect(away).toEqual([`/?repo=${encodeURIComponent(spelling)}`, PROTOCOL]);
      expect(away.map((href) => new URL(href, INDEX).origin)).toEqual([INDEX, new URL(PROTOCOL).origin]);
      for (const link of withTag(page, "a")) expect(textOf(link)).not.toContain(spelling);
    }
  });

  // A tripwire for the rule that a value is set as text. No test runs the page's scripts
  // in a browser, and `build()` in `poll.ts` is the one place where a value of a view
  // becomes part of the document. So this reads the source of each script, and fails on
  // the name of anything that parses a text as markup.
  it("is set by scripts that name nothing that parses a text as markup", () => {
    const parsers = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "DOMParser", "createContextualFragment", "setHTML"];
    // Every script of the page is read: the one the page loads and the two that script imports.
    expect(Object.keys(env.PAGE_SCRIPTS).sort()).toEqual(["map.ts", "poll.ts", "render.ts"]);
    for (const [name, source] of Object.entries(env.PAGE_SCRIPTS)) {
      expect([name, source === ""]).toEqual([name, false]);
      expect([name, parsers.filter((parser) => source.includes(parser))]).toEqual([name, []]);
    }
  });
});

describe("the pages' addresses on the index (KTD14)", () => {
  /** The directives of a content security policy, each with its sources. */
  function policyOf(response: Response): Map<string, string[]> {
    const directives = (response.headers.get("content-security-policy") ?? "").split(";").map((directive) => directive.trim().split(/\s+/));
    return new Map(directives.flatMap(([name, ...sources]) => (name ? [[name.toLowerCase(), sources]] : [])));
  }

  // The addresses outside the index that a page's file links to. The project's site is the one its bar leads to.
  const SITE = "https://cairnfield.net";
  const REPO = "https://github.com/peoplerenaissance/cairnfield";
  /** Where the links of a page's footer lead, in the order of the file: its credits, then where more about the project is written. */
  const FOOTER = ["https://sparkwise.co", REPO, "https://aribadernatal.com", "https://cloudflare.com", SITE, REPO, `${REPO}#readme`, `${REPO}/blob/main/reference/protocol.md`];
  /** The words of that footer. They credit the people behind the software, say what an index is, and name where four links lead. */
  const FOOTER_WORDS = [
    "Credits",
    "Cairnfield is an unofficial side project by the",
    "Sparkwise",
    "engineering team.",
    "Open source",
    "under the MIT license.",
    "Set in Routed Gothic by Darren Embry, Hanken Grotesk by Hanken Design Co. and Spline Sans Mono by Sorkin Type, all under the SIL Open Font License and served from this index.",
    "Code by",
    "Ari Bader-Natal",
    ". Built with",
    "Cloudflare",
    ".",
    "This index",
    "Anyone can run an index. The credits here are for the software, and say nothing of who runs this one.",
    "An index holds nothing original: every record it shows is published by a team's own node.",
    "More about Cairnfield",
    "The Cairnfield site",
    "The repository",
    "The README, which is the manual",
    "The protocol",
    "Copyright 2026 People Renaissance, Inc.",
  ];

  /** The addresses a page's file names: the files it loads, and where its links lead, in the order of the file. */
  function addressesIn(html: string): { loads: string[]; links: string[] } {
    const named = [...html.matchAll(/<([a-z]+)\b[^>]*?\s(?:src|href)="([^"]*)"/g)].map(([, tag = "", address = ""]) => ({ tag, address }));
    // Every `src` and `href` of the file is one of them, however it is written.
    expect(html.match(/\s(?:src|href)\s*=/g)).toHaveLength(named.length);
    return {
      loads: named.filter(({ tag }) => tag !== "a").map(({ address }) => address),
      links: named.filter(({ tag }) => tag === "a").map(({ address }) => address),
    };
  }

  /** The words a page's file holds: each text between two tags, in the order of the file. */
  const wordsIn = (html: string): string[] => html.split(/<[^>]*>/).map((text) => text.replace(/\s+/g, " ").trim()).filter((text) => text !== "");

  /** A page's file works under the policy: it holds no script, style or handler written into it, and loads only files the index serves itself. */
  function worksUnderThePolicy(html: string): void {
    expect(html).toContain('id="status"');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style|\sstyle\s*=|\son[a-z]+\s*=/i);
    // Its one script is a module: `poll.js` imports `render.js`, and only a module imports.
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script type="module" src="/page/poll.js">']);
    // Beside the script it loads its stylesheet and its icon, which it names in three forms.
    expect(addressesIn(html).loads.sort()).toEqual(["/page/apple-touch-icon.png", "/page/favicon.ico", "/page/favicon.svg", "/page/poll.js", "/page/styles.css"]);
    // It holds no image of its own: the policy takes an image from the index for the icon's sake.
    expect(html).not.toMatch(/<img|<picture|<svg|<object|<embed|<iframe/i);
    // The script replaces what is under this element on each draw, so the file puts nothing there.
    expect(html).toContain('<main id="view"></main>');
  }

  it("answers the page with a content security policy that allows no inline script", async () => {
    const on = bench();
    const component = await on.component();

    const response = await on.get(`/components/${component}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = policyOf(response);
    // Scripts, styles, fonts, images and fetches come from the page's own origin, and nothing else is allowed.
    expect(policy.get("default-src")).toEqual(["'none'"]);
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("style-src")).toEqual(["'self'"]);
    expect(policy.get("font-src")).toEqual(["'self'"]);
    expect(policy.get("img-src")).toEqual(["'self'"]);
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    for (const [directive, sources] of policy) {
      if (!["script-src", "style-src", "font-src", "img-src", "connect-src"].includes(directive)) expect([directive, sources]).toEqual([directive, ["'none'"]]);
    }
    expect(response.headers.get("content-security-policy")).not.toMatch(/unsafe|nonce-|sha(256|384|512)-|data:|https?:|\*/);

    // The page works under that policy: it is the file of `src/page/`, with no script, style or handler written into it.
    const html = await response.text();
    expect(html).toBe(env.PAGE_FILES["page.html"]);
    worksUnderThePolicy(html);
    // Its links lead to the site and the index's own page, and then to where its footer's lead, and nowhere else.
    expect(addressesIn(html).links).toEqual([SITE, "/", ...FOOTER]);
  });

  it("answers the index's own address with its page, under the policy of a component's page", async () => {
    const on = bench();
    const component = await on.component();

    const response = await on.get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = response.headers.get("content-security-policy");
    expect(policy).toMatch(/default-src 'none'/);
    expect(policy).toBe((await on.get(`/components/${component}`)).headers.get("content-security-policy"));

    // It is the file of `src/page/`, and it works under that policy as the page of a component does.
    const html = await response.text();
    expect(html).toBe(env.PAGE_FILES["root.html"]);
    worksUnderThePolicy(html);
    // Its links lead to the site, from its bar and from its first sentence, and then to where its footer's lead, and nowhere else.
    expect(addressesIn(html).links).toEqual([SITE, SITE, ...FOOTER]);
    // The query of the address changes nothing: the page passes none of it on.
    expect(await (await on.get("/?teams=x")).text()).toBe(html);
  });

  // The words below are each page's own: they are written in its file and come from no
  // record. They say what the page is and what an index is and is not. None tells a
  // reader to do something (R35). A change to a word shows here.
  it("says what an index is and what each page is in words of its own, outside the element its script draws in", () => {
    const [root = "", page = ""] = [env.PAGE_FILES["root.html"], env.PAGE_FILES["page.html"]];
    // The paragraph names the project, and the name is a link to its site.
    const index = [
      "This index is a core part of",
      "Cairnfield",
      ". It collects findings, patches and recipes about AI tools from teams and their AI agents, and reports them together for each version of a tool, each checked against the index's own copy of that version. An index holds nothing original and gives no verdict. It is not what a team builds from: each team's command fetches patches from the nodes of the teams that wrote them, and checks them again.",
    ];
    const component = "This page gathers what teams report about one exact version of an AI tool: what their reviews found, the fixes they wrote, and the copies they built with those fixes. The index collects these reports and gives no verdict of its own.";
    expect(wordsIn(root)).toEqual(["Cairnfield index", "Cairnfield", "index", "Reading the index", "Cairnfield index", ...index, "The list of components needs the page's script. The rest of this page does not.", ...FOOTER_WORDS]);
    expect(root).toContain("<h1>Cairnfield index</h1>");
    expect(root).toContain("<title>Cairnfield index</title>");
    expect(wordsIn(page)).toEqual([
      "Cairnfield index: one component version",
      "Cairnfield",
      "index",
      "component",
      "Reading the index",
      component,
      "This page draws what the index serves as data, and it needs its script to do so.",
      ...FOOTER_WORDS,
    ]);
    // The bar of each page is a trail: the project's name leads to its site, and on a component's page the index leads to the index's own page.
    expect(page).toMatch(/<a\b[^>]*\shref="\/"[^>]*>index<\/a>/);
    expect(root).not.toMatch(/\shref="\/"/);
    // The last part of a trail is the page that is open, and is no link.
    expect(root).toContain('<li aria-current="page">index</li>');
    expect(page).toContain('<li aria-current="page">component</li>');
    // The project's name leads to the project's site wherever a page's file holds it: in each bar, and in the index's paragraph.
    const toSite = new RegExp(`<a\\b[^>]*\\shref="${SITE}"[^>]*>Cairnfield</a>`, "g");
    expect(page.match(toSite)).toHaveLength(1);
    expect(root.match(toSite)).toHaveLength(2);
    // Each page says what it is after its bar and before the element its script draws in. After that element it holds the words for a reader with no script, and then its footer, which is the same on both.
    for (const [html, said] of [[root, index[2] ?? ""], [page, component]] as const) {
      const drawn = html.indexOf('<main id="view"></main>');
      expect(html.indexOf(`href="${SITE}"`)).toBeLessThan(html.indexOf('id="status"'));
      expect(html.indexOf(said)).toBeGreaterThan(html.indexOf('id="status"'));
      expect(html.indexOf(said)).toBeLessThan(drawn);
      expect(wordsIn(html.slice(drawn)).slice(1)).toEqual(FOOTER_WORDS);
      expect(html.indexOf("<footer")).toBeGreaterThan(html.indexOf("</noscript>"));
    }
    expect(root.slice(root.indexOf("<footer"))).toBe(page.slice(page.indexOf("<footer")));
  });

  it("serves the page's scripts and stylesheet with their media types, and never lets a browser guess one", async () => {
    const on = bench();
    for (const [path, type] of [
      ["/page/poll.js", "text/javascript; charset=utf-8"],
      ["/page/map.js", "text/javascript; charset=utf-8"],
      ["/page/render.js", "text/javascript; charset=utf-8"],
      ["/page/styles.css", "text/css; charset=utf-8"],
    ] as const) {
      const response = await on.get(path);
      expect([path, response.status]).toEqual([path, 200]);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // A script or a stylesheet can change with a deploy, so a browser is not told to keep one.
      expect([path, response.headers.get("cache-control")]).toEqual([path, null]);
    }
    expect(await (await on.get("/page/styles.css")).text()).toBe(env.PAGE_FILES["styles.css"]);
  });

  it("serves the icon each page names, in its three forms, under the policy of the pages", async () => {
    const on = bench();
    const icons = [
      ["/page/favicon.ico", "image/vnd.microsoft.icon"],
      ["/page/favicon.svg", "image/svg+xml"],
      ["/page/apple-touch-icon.png", "image/png"],
    ] as const;
    // They are the icons the build copies, each of them.
    expect(Object.keys(env.PAGE_FILES).filter((name) => /\.(?:ico|svg|png)$/.test(name)).sort()).toEqual(icons.map(([path]) => path.slice("/page/".length)).sort());
    for (const [path, type] of icons) {
      const response = await on.get(path);
      expect([path, response.status]).toEqual([path, 200]);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // An icon opened at its own address is held to the policy too, so one drawn as markup runs no script.
      expect(response.headers.get("content-security-policy")).toBe((await on.get("/")).headers.get("content-security-policy"));
    }
  });

  it("serves each font the stylesheet names, and the stylesheet names no file that the index does not serve", async () => {
    const on = bench();
    const styles = env.PAGE_FILES["styles.css"] ?? "";
    // Every address of the stylesheet is a font beside it. It names no image and takes in no other stylesheet.
    const named = [...styles.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/g)].map(([, address = ""]) => address);
    expect(styles.match(/url\(/g)).toHaveLength(named.length);
    expect(named.sort()).toEqual(["fonts/hanken-grotesk.woff2", "fonts/routed-gothic.ttf", "fonts/spline-sans-mono.woff2"]);
    expect(styles).not.toMatch(/@import/);
    // They are the fonts the build copies, each of them.
    expect(Object.keys(env.PAGE_FILES).filter((name) => name.startsWith("fonts/")).sort()).toEqual(named);

    for (const address of named) {
      const response = await on.get(`/page/${address}`);
      expect([address, response.status]).toEqual([address, 200]);
      expect(response.headers.get("content-type")).toBe(address.endsWith(".ttf") ? "font/ttf" : "font/woff2");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe((await on.get("/")).headers.get("content-security-policy"));
      // A font's file never changes under its name, so a browser keeps it between two pages.
      expect(response.headers.get("cache-control")).toBe("public, max-age=604800");
    }
  });

  it("answers the page for any commit in its full form, a commit nobody registered included", async () => {
    const on = bench();
    const response = await on.get(`/components/${"9a".repeat(20)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(env.PAGE_FILES["page.html"]);
    // The query of the address is the page's own to read.
    expect((await on.get(`/components/${"9a".repeat(20)}?teams=${encodeURIComponent(NODE_A)}`)).status).toBe(200);
  });

  it("answers not-found for a commit in another form, and for a file that is not the page's", async () => {
    const on = bench();
    const notFound = { status: 404, body: { version: "1", error: "not-found" } };
    expect(await on.call("GET", "/components/not-a-commit")).toEqual(notFound);
    expect(await on.call("GET", `/components/${"1F".repeat(20)}`)).toEqual(notFound);
    expect(await on.call("GET", `/components/${"1f".repeat(20)}/`)).toEqual(notFound);
    expect(await on.call("GET", "/page/missing.js")).toEqual(notFound);
    // The page is served for a component and under no name of its own, and the index's own page at the index's address alone.
    expect(await on.call("GET", "/page/page.html")).toEqual(notFound);
    expect(await on.call("GET", "/page/root.html")).toEqual(notFound);
    expect(await on.call("GET", "/page/")).toEqual(notFound);
    expect(await on.call("GET", "/page/..%2Fwrangler.jsonc")).toEqual(notFound);
    // Of the fonts' folder the index serves a font and nothing else: not the license, and no file of another folder.
    expect(await on.call("GET", "/page/fonts/LICENSE.md")).toEqual(notFound);
    expect(await on.call("GET", "/page/fonts/README.md")).toEqual(notFound);
    expect(await on.call("GET", "/page/fonts/")).toEqual(notFound);
    expect(await on.call("GET", "/page/fonts/..%2Fpoll.js")).toEqual(notFound);
    // An icon is served under `/page/` like every other file of the pages, and not at the index's root.
    expect(await on.call("GET", "/favicon.ico")).toEqual(notFound);
    expect(await on.call("POST", `/components/${"1f".repeat(20)}`)).toEqual(notFound);
    expect(await on.call("POST", "/")).toEqual(notFound);
    // The assets binding was asked for the one file it does not hold, and for nothing a path made up.
    expect(on.assets.asked).toEqual(["/page/missing.js"]);
  });
});

describe("the demo on the page (R27)", () => {
  const MANIFEST = "plugin.json";
  const PLUGIN_SKILL = "skills/sync/SKILL.md";
  const SWITCH = "scripts/export.sh";

  /** The record ID in the name of a record file. */
  const idIn = (path: string): string => path.slice(path.lastIndexOf("/") + 1, -".json".length);

  /**
   * What the demo leaves after its third step, built from the saved fixtures: the demo
   * plugin's first commit, each team's saved findings, the patch both teams wrote, the
   * two patches on adjoining lines of the manifest, the hand-made patch the index
   * rejects, the claims of agents that still run, and the first team's recipe. Every
   * patch commit is made by hand behind a stand-in node.
   */
  async function demo(): Promise<{ on: Bench; component: string; view: View; rejected: string; patches: { both: string; hosts: string; variables: string } }> {
    const made = JSON.parse(fixture("out-of-scope/COMMIT.json")) as { readonly component: string; readonly commit: string };
    const on = bench();
    const [teamA, teamB] = [new FakeNode(NODE_A), new FakeNode(NODE_B)];
    nodesBehindFetch(teamA, teamB);
    const component = await on.component(demoPlugin(), made.component);
    await on.registerNode(NODE_A);
    await on.registerNode(NODE_B);

    /** Pushes a team's saved findings as its outbox holds them. Returns each finding's ID by the path it cites. */
    const saved = async (node: FakeNode, team: string): Promise<(path: string) => string> => {
      const folder = `outboxes/${team}/`;
      const ids = new Map<string, string>();
      for (const path of fixturesUnder(folder)) {
        await node.push(path.slice(folder.length), fixture(path));
        ids.set((JSON.parse(fixture(path)) as { readonly location: { readonly path: string } }).location.path, idIn(path));
      }
      return (cited) => {
        const id = ids.get(cited);
        if (id === undefined) throw new Error(`${team} saved no finding on ${cited}`);
        return id;
      };
    };
    const [ofA, ofB] = [await saved(teamA, "team-a"), await saved(teamB, "team-b")];
    const skill = fixture(`demo-plugin/first/${PLUGIN_SKILL}`);
    const manifest = fixture(`demo-plugin/first/${MANIFEST}`);

    // Both teams take the hidden line out, each in a commit of its own.
    const withoutLine = edited(skill, { 41: undefined });
    for (const [node, cited] of [[teamA, ofA], [teamB, ofB]] as const) {
      const commit = await node.patchCommit(component, [{ path: PLUGIN_SKILL, content: withoutLine }]);
      await node.publish(patchRecord(component, commit, [cited(PLUGIN_SKILL)]));
    }
    // The first team narrows the hosts on line 12 of the manifest, and the second the variables on line 13.
    const hosts = edited(manifest, { 12: '    "network": { "hosts": ["api.fellbeck-notes.example"] },' });
    const variables = edited(manifest, { 13: '    "env": { "read": ["FELLBECK_TOKEN"] }' });
    const done = { version: "1", type: "claim", component, kind: "patch", number: 1, findings: [ofA(MANIFEST)], intent: "new" };
    await teamA.publish(done, { ...patchRecord(component, await teamA.patchCommit(component, [{ path: MANIFEST, content: hosts }]), [ofA(MANIFEST)]), claim: await recordId(done) });
    await teamB.publish(patchRecord(component, await teamB.patchCommit(component, [{ path: MANIFEST, content: variables }]), [ofB(MANIFEST)]));
    // Two agents still run: one patches the off switch, the other reviews the code.
    await teamA.publish({ version: "1", type: "claim", component, kind: "patch", number: 2, findings: [ofA(SWITCH)], intent: "new" });
    await teamB.publish({ version: "1", type: "claim", component, kind: "review", number: 1, check: "code" });

    // The second team's hand-made patch, with the finding it names (KTD26).
    const changed = "out-of-scope/files/";
    await teamB.patchCommit(component, fixturesUnder(changed).map((path) => ({ path: path.slice(changed.length), content: fixture(path) })), { commit: made.commit });
    const records = fixturesUnder("out-of-scope/records/").filter((path) => path.endsWith(".json"));
    for (const path of records) await teamB.push(path.slice("out-of-scope/".length), fixture(path));

    // The first team's recipe for a copy that also takes the second team's patch. Its tree hash is published, not checked.
    const patches = { both: await idOf(skill, withoutLine), hosts: await idOf(manifest, hosts), variables: await idOf(manifest, variables) };
    await teamA.publish({ version: "1", type: "recipe", component, patches: Object.values(patches).sort(), tree: "4c".repeat(20) });
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const rejected = records.find((path) => path.includes("/patch/")) ?? "";
    return { on, component, view: await on.view(component), rejected: idIn(rejected), patches };
  }

  it("shows what the second and third steps leave: the shared patch, the two side by side, the rejected patch, the live claims and the recipe", async () => {
    const { on, component, view, rejected, patches } = await demo();
    // The view is what the demo leaves, in the shape of the protocol.
    expect(conforms(VIEW, view)).toBeUndefined();
    expect(view.pending).toEqual([]);
    expect(view.rejected).toEqual([{ node: NODE_B, hash: rejected, type: "patch", reason: "patch-out-of-scope" }]);

    const page = await pageOf(on, component);
    const counts = withTag(theOne(withTag(page, "header"), UPSTREAM), "dd").map(textOf);
    expect(counts).toEqual(["2", "6", "3"]);

    // Each team has one agent at work. The claim that a patch record cites is closed, and is not shown.
    const working = withClass(byId(page, "claims"), "claim").map((shown) => [NODE_A, NODE_B].filter((node) => textOf(shown).includes(asShown(node))));
    expect(working.sort()).toEqual([[NODE_A], [NODE_B]]);
    const groups = withClass(byId(page, "patches"), "group");
    expect(groups).toHaveLength(2);
    const shared = byId(page, `patch-${patches.both}`);
    expect(tagsOf(shared)).toEqual(["removes only", "confirmed by 2"]);
    expect(textOf(shared)).toContain(asShown(NODE_A));
    expect(textOf(shared)).toContain(asShown(NODE_B));
    const sideBySide = theOne(groups, "2 patches side by side");
    expect(withClass(sideBySide, "patch").map((entry) => entry.attributes["id"]).sort()).toEqual([`patch-${patches.hosts}`, `patch-${patches.variables}`].sort());
    expect(textOf(byId(page, `patch-${patches.hosts}`))).toContain(asShown(NODE_A));
    expect(textOf(byId(page, `patch-${patches.variables}`))).toContain(asShown(NODE_B));

    const [refused] = withTag(byId(page, "rejected"), "li");
    expect(textOf(refused)).toContain(asShown(NODE_B));
    expect(tagsOf(refused)).toEqual(["patch out of scope"]);
    const [recipe] = withClass(byId(page, "recipes"), "recipe");
    expect(textOf(recipe)).toContain("4c".repeat(20));
    // The recipe names its three patches, and each leads to that patch's entry.
    expect(linksOf(recipe).filter((href) => href.startsWith("#")).sort()).toEqual(Object.values(patches).map((id) => `#patch-${id}`).sort());
  });

  it("can be traced to the endpoint's JSON: every text is a value of the view or one of the page's own words, and every link and target a value of the view", async () => {
    const { on, component, view } = await demo();
    const page = await pageOf(on, component);

    // Every value the view holds, and every count of entries in it.
    const values = new Set<string>();
    const counts = new Set<string>([String(view.patches.flatMap((group) => group.patches).length)]);
    const collect = (held: unknown): void => {
      if (typeof held === "string" || typeof held === "number") values.add(String(held));
      else if (Array.isArray(held)) {
        counts.add(String(held.length));
        held.forEach(collect);
      } else if (typeof held === "object" && held !== null) Object.values(held).forEach(collect);
    };
    collect(view);
    const hashes = [...values].filter((value) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value));
    // The three ways the page writes a value down: as it is, an enumerated value with its hyphens as spaces, and a hash by its first eight characters.
    // A node's address is written a fourth way: an HTTPS address without its scheme.
    const isOfTheView = (text: string): boolean =>
      values.has(text) || values.has(`https://${text}`) || values.has(text.replaceAll(" ", "-")) || (text.length === 8 && hashes.some((hash) => hash.startsWith(text))) || counts.has(text);

    // The page's own words for this view. Each is a label, or says what a thing on the page is, and none says what to do (R35).
    const labels = [
      "Component",
      "commit ",
      "Every version of this repo on this index",
      "organizations",
      "findings",
      "patches",
      "Live claims",
      " live",
      "Findings",
      "Counts against ",
      "line ",
      "lines ",
      "–",
      "contradicts ",
      "finding ",
      "Reported by: ",
      "confirmed by ",
      "unconfirmed",
      "Patches",
      " patch",
      " patches side by side",
      "Written by: ",
      "−",
      "+",
      "patch ",
      "for ",
      "Recipes",
      " organization published this copy",
      "tree ",
      "published, not checked",
      "Rejected work",
    ];
    // What each section holds, under its heading.
    const sections = [
      "A claim is a team's notice that it has started a review or a fix. It stays live until that team publishes the result or the claim runs out.",
      "A finding is something a team's review reports seeing in this version, at the lines it names. It is that team's report, and no verdict of this index. The ones more organizations report stand first, and two organizations make a finding confirmed.",
      "A patch is a fix one team wrote for a finding, and it changes only the lines that finding names. Patches for the same lines stand side by side, the ones more organizations stand behind first.",
      "A recipe records the copy a team built for itself: the patches it took and the hash of the files that came out. The copies more organizations published come first.",
      "The index refused these records, because each failed one of its checks. A refused record counts for nothing on this page.",
    ];
    // What a finding says of the component, by its observation. One that names a host has the host between its words.
    const says = [
      "This component contains a hidden instruction for an agent.",
      "This component allows access to every environment variable.",
      "This component allows network access to any host.",
      "This component sends data to ",
      ".",
      "This component acts without reading a setting that its documentation says controls it.",
    ];
    // What each criterion of this view promises, and where its label leads.
    const promises = [
      "The promise that loading the component's text into an agent's context is safe.",
      "The promise that running the component with the permissions and network access it asks for is safe.",
      "The promise that the component does what its documentation says.",
      "The protocol defines each criterion. This label leads to that definition.",
    ];
    // What a label means, shown while the label is pointed at or focused.
    const meanings = [
      "A component is one version of an AI tool, such as a plugin, a skill or a server: its Git repository at one commit.",
      "The teams with records on this version. A team is counted by the address of its node, and nothing more is proven about who runs it. Each has a stone of its own color, which tells the teams apart and says nothing else.",
      "One stone for each organization that reports this finding, in that organization's color.",
      "Two or more organizations report this or have re-checked it, and their reports count against this criterion.",
      "Fewer than two organizations report this against this criterion. Two make it confirmed.",
      "Two or more organizations stand behind this patch. Each wrote the same patch, or re-checked it and found that it resolves its finding.",
      "Fewer than two organizations stand behind this patch. An organization stands behind a patch by writing the same one, or by re-checking it and finding that it resolves its finding.",
      "This patch only takes lines out. It adds no line and changes no file's mode.",
      "This patch adds or rewrites lines, or changes a file's mode.",
      "The team published this hash of its copy's files. The index has not built the copy, so it has not checked the hash.",
      "The patch adds a file, changes content that its findings do not cite, or changes lines outside the ones they cite.",
    ];
    const words = [...labels, ...sections, ...says, ...promises, ...meanings];
    expect([...new Set(texts(page).filter((text) => !isOfTheView(text)))].sort()).toEqual([...words].sort());

    // A target on the page is a section, a finding of the view or a patch of the view.
    const targets = elements(page).flatMap((element) => element.attributes["id"] ?? []);
    const known = new Set([
      ...["claims", "findings", "patches", "recipes", "rejected"],
      ...view.findings.flatMap((group) => group.findings.map(({ id }) => `finding-${id}`)),
      ...view.patches.flatMap((group) => group.patches.map(({ patchId }) => `patch-${patchId}`)),
    ]);
    expect(targets.filter((target) => !known.has(target))).toEqual([]);
    expect(new Set(targets).size).toBe(targets.length);
    // A link leads to a target on the page, to an HTTPS address that the view holds (KTD14), or to where the protocol defines a criterion, which is the page's own address.
    for (const href of linksOf(page)) {
      if (href.startsWith("#")) expect(targets).toContain(href.slice(1));
      else if (href !== PROTOCOL && href !== `/?repo=${encodeURIComponent(UPSTREAM)}`) expect([href, values.has(href), href.startsWith("https://")]).toEqual([href, true, true]);
    }
    // The page's own address is the target of each criterion's label, and of nothing else.
    expect(withTag(page, "a").filter((link) => link.attributes["href"] === PROTOCOL).map((link) => classesOf(link))).toEqual([["badge"], ["badge"], ["badge"]]);
    expect(linksOf(page)).toEqual(expect.arrayContaining([UPSTREAM, NODE_A, NODE_B]));
    // No element carries anything else: a class, a mark for decoration and the mark of a label that can be focused are the page's own.
    for (const element of elements(page)) {
      for (const name of Object.keys(element.attributes)) expect(["class", "id", "href", "aria-hidden", "tabindex"]).toContain(name);
    }
  });
});
