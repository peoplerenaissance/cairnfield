// What the Workflow does once a push has started it, on a node with no index address
// (KTD40). The push trigger itself fires only on a deployed node, so no test covers it.

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH } from "./push-event.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the push Workflow of a node with no index address", () => {
  it("sends no notice", async () => {
    // The Wrangler config sets no index address, and the Workflow engine runs with its variables.
    expect(env.INDEX_URL).toBe("");
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_PUSH, "push-1");
    await env.ON_PUSH.create({ id: "push-1", params: PUSH });
    await instance.waitForStatus("complete");

    expect(sent).not.toHaveBeenCalled();
  });
});
