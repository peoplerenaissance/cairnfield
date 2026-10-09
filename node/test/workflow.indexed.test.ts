// What the Workflow does once a push has started it, on a node with an index address
// (R7, KTD9). The Vitest config sets the address and the node's base URL for this file.

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH } from "./push-event.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the push Workflow of a node with an index address", () => {
  it("sends the index one notice with the node's base URL", async () => {
    // Every request the Worker sends out, answered as the index answers a notice.
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_PUSH, "push-1");
    await env.ON_PUSH.create({ id: "push-1", params: PUSH });
    await instance.waitForStatus("complete");

    expect(sent).toHaveBeenCalledTimes(1);
    const request = new Request(...(sent.mock.calls[0] as Parameters<typeof fetch>));
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://index.cairnfield.example/notices");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({ node: "https://node.team-a.example" });
  });

  it("sends the notice again while the index is busy or failing, and stops once the index takes it", async () => {
    const answers = [new Response(null, { status: 503 }), new Response(null, { status: 429 })];
    const sent = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => answers.shift() ?? Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_PUSH, "push-2");
    // Every attempt still runs. Only the wait between two attempts is left out.
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await env.ON_PUSH.create({ id: "push-2", params: PUSH });
    await instance.waitForStatus("complete");

    expect(sent).toHaveBeenCalledTimes(3);
  });

  it("does not send again a notice the index refuses", async () => {
    const sent = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ version: "1", error: "bad-request" }, { status: 400 }));

    await using instance = await introspectWorkflowInstance(env.ON_PUSH, "push-3");
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await env.ON_PUSH.create({ id: "push-3", params: PUSH });
    await instance.waitForStatus("complete");

    expect(sent).toHaveBeenCalledTimes(1);
  });
});
