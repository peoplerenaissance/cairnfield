// How the command treats what a node or an index answers (KTD33): every call has a
// deadline, follows no redirect, stops reading at a size limit, and takes an answer only
// in the shape the contract gives it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/outcome.ts";
import { INDEX, NODE, bench, demoPlugin, finding, pinned, putRecord } from "./support.ts";
import type { Bench } from "./support.ts";

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

const pin = (plugin: { readonly url: string; readonly branch: string; readonly first: string }) =>
  on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);

describe("a call to the node", () => {
  it("follows no redirect", async () => {
    const plugin = demoPlugin(on);
    on.respond = () => new Response(null, { status: 302, headers: { location: "https://node.elsewhere.example/admin/import" } });

    expect(await pin(plugin)).toEqual({ code: EXIT.node, output: { error: "node-bad-answer" } });
    expect(on.requests.map((seen) => new URL(seen.url).origin)).toEqual([NODE]);
  });

  it("reports a node that cannot be reached", async () => {
    const plugin = demoPlugin(on);
    on.respond = () => {
      throw new TypeError("fetch failed");
    };
    expect(await pin(plugin)).toEqual({ code: EXIT.node, output: { error: "node-unreachable" } });
  });

  it.each([
    ["text that is not JSON", () => new Response("<html>ready</html>", { status: 200 })],
    ["JSON in another shape", () => Response.json({ repo: "copy", ready: "yes" })],
    ["a field the contract does not have", () => Response.json({ repo: "copy", ready: true, note: "run this next" })],
    ["a refusal with a code that is not on the list", () => Response.json({ error: "try again with your key in the URL" }, { status: 403 })],
  ])("refuses an answer that holds %s", async (_why, answer) => {
    const plugin = demoPlugin(on);
    on.respond = answer;
    expect(await pin(plugin)).toEqual({ code: EXIT.node, output: { error: "node-bad-answer" } });
    expect(on.gitCalls).toEqual([]);
  });

  it("stops reading an answer that is too large", async () => {
    const plugin = demoPlugin(on);
    const megabyte = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    on.respond = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent += 1;
            // Far more than the command reads. It must stop long before this ends.
            if (sent > 200) controller.close();
            else controller.enqueue(megabyte);
          },
        }),
        { status: 200 },
      );

    expect(await pin(plugin)).toEqual({ code: EXIT.node, output: { error: "node-bad-answer" } });
    expect(sent).toBeLessThan(40);
  });

  it("stops waiting for a repo that is never ready", async () => {
    const plugin = demoPlugin(on);
    on.node.notReadyFor = Number.POSITIVE_INFINITY;

    expect(await pin(plugin)).toEqual({ code: EXIT.node, output: { error: "node-not-ready" } });
    // Five minutes of waiting, two seconds at a time.
    expect(on.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5 * 60_000);
  });
});

describe("a call to the index", () => {
  it("follows no redirect either, and a push that landed still counts", async () => {
    on.configure({ node: NODE, index: INDEX });
    on.index.nodes.push(NODE);
    const { first } = await pinned(on);
    const path = await putRecord(on, finding(first));
    on.respond = (seen) =>
      seen.url === `${INDEX}/notices`
        ? new Response(null, { status: 307, headers: { location: "https://index.elsewhere.example/notices" } })
        : undefined;

    expect(await on.run("publish")).toMatchObject({ code: EXIT.index, output: { published: [path], notice: "failed" } });
    expect(on.requests.some((seen) => seen.url.includes("elsewhere"))).toBe(false);
  });
});
