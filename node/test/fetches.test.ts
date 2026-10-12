// A fork's fetch count (R45, KTD43): what the fetch Workflow counts once an event has
// started it, and what the `fetches` route answers. The two fetch triggers fire only on a
// deployed node, so a test starts the Workflow by hand with a saved event. The node here
// has no index address, so it sends no notice. Every host, team and component is invented.

import { introspectWorkflowInstance, listDurableObjectIds, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { FakeArtifacts } from "./fake-artifacts.ts";
import { CLONED, COMPONENT, FETCHED } from "./fetch-event.ts";
import { UPSTREAM, answer, forkCopy, importCopy, nodeOver } from "./node.ts";
import { PUSH } from "./push-event.ts";

afterEach(reset);

const NOT_FOUND = { status: 404, body: { error: "not-found" } };
const BAD_REQUEST = { status: 400, body: { error: "bad-request" } };

let deliveries = 0;

/**
 * Starts the fetch Workflow with an event, as a trigger does on a deployed node, and
 * waits until the instance has ended. Each delivery is an instance of its own.
 */
async function deliver(event: object): Promise<void> {
  deliveries += 1;
  const id = `fetch-${deliveries}`;
  await using instance = await introspectWorkflowInstance(env.ON_FETCH, id);
  await env.ON_FETCH.create({ id, params: event });
  await instance.waitForStatus("complete");
}

/** A clone event for another repo of the namespace, with an ID of its own. */
const cloneOf = (repoName: string) => ({ ...CLONED, id: `clone-of-${repoName}`, source: { ...CLONED.source, repoName } });

/** What a node answers when it is asked for a component's count. The node holds no repo: the route reads none. */
const asked = (component: string) => answer(nodeOver(new FakeArtifacts()).get(`fetches?component=${component}`));

const counted = (component: string, fetches: number) => ({ status: 200, body: { component, fetches } });

/** The objects the node has started, of any name. */
const started = async () => (await listDurableObjectIds(env.READ_TOKENS)).map(String).sort();

/** Everything the object of a component's fork holds. */
function held(component: string): Promise<Map<string, unknown>> {
  const object = env.READ_TOKENS.get(env.READ_TOKENS.idFromName(`fork-${component}`));
  return runInDurableObject(object, (_instance, state) => state.storage.list());
}

/** A node with a fork that is ready. */
async function nodeWithFork() {
  const artifacts = new FakeArtifacts();
  const node = nodeOver(artifacts);
  const pinned = await artifacts.push(UPSTREAM, "main", { "README.md": "# Demo plugin\n" });
  await importCopy(node, artifacts, "main", pinned);
  return { artifacts, node, pinned, fork: await forkCopy(node, artifacts, pinned) };
}

describe("a fork's fetch count", () => {
  it("is 1 after one fetch event for the fork, which is what a fetch into a repo that holds a commit sends", async () => {
    await deliver(FETCHED);
    expect(await asked(COMPONENT)).toEqual(counted(COMPONENT, 1));
  });

  it("is 1 after one clone event for the fork, which is what a fetch into a repo that holds nothing sends", async () => {
    await deliver(CLONED);
    expect(await asked(COMPONENT)).toEqual(counted(COMPONENT, 1));
  });

  it("counts an event that is delivered twice once, and the next event after it", async () => {
    await deliver(CLONED);
    // The same event again, with the same ID, in an instance of its own.
    await deliver(CLONED);
    expect(await asked(COMPONENT)).toEqual(counted(COMPONENT, 1));

    await deliver(FETCHED);
    expect(await asked(COMPONENT)).toEqual(counted(COMPONENT, 2));
  });

  it("belongs to one fork", async () => {
    const other = "2e".repeat(20);
    await deliver(CLONED);
    await deliver(cloneOf(`fork-${other}`));
    await deliver(FETCHED);
    expect(await asked(COMPONENT)).toEqual(counted(COMPONENT, 2));
    expect(await asked(other)).toEqual(counted(other, 1));
  });

  const NOT_COUNTED: readonly (readonly [what: string, event: object])[] = [
    ["a clone of the team repo", cloneOf("team")],
    ["a clone of the component copy", cloneOf(`copy-${COMPONENT}`)],
    ["a clone of a repo whose name only ends as a fork's does", cloneOf(`not-a-fork-${COMPONENT}`)],
    ["a push to the fork", { ...PUSH, source: { ...PUSH.source, repoName: `fork-${COMPONENT}` } }],
  ];

  it.each(NOT_COUNTED)("is not raised by %s", async (_what, event) => {
    await deliver(CLONED);
    const before = await started();

    await deliver(event);
    expect(await asked(COMPONENT)).toEqual(counted(COMPONENT, 1));
    // The event reached no object of another name either.
    expect(await started()).toEqual(before);
  });

  it("is missing, and not zero, for a fork with no counted fetch, and asking for it leaves the fork's object as it was", async () => {
    const { node, pinned } = await nodeWithFork();
    // The object holds the fork's read token by now, and no count.
    expect((await node.get(`read-token?component=${pinned}`)).status).toBe(200);
    const before = await held(pinned);
    expect(before.size).toBeGreaterThan(0);

    expect(await answer(node.get(`fetches?component=${pinned}`))).toEqual(NOT_FOUND);
    expect(await held(pinned)).toEqual(before);
    // A component with no fork has none either.
    expect(await answer(node.get(`fetches?component=${COMPONENT}`))).toEqual(NOT_FOUND);
    expect(await held(COMPONENT)).toEqual(new Map());
  });

  it("is gone once a removed fork is made anew", async () => {
    const { artifacts, node, pinned, fork } = await nodeWithFork();
    await deliver(cloneOf(fork));
    expect(await answer(node.get(`fetches?component=${pinned}`))).toEqual(counted(pinned, 1));

    artifacts.remove(fork);
    await forkCopy(node, artifacts, pinned);
    expect(await answer(node.get(`fetches?component=${pinned}`))).toEqual(NOT_FOUND);
  });
});

describe("a query for a fetch count that the contract does not allow", () => {
  const BAD_QUERIES: readonly (readonly [why: string, path: string])[] = [
    ["no query", "fetches"],
    ["a name the contract does not have", `fetches?component=${COMPONENT}&repo=team`],
    ["a component given twice", `fetches?component=${COMPONENT}&component=${COMPONENT}`],
    ["a component of 39 characters", `fetches?component=${COMPONENT.slice(1)}`],
    ["a component in upper case", `fetches?component=${COMPONENT.toUpperCase()}`],
    ["a branch name for a component", "fetches?component=main"],
  ];

  it.each(BAD_QUERIES)("is refused: %s", async (_why, path) => {
    // The fork has a count, so a query that got through would be answered with it.
    await deliver(CLONED);
    expect(await answer(nodeOver(new FakeArtifacts()).get(path))).toEqual(BAD_REQUEST);
  });
});
