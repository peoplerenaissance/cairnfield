// What the setup script does, with a stand-in for Wrangler, a fake node behind `fetch`
// and its output kept in a list. No test imports `setup.ts`, which runs the script on
// this machine's Wrangler. So no test starts Wrangler, and none reaches a network or a
// Cloudflare account. Every host here is invented.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupNode } from "./setup-node.ts";
import type { Io, WranglerCall } from "./setup-node.ts";

const NODE = "https://node.team-a.example";
const INDEX = "https://index.cairnfield.example";

/** What a node with no team repo yet answers to a read of its records. */
const fresh = (): Response => Response.json({ error: "not-found" }, { status: 404 });

interface Stand {
  /** Whether Wrangler has a login. */
  readonly loggedIn?: boolean;
  /** The exit code of each deploy, in turn. A deploy past the end of the list ends with 0. */
  readonly deploys?: readonly number[];
  /** The targets Wrangler writes in its record of a deploy. */
  readonly targets?: readonly string[];
  /** What answers a read of the node's records after the deploy. */
  readonly answer?: () => Response;
}

interface Bench {
  readonly io: Io;
  /** Every run of Wrangler, in turn. */
  readonly ran: { readonly args: readonly string[]; readonly call: WranglerCall }[];
  /** Every address the script read. */
  readonly read: string[];
  /** The files Wrangler was asked to write a record of a deploy to. */
  readonly records: string[];
  /** Everything the script told the operator. */
  text(): string;
  /** What the script had told the operator when the first deploy began. */
  textBeforeDeploy(): string;
}

function bench(stand: Stand = {}): Bench {
  const ran: Bench["ran"] = [];
  const read: string[] = [];
  const records: string[] = [];
  const said: string[] = [];
  let deploys = 0;
  let saidBeforeDeploy: number | undefined;
  const io: Io = {
    wrangler: async (args, call) => {
      ran.push({ args, call });
      if (args[0] === "whoami") return stand.loggedIn === false ? 1 : 0;
      saidBeforeDeploy ??= said.length;
      const code = stand.deploys?.[deploys] ?? 0;
      deploys += 1;
      // Wrangler adds one line of JSON to the file this variable names for each thing it did.
      const record = call.env?.["WRANGLER_OUTPUT_FILE_PATH"];
      if (record !== undefined) {
        records.push(record);
        appendFileSync(record, `${JSON.stringify({ type: "wrangler-session", version: 1, command_line_args: args })}\n`);
        if (code === 0) {
          const targets = stand.targets ?? [NODE, "workflow: cairnfield-node-on-push", "event triggers: 1"];
          appendFileSync(record, `${JSON.stringify({ type: "deploy", version: 1, worker_name: "cairnfield-node", targets })}\n`);
        }
      }
      return code;
    },
    fetch: async (input) => {
      read.push(String(input));
      return (stand.answer ?? fresh)();
    },
    say: (line) => {
      said.push(line);
    },
  };
  return {
    io,
    ran,
    read,
    records,
    text: () => said.join("\n"),
    textBeforeDeploy: () => said.slice(0, saidBeforeDeploy).join("\n"),
  };
}

const argsOf = (on: Bench): readonly (readonly string[])[] => on.ran.map(({ args }) => args);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the setup script, given the node's address", () => {
  it("checks the login, says what it creates, deploys once, reads the node and says what is left to do", async () => {
    const on = bench();

    expect(await setupNode(on.io, ["--url", NODE])).toBe(0);

    expect(argsOf(on)).toEqual([
      ["whoami", "--json"],
      ["deploy", "--env=", "--var", `NODE_URL:${NODE}`, "--var", "INDEX_URL:"],
    ]);
    // The answer to the login check names the account, so the operator's terminal does not show it.
    expect(on.ran.map(({ call }) => call.shown)).toEqual([false, true]);
    expect(on.textBeforeDeploy()).toContain("It deletes nothing.");
    expect(on.read).toEqual([`${NODE}/records`]);
    expect(on.text()).toContain(`The node answers at ${NODE}`);
    expect(on.text()).toContain("openssl rand -hex 32");
    expect(on.text()).toContain('npx wrangler secret put ADMIN_KEY --env=""');
    expect(on.text()).toContain(`{ "node": "${NODE}" }`);
  });

  it("hands a custom domain and an index address on to the deploy", async () => {
    const on = bench();

    expect(await setupNode(on.io, ["--url", NODE, "--domain", "node.team-a.example", "--index", INDEX])).toBe(0);

    expect(argsOf(on)[1]).toEqual([
      "deploy",
      "--env=",
      "--var",
      `NODE_URL:${NODE}`,
      "--var",
      `INDEX_URL:${INDEX}`,
      "--domain=node.team-a.example",
    ]);
    expect(on.textBeforeDeploy()).toContain("custom domain node.team-a.example");
    expect(on.text()).toContain(`{ "node": "${NODE}", "index": "${INDEX}" }`);
  });

  it("takes the address from a custom domain that is given alone", async () => {
    const on = bench();

    expect(await setupNode(on.io, ["--domain", "node.team-a.example"])).toBe(0);

    expect(argsOf(on)[1]).toEqual(["deploy", "--env=", "--var", `NODE_URL:${NODE}`, "--var", "INDEX_URL:", "--domain=node.team-a.example"]);
    expect(on.read).toEqual([`${NODE}/records`]);
  });

  it("takes a listing for an answer too, from a node that holds records already", async () => {
    const on = bench({ answer: () => Response.json({ head: "1f".repeat(20), records: [] }) });

    expect(await setupNode(on.io, ["--url", NODE])).toBe(0);

    expect(on.text()).toContain(`The node answers at ${NODE}`);
  });

  it("names, before it deploys, the resources that the top level of the Wrangler config holds", async () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    // The environments after the top level are the demo's own nodes.
    const top = config.slice(0, config.indexOf('"env"'));
    const on = bench();

    await setupNode(on.io, ["--url", NODE]);

    const named: readonly (readonly [said: string, held: string])[] = [
      ["the Worker cairnfield-node", '"name": "cairnfield-node"'],
      ["Durable Object class ReadTokens", '"class_name": "ReadTokens"'],
      ["the Artifacts namespace cairnfield-node", '"namespace": "cairnfield-node"'],
      ["the Workflow cairnfield-node-on-push", '"name": "cairnfield-node-on-push"'],
    ];
    for (const [said, held] of named) {
      expect(on.textBeforeDeploy()).toContain(said);
      expect(top).toContain(held);
    }
  });

  it("puts no key in what it says or in what it hands Wrangler", async () => {
    // Drawn for each run. It stands in for an admin key, and no service ever sees it.
    const key = `admin-key-${randomUUID()}`;
    vi.stubEnv("ADMIN_KEY", key);
    vi.stubEnv("CAIRNFIELD_ADMIN_KEY", key);
    const on = bench();

    expect(await setupNode(on.io, [])).toBe(0);

    expect(JSON.stringify(on.ran)).not.toContain(key);
    expect(on.text()).not.toContain(key);
  });
});

