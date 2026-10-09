// What the Workflow does on a node whose index address has a slash at its end. The
// notice route is joined to that address, so the notice would go to `//notices`. The
// Vitest config sets that address and the node's base URL for this file.

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH } from "./push-event.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the push Workflow of a node whose index address has a slash at its end", () => {
  it("sends no notice, and its instance ends in an error", async () => {
    expect(env.INDEX_URL).toBe("https://index.cairnfield.example/");
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_PUSH, "push-1");
    await env.ON_PUSH.create({ id: "push-1", params: PUSH });
    await instance.waitForStatus("errored");

    expect(sent).not.toHaveBeenCalled();
  });
});
