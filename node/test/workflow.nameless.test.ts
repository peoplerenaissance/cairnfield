// What the Workflow does on a node that has an index address and was deployed without
// its own base URL. The Vitest config sets only the index address for this file.

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH } from "./push-event.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the push Workflow of a node that does not know its own address", () => {
  it("sends no notice, and its instance ends in an error", async () => {
    expect(env.NODE_URL).toBe("");
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_PUSH, "push-1");
    await env.ON_PUSH.create({ id: "push-1", params: PUSH });
    await instance.waitForStatus("errored");

    expect(sent).not.toHaveBeenCalled();
  });
});