describe("the setup script, given no address", () => {
  it("deploys twice, and reads the address from the record Wrangler writes of the first deploy", async () => {
    const on = bench({ targets: [NODE, "workflow: cairnfield-node-on-push", "event triggers: 1"] });

    expect(await setupNode(on.io, ["--index", INDEX])).toBe(0);

    expect(argsOf(on)).toEqual([
      ["whoami", "--json"],
      ["deploy", "--env=", "--var", "NODE_URL:", "--var", `INDEX_URL:${INDEX}`],
      ["deploy", "--env=", "--var", `NODE_URL:${NODE}`, "--var", `INDEX_URL:${INDEX}`],
    ]);
    expect(on.textBeforeDeploy()).toContain("deploys twice");
    expect(on.text()).toContain(`The node's address is ${NODE}`);
    expect(on.read).toEqual([`${NODE}/records`]);
    expect(on.text()).toContain(`{ "node": "${NODE}", "index": "${INDEX}" }`);
    // Only the first deploy is asked for a record, and the script keeps no file of it.
    expect(on.records).toHaveLength(1);
    expect(on.records.some((record) => existsSync(record))).toBe(false);
  });

  it("stops when the record of the first deploy holds no address", async () => {
    const on = bench({ targets: ["node.team-a.example (custom domain)", "workflow: cairnfield-node-on-push"] });

    expect(await setupNode(on.io, [])).toBe(1);

    expect(argsOf(on).map(([command]) => command)).toEqual(["whoami", "deploy"]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain("--url");
    expect(on.text()).not.toContain("secret put");
  });

  it("deploys no second time when the first deploy fails", async () => {
    const on = bench({ deploys: [1] });

    expect(await setupNode(on.io, [])).toBe(1);

    expect(argsOf(on).map(([command]) => command)).toEqual(["whoami", "deploy"]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain("Wrangler did not deploy the node");
  });
});

describe("the setup script stops", () => {
  it("with the login instruction when Wrangler is not logged in", async () => {
    const on = bench({ loggedIn: false });

    expect(await setupNode(on.io, ["--url", NODE])).toBe(1);

    expect(argsOf(on)).toEqual([["whoami", "--json"]]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain("npx wrangler login");
    expect(on.text()).not.toContain("--temporary");
  });

  it("when Wrangler does not deploy the node", async () => {
    const on = bench({ deploys: [1] });

    expect(await setupNode(on.io, ["--url", NODE])).toBe(1);

    expect(argsOf(on).map(([command]) => command)).toEqual(["whoami", "deploy"]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain("Wrangler did not deploy the node");
    expect(on.text()).not.toContain("secret put");
  });

  it.each([
    ["a node address that is not HTTPS", ["--url", "http://node.team-a.example"]],
    ["a node address with a slash at its end", ["--url", `${NODE}/`]],
    ["a node address with a path, where this Worker does not answer", ["--url", `${NODE}/team-a`]],
    ["a node address with an upper-case host", ["--url", "https://Node.Team-A.example"]],
    ["a custom domain that is no hostname", ["--domain", NODE]],
    ["an index address with a slash at its end", ["--url", NODE, "--index", `${INDEX}/`]],
    ["an index address that is not HTTPS", ["--url", NODE, "--index", "http://index.cairnfield.example"]],
    ["an option it does not know", ["--url", NODE, "--temporary"]],
  ])("before it runs anything, when it is given %s", async (_what, args) => {
    const on = bench();

    expect(await setupNode(on.io, args)).toBe(2);

    expect(on.ran).toEqual([]);
    expect(on.read).toEqual([]);
  });
});

describe("the setup script, when the node does not answer after the deploy", () => {
  it.each<[string, () => Response]>([
    [
      "nothing answers at the address",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["what answers is no node", () => new Response("<h1>Nothing here yet</h1>", { status: 404, headers: { "content-type": "text/html" } })],
  ])("says so, and how to read it again, when %s", async (_what, answer) => {
    const on = bench({ answer });

    expect(await setupNode(on.io, ["--url", NODE])).toBe(1);

    expect(on.read).toEqual([`${NODE}/records`]);
    expect(on.text()).not.toContain("The node answers");
    expect(on.text()).toContain(`curl ${NODE}/records`);
    // The node is deployed, so the steps that are left are the same.
    expect(on.text()).toContain('npx wrangler secret put ADMIN_KEY --env=""');
  });
});
