// The public page (R14, R15, R16): what the page of one component commit shows. The page
// reads only the data endpoint (KTD14). So each test asks the index for a view as the
// page's script does, and hands the answer to the functions that script calls. They give
// the page as a tree of elements, which the script turns into the document. No test runs
// a browser.

import { VIEW, conforms, recordId } from "@cairnfield/protocol";
import type { View } from "@cairnfield/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NOTHING_READ, draw, placeOf, readOf } from "../src/page/render.ts";
import type { Drawing, Drawn, Held, Place } from "../src/page/render.ts";
import { BRANCH, FILES, HOST, INDEX, NODE_A, NODE_B, NODE_C, README, README_TEXT, SKILL, SKILL_FIXED, SKILL_TEXT, START, UPSTREAM, bench, claim, clockAt, demoPlugin, edited, finding, fixture, fixturesUnder, freshIndexForEachTest, idOf, onReadme, patchRecord, publishPatch, synced } from "./bench.ts";
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

/** One read by the page at an address: the script asks the index for the view its address names, and draws the answer. */
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

/** The status labels on an element, each as a reader reads it. */
const tagsOf = (root: Drawing | undefined): string[] => withClass(root, "tag").map(textOf);

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
    expect(textOf(row)).toContain(NODE_A);
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
    const counts = withTag(head, "dl").flatMap((list) => list.children.filter(isElement)).map((count) => [textOf(theOne(withTag(count, "dd"), "")), textOf(theOne(withTag(count, "dt"), ""))]);
    expect(counts).toEqual([
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
    expect(textOf(shown)).toContain(NODE_A);
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
    expect(textOf(alone)).toContain(NODE_A);
    expect(textOf(alone)).not.toContain(NODE_B);
    const shared = theOne(rows, "sends data to host");
    expect(tagsOf(shared)).toEqual(["confirmed by 2"]);
    expect(textOf(shared)).toContain(NODE_A);
    expect(textOf(shared)).toContain(NODE_B);
    expect(textOf(shared)).toContain(HOST);
  });

  it("shows where a finding points: its path and lines, and the line it contradicts", async () => {
    const { on, one, component } = await twoNodes();
    await one.publish(
      finding(component, { location: { path: README, start: 11, end: 13 }, criterion: "works-as-documented", observation: "documented-control-not-read", contradicts: { path: SKILL, start: 2, end: 2 }, check: "code" }),
    );
    await synced(on, NODE_A);

    const [row] = withClass(byId(await pageOf(on, component), "findings"), "finding");
    expect(textOf(row)).toContain("documented control not read");
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
    expect(textOf(lists[0])).toContain("hidden instruction");
    expect(textOf(lists[2])).toContain("fails on documented input");
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
    expect(textOf(rows[0])).not.toContain(NODE_B);
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
    const dispute = theOne(withClass(row, "dispute"), NODE_C);
    expect(textOf(dispute)).toContain("documented behavior");
    expect(textOf(dispute)).toContain(`${README}line 30`);
    // A dispute changes no count.
    expect(tagsOf(row)).toEqual(["unconfirmed"]);
  });
});

