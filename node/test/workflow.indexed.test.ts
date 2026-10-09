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
});
