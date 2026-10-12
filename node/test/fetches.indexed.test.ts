// What the fetch Workflow tells the index, on a node with an index address (KTD43). The
// Vitest config sets the address and the node's base URL for this file.

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

const counted = (fetches: number) => ({ status: 200, body: { component: COMPONENT, fetches } });
const asked = () => answer(nodeOver(new FakeArtifacts()).get(`fetches?component=${COMPONENT}`));

describe("the fetch Workflow of a node with an index address", () => {
  it("counts the fetch and sends the index one notice with the node's base URL", async () => {
    // Every request the Worker sends out, answered as the index answers a notice.
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_FETCH, "fetch-1");
    await env.ON_FETCH.create({ id: "fetch-1", params: CLONED });
    await instance.waitForStatus("complete");

    expect(sent).toHaveBeenCalledTimes(1);
    const request = new Request(...(sent.mock.calls[0] as Parameters<typeof fetch>));
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://index.cairnfield.example/notices");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({ node: "https://node.team-a.example" });
    expect(await asked()).toEqual(counted(1));
  });

  it("counts the fetch once while it sends the notice again to an index that is busy or failing", async () => {
    const answers = [new Response(null, { status: 503 }), new Response(null, { status: 429 })];
    const sent = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => answers.shift() ?? Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_FETCH, "fetch-2");
    // Every attempt still runs. Only the wait between two attempts is left out.
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await env.ON_FETCH.create({ id: "fetch-2", params: CLONED });
    await instance.waitForStatus("complete");

    expect(sent).toHaveBeenCalledTimes(3);
    expect(await asked()).toEqual(counted(1));
  });

  it("sends no notice for an event it does not count", async () => {
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_FETCH, "fetch-3");
    // The triggers fire for every repo of the namespace. This is a clone of the team repo.
    await env.ON_FETCH.create({ id: "fetch-3", params: { ...CLONED, source: { ...CLONED.source, repoName: "team" } } });
    await instance.waitForStatus("complete");

    expect(sent).not.toHaveBeenCalled();
  });
});
