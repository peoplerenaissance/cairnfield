// What the fetch Workflow does on a node whose index address ends in a slash, which no
// notice can be sent to (KTD43). The Vitest config sets that address and the node's base
// URL for this file.

import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeArtifacts } from "./fake-artifacts.ts";
import { CLONED, COMPONENT } from "./fetch-event.ts";
import { answer, nodeOver } from "./node.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("the fetch Workflow of a node whose index address ends in a slash", () => {
  it("keeps the count of a fetch it can send no notice for, and counts that fetch once", async () => {
    expect(env.INDEX_URL).toBe("https://index.cairnfield.example/");
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: "1" }));
    const asked = () => answer(nodeOver(new FakeArtifacts()).get(`fetches?component=${COMPONENT}`));
    const once = { status: 200, body: { component: COMPONENT, fetches: 1 } };

    await using first = await introspectWorkflowInstance(env.ON_FETCH, "fetch-1");
    await env.ON_FETCH.create({ id: "fetch-1", params: CLONED });
    await first.waitForStatus("errored");

    expect(sent).not.toHaveBeenCalled();
    expect(await asked()).toEqual(once);

    // The event again, as after an instance that failed.
    await using second = await introspectWorkflowInstance(env.ON_FETCH, "fetch-2");
    await env.ON_FETCH.create({ id: "fetch-2", params: CLONED });
    await second.waitForStatus("errored");

    expect(sent).not.toHaveBeenCalled();
    expect(await asked()).toEqual(once);
  });
});
