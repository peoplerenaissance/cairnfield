// What the Workflow does on a node whose address has a path. The address is in the
// accepted spelling, but this Worker answers at the root of its host. The Vitest config
// sets that address and an index address for this file.

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH } from "./push-event.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the push Workflow of a node whose address has a path", () => {
  it("sends no notice, and its instance ends in an error", async () => {
    expect(env.NODE_URL).toBe("https://nodes.cairnfield.example/team-a");
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ version: "1" }));

    await using instance = await introspectWorkflowInstance(env.ON_PUSH, "push-1");
    await env.ON_PUSH.create({ id: "push-1", params: PUSH });
    await instance.waitForStatus("errored");

    expect(sent).not.toHaveBeenCalled();
  });
});