describe("patches (R16)", () => {
  it("covers AE3: lists both organizations on a patch that two teams wrote identically, as one entry", async () => {
    const { on, one, other, component } = await twoNodes();
    await publishPatch(one, component, {}, [{ path: SKILL, content: SKILL_FIXED }]);
    await publishPatch(other, component, { location: { path: SKILL, start: 2, end: 3 } }, [{ path: SKILL, content: SKILL_FIXED }]);
    await synced(on, NODE_A);
    await synced(on, NODE_B);

    const [entry, ...more] = withClass(byId(await pageOf(on, component), "patches"), "patch");
    expect(more).toEqual([]);
    expect(textOf(entry)).toContain(NODE_A);
    expect(textOf(entry)).toContain(NODE_B);
    expect(tagsOf(entry)).toEqual(["removes only", "confirmed by 2"]);
    expect(entry?.attributes["id"]).toBe(`patch-${await idOf(SKILL_TEXT, SKILL_FIXED)}`);
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
    expect(textOf(first)).toContain(NODE_A);
    expect(textOf(first)).not.toContain(NODE_B);
    expect(textOf(second)).toContain(NODE_B);
    expect(textOf(second)).not.toContain(NODE_A);
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
    expect(textOf(entry)).toContain(NODE_A);
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
    expect(textOf(theOne(withClass(entry, "recheck"), NODE_B))).toContain("resolves");
    expect(textOf(theOne(withClass(entry, "recheck"), NODE_C))).toContain("does not resolve");
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
    expect(textOf(shown)).toContain(NODE_A);
    expect(textOf(shown)).toContain(NODE_B);
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
    expect(textOf(row)).toContain(NODE_B);
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
    expect(placeAt(address)).toEqual({ component, narrowed: true, viewPath: `/components/${component}/view?teams=${encodeURIComponent(NODE_A)}` });
    const narrowed = await pageOf(on, component, `?teams=${encodeURIComponent(NODE_A)}`);
    expect(textOf(narrowed)).not.toContain(NODE_B);
    expect(textOf(narrowed)).toContain(NODE_A);
    expect(withClass(byId(narrowed, "findings"), "finding")).toHaveLength(1);
    expect(textOf(byId(narrowed, "claims"))).toContain("No live claims");
    const notice = byId(narrowed, "narrowed");
    expect(textOf(notice)).toContain("Narrowed view");
    // It names the organizations whose work is shown.
    expect(textOf(notice)).toContain(NODE_A);

    // The whole view shows both teams, and says nothing of the kind.
    expect(placeAt(`/components/${component}`)).toEqual({ component, narrowed: false, viewPath: `/components/${component}/view` });
    const whole = await pageOf(on, component);
    expect(textOf(whole)).toContain(NODE_B);
    expect(withClass(byId(whole, "findings"), "finding")).toHaveLength(2);
    expect(byId(whole, "narrowed")).toBeUndefined();
    expect(textOf(whole)).not.toMatch(/narrowed/i);
  });

  it("passes each team of the query on, and no other part of the address", async () => {
    const component = "1f".repeat(20);
    const both = `teams=${encodeURIComponent(NODE_A)}&teams=${encodeURIComponent(NODE_B)}`;
    expect(placeAt(`/components/${component}?${both}&shown=all#patches`).viewPath).toBe(`/components/${component}/view?${both}`);
  });

  it("stands at the address of a component and at no other", () => {
    expect(placeOf("/components/not-a-commit", "")).toBeUndefined();
    expect(placeOf(`/components/${"1F".repeat(20)}`, "")).toBeUndefined();
    expect(placeOf(`/components/${"1f".repeat(20)}/view`, "")).toBeUndefined();
    expect(placeOf("/", "")).toBeUndefined();
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

    // The index answers with a refusal that is no view.
    const refused = await on.call("GET", `/components/${component}/view?shown=all`);
    expect(refused.status).toBe(400);
    const failed = draw(placeAt(address), first.held, readOf(refused.body), START + 2000);
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

  const drawnFrom = (place: Place, view: View): Drawing => {
    const { body } = draw(place, NOTHING_READ, readOf(JSON.parse(JSON.stringify(view))), START);
    if (!body) throw new Error("the first read drew no page");
    return body;
  };

  it("is shown as text when it holds markup: a Git URL and a node URL", async () => {
    const { place, view } = await served();
    // The index takes neither spelling in a registration. The page is handed them as an index that did would serve them.
    const gitUrl = "https://git.fellbeck-tools.example/<img src=x onerror=alert(1)>.git";
    const nodeUrl = 'https://node.team-a.example/"><script>alert(1)</script><b class="org">';
    const plain = drawnFrom(place, view);
    const hostile = drawnFrom(place, replaced(replaced(view, UPSTREAM, gitUrl), NODE_A, nodeUrl));

    // Each is one text of the page, whole and unchanged.
    expect(texts(hostile)).toContain(gitUrl);
    expect(texts(hostile)).toContain(nodeUrl);
    expect(texts(hostile).filter((text) => text === nodeUrl)).toHaveLength(texts(plain).filter((text) => text === NODE_A).length);
    // The page is made of the same elements as with plain values: no value became an element or the name of an attribute.
    const shape = (page: Drawing): unknown[] => elements(page).map((element) => [element.tag, Object.keys(element.attributes)]);
    expect(shape(hostile)).toEqual(shape(plain));
    expect(withTag(hostile, "img")).toEqual([]);
    expect(withTag(hostile, "script")).toEqual([]);
    // Neither address reaches an attribute but as the target of its own link, and no class is made from one.
    for (const element of elements(hostile)) {
      for (const [name, value] of Object.entries(element.attributes)) {
        if (name === "href") expect([gitUrl, nodeUrl]).toContain(value);
        else expect(value).not.toMatch(/[<>"]/);
      }
    }
  });

  it("is no link when it is a node URL that is not HTTPS, and is shown as text", async () => {
    const { place, view } = await served();
    const plain = drawnFrom(place, view);
    // An HTTPS node URL is a link to the node, and the Git URL a link to the repo.
    expect(linksOf(plain)).toContain(NODE_A);
    expect(linksOf(plain)).toContain(UPSTREAM);

    for (const spelling of ["http://node.team-a.example", "javascript:alert(1)//node.team-a.example", "//node.team-a.example", "node.team-a.example"]) {
      const page = drawnFrom(place, replaced(replaced(view, NODE_A, spelling), UPSTREAM, spelling));
      expect(texts(page)).toContain(spelling);
      expect(linksOf(page).filter((href) => !href.startsWith("#"))).toEqual([]);
      for (const link of withTag(page, "a")) expect(textOf(link)).not.toContain(spelling);
    }
  });
});

describe("the page's address on the index (KTD14)", () => {
  /** The directives of a content security policy, each with its sources. */
  function policyOf(response: Response): Map<string, string[]> {
    const directives = (response.headers.get("content-security-policy") ?? "").split(";").map((directive) => directive.trim().split(/\s+/));
    return new Map(directives.flatMap(([name, ...sources]) => (name ? [[name.toLowerCase(), sources]] : [])));
  }

  it("answers the page with a content security policy that allows no inline script", async () => {
    const on = bench();
    const component = await on.component();

    const response = await on.get(`/components/${component}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = policyOf(response);
    // Scripts, styles and fetches come from the page's own origin, and nothing else is allowed.
    expect(policy.get("default-src")).toEqual(["'none'"]);
    expect(policy.get("script-src")).toEqual(["'self'"]);
    expect(policy.get("style-src")).toEqual(["'self'"]);
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    for (const [directive, sources] of policy) {
      if (!["script-src", "style-src", "connect-src"].includes(directive)) expect([directive, sources]).toEqual([directive, ["'none'"]]);
    }
    expect(response.headers.get("content-security-policy")).not.toMatch(/unsafe|nonce-|sha(256|384|512)-|data:|https?:|\*/);

    // The page works under that policy: it is the file of `src/page/`, with no script, style or handler written into it.
    const html = await response.text();
    expect(html).toBe(env.PAGE_FILES["page.html"]);
    expect(html).toContain('<main id="view">');
    expect(html).toContain('id="status"');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style|\sstyle\s*=|\son[a-z]+\s*=/i);
    // What it loads are files the index serves itself.
    const loaded = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map(([, path = ""]) => path).sort();
    expect(loaded).toEqual(["/page/poll.js", "/page/styles.css"]);
  });

  it("serves the page's script and stylesheet with their media types, and never lets a browser guess one", async () => {
    const on = bench();
    for (const [path, type] of [
      ["/page/poll.js", "text/javascript; charset=utf-8"],
      ["/page/render.js", "text/javascript; charset=utf-8"],
      ["/page/styles.css", "text/css; charset=utf-8"],
    ] as const) {
      const response = await on.get(path);
      expect([path, response.status]).toEqual([path, 200]);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(await (await on.get("/page/styles.css")).text()).toBe(env.PAGE_FILES["styles.css"]);
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
    // The page is served for a component and under no name of its own.
    expect(await on.call("GET", "/page/page.html")).toEqual(notFound);
    expect(await on.call("GET", "/page/")).toEqual(notFound);
    expect(await on.call("GET", "/page/..%2Fwrangler.jsonc")).toEqual(notFound);
    expect(await on.call("POST", `/components/${"1f".repeat(20)}`)).toEqual(notFound);
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
    const working = withClass(byId(page, "claims"), "claim").map((shown) => [NODE_A, NODE_B].filter((node) => textOf(shown).includes(node)));
    expect(working.sort()).toEqual([[NODE_A], [NODE_B]]);
    const groups = withClass(byId(page, "patches"), "group");
    expect(groups).toHaveLength(2);
    const shared = byId(page, `patch-${patches.both}`);
    expect(tagsOf(shared)).toEqual(["removes only", "confirmed by 2"]);
    expect(textOf(shared)).toContain(NODE_A);
    expect(textOf(shared)).toContain(NODE_B);
    const sideBySide = theOne(groups, "2 patches side by side");
    expect(withClass(sideBySide, "patch").map((entry) => entry.attributes["id"]).sort()).toEqual([`patch-${patches.hosts}`, `patch-${patches.variables}`].sort());
    expect(textOf(byId(page, `patch-${patches.hosts}`))).toContain(NODE_A);
    expect(textOf(byId(page, `patch-${patches.variables}`))).toContain(NODE_B);

    const [refused] = withTag(byId(page, "rejected"), "li");
    expect(textOf(refused)).toContain(NODE_B);
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
    const isOfTheView = (text: string): boolean =>
      values.has(text) || values.has(text.replaceAll(" ", "-")) || (text.length === 8 && hashes.some((hash) => hash.startsWith(text))) || counts.has(text);

    // The page's own words for this view. Each is a label, and none says what to do.
    const words = [
      "Component",
      "commit ",
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
      "confirmed by ",
      "unconfirmed",
      "Patches",
      " patch",
      " patches side by side",
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
    // A link leads to a target on the page, or to an HTTPS address that the view holds (KTD14).
    for (const href of linksOf(page)) {
      if (href.startsWith("#")) expect(targets).toContain(href.slice(1));
      else expect([href, values.has(href), href.startsWith("https://")]).toEqual([href, true, true]);
    }
    expect(linksOf(page)).toEqual(expect.arrayContaining([UPSTREAM, NODE_A, NODE_B]));
    // No element carries anything else: a class and a mark for decoration are the page's own.
    for (const element of elements(page)) {
      for (const name of Object.keys(element.attributes)) expect(["class", "id", "href", "aria-hidden"]).toContain(name);
    }
  });
});
