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
  /** Whether Wrangler is installed in the package. */
  readonly installed?: boolean;
  /** Whether the script runs in a terminal. */
  readonly interactive?: boolean;
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
    installed: async () => stand.installed !== false,
    interactive: stand.interactive !== false,
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
    expect(on.textBeforeDeploy()).not.toContain("switches off");
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
    // Wrangler gives a Worker with a custom domain no address on workers.dev.
    expect(on.textBeforeDeploy()).toContain("It switches off the node's address on workers.dev");
    expect(on.text()).toContain(`{ "node": "${NODE}", "index": "${INDEX}" }`);
  });

  it("takes the address from a custom domain that is given alone", async () => {
    const on = bench();

    expect(await setupNode(on.io, ["--domain", "node.team-a.example"])).toBe(0);

    expect(argsOf(on)[1]).toEqual(["deploy", "--env=", "--var", `NODE_URL:${NODE}`, "--var", "INDEX_URL:", "--domain=node.team-a.example"]);
    expect(on.read).toEqual([`${NODE}/records`]);
  });

  it("deploys outside a terminal too, when it is given no hostname", async () => {
    const on = bench({ interactive: false });

    expect(await setupNode(on.io, ["--url", NODE])).toBe(0);

    expect(argsOf(on).map(([command]) => command)).toEqual(["whoami", "deploy"]);
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

    const trigger = "the trigger that starts that Workflow on each push to that namespace";
    const named: readonly (readonly [said: string, held: string])[] = [
      ["the Worker cairnfield-node", '"name": "cairnfield-node"'],
      ["Durable Object class ReadTokens", '"class_name": "ReadTokens"'],
      ["the Artifacts namespace cairnfield-node", '"namespace": "cairnfield-node"'],
      ["the Workflow cairnfield-node-on-push", '"name": "cairnfield-node-on-push"'],
      [trigger, '"type": "cf.artifacts.repo.pushed"'],
      [trigger, '"filter": { "namespace": "cairnfield-node" }'],
      [trigger, '"workflow_name": "cairnfield-node-on-push"'],
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
    // The operator sees both deploys, and not the answer to the login check.
    expect(on.ran.map(({ call }) => call.shown)).toEqual([false, true, true]);
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

  it.each([
    ["no index address", [], `npm run setup -- --url ${NODE}`],
    ["an index address", ["--index", INDEX], `npm run setup -- --url ${NODE} --index ${INDEX}`],
  ])("says where the node is, and how to give it its address, when the second deploy fails with %s", async (_what, args, again) => {
    const on = bench({ deploys: [0, 1] });

    expect(await setupNode(on.io, args)).toBe(1);

    expect(argsOf(on).map(([command]) => command)).toEqual(["whoami", "deploy", "deploy"]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain(`The node is deployed at ${NODE}`);
    expect(on.text().split("\n")).toContain(`  ${again}`);
    // The first deploy made the node, so the sentence for a node that is not there would be untrue.
    expect(on.text()).not.toContain("Wrangler did not deploy the node");
    expect(on.text()).not.toContain("secret put");
  });
});

describe("the setup script stops", () => {
  it("before any call when a hostname given beside a URL is no hostname, and does not say the value back", async () => {
    const on = bench();

    expect(await setupNode(on.io, ["--url", NODE, "--domain", "node.team-a.example/path --temporary"])).toBe(2);

    expect(argsOf(on)).toEqual([]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain("The value given with --domain gives no address a node can have.");
    expect(on.text()).not.toContain("--temporary");
  });

  it("before any run of Wrangler when Wrangler is not installed, and says how to install it", async () => {
    const on = bench({ installed: false });

    expect(await setupNode(on.io, ["--url", NODE])).toBe(1);

    expect(on.ran).toEqual([]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain("npm install");
    expect(on.text()).not.toContain("wrangler login");
  });

  it("before any run of Wrangler when a hostname is given outside a terminal, where Wrangler asks nothing", async () => {
    const on = bench({ interactive: false });

    expect(await setupNode(on.io, ["--domain", "node.team-a.example"])).toBe(2);

    expect(on.ran).toEqual([]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain("only from a terminal");
  });

  it("with the login instruction when Wrangler's login check fails", async () => {
    const on = bench({ loggedIn: false });

    expect(await setupNode(on.io, ["--url", NODE])).toBe(1);

    expect(argsOf(on)).toEqual([["whoami", "--json"]]);
    expect(on.read).toEqual([]);
    expect(on.text()).toContain("The login check failed");
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

describe("the setup script, given an address that carries credentials", () => {
  it.each<[string, (password: string) => string[]]>([
    ["--url", (password) => ["--url", `https://operator:${password}@node.team-a.example`]],
    ["--index", (password) => ["--url", NODE, "--index", `https://operator:${password}@index.cairnfield.example`]],
  ])("stops before it runs anything, and says no part of the password, when it comes with %s", async (_option, args) => {
    // Drawn for each run. It stands in for a password, and no service ever sees it.
    const password = randomUUID().replaceAll("-", "");
    const on = bench();

    expect(await setupNode(on.io, args(password))).toBe(2);

    expect(on.ran).toEqual([]);
    expect(on.read).toEqual([]);
    // A value that was cut short would still hold eight characters of the password in a row.
    const parts = Array.from({ length: password.length - 7 }, (_, at) => password.slice(at, at + 8));
    expect(parts.filter((part) => on.text().includes(part))).toEqual([]);
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
    ["the answer is a listing with no head", () => Response.json({ records: [] })],
    ["the answer is a listing whose head is no hash", () => Response.json({ head: 5 })],
    ["the answer is another refusal than a new node's", () => Response.json({ error: "bad-request" }, { status: 404 })],
    ["the answer is a list", () => Response.json([])],
    ["the answer is null", () => Response.json(null)],
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
