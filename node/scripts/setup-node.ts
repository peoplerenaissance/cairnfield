// What `npm run setup` does: it deploys a team node (R30). It is the way a team sets its
// node up, because Cloudflare's one-click button is not known to set up Artifacts, the
// Workflow and the push trigger. `setup.ts` runs it on this machine's Wrangler.
//
//   npm run setup -- [--url <base-url>] [--domain <hostname>] [--index <index-address>]
//
// --url     The node's base URL, when the operator knows it (KTD8). With none, the script
//           deploys once to learn the node's address on workers.dev, and again to give
//           the node that address.
// --domain  A hostname of the operator's own, for a node that is not on workers.dev.
//           Given alone, it makes the node's base URL `https://<hostname>`. Wrangler
//           switches off the address on workers.dev of a Worker it deploys with one. The
//           script takes one only in a terminal, where Wrangler asks before it replaces
//           what is at the hostname.
// --index   The address of the index that the node tells about each push. A node with
//           none sends no notice (KTD40).
//
// The script deploys the top level of `wrangler.jsonc` with the Wrangler installed in
// this package, and it deletes nothing. It never passes `--temporary`, which makes a
// temporary Cloudflare account and accepts Cloudflare's terms for the operator. It never
// makes, reads, prints or stores an admin key (KTD10): it ends by saying how the
// operator sets one.
//
// A deploy can write into Wrangler's config file. That was seen with Wrangler 4.148.0, on
// another Worker of this repo that has a database and a queue: its first deploy made both
// and wrote their IDs into that Worker's config file. The source of 4.147.0, which this
// package pins, writes IDs only once it has made a resource for a binding of a kind it
// provisions, and a database and a queue are of those kinds. That was read and not seen
// to run. A node has no binding of those kinds, so the script does nothing to keep
// `wrangler.jsonc` as it is.
//
// It ends with 0 when the node is deployed and answers, with 1 when a step fails or the
// node does not answer, and with 2 when it is given an option or an address it cannot use.

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PATHS, isIndexUrl, isNodeOrigin } from "../src/contract.ts";

/** One run of Wrangler. */
export interface WranglerCall {
  /** Variables added to Wrangler's environment. */
  readonly env?: { readonly [name: string]: string };
  /** Whether the operator sees what Wrangler prints, and can answer what it asks. */
  readonly shown: boolean;
}

/**
 * Everything the script reaches outside its own process. A test puts a stand-in for
 * Wrangler and a fake node behind these, and the script runs unchanged.
 */
export interface Io {
  /** Whether Wrangler is installed in this package. */
  readonly installed: () => Promise<boolean>;
  /** Whether the script runs in a terminal, where Wrangler can ask the operator a question. */
  readonly interactive: boolean;
  /** Runs the Wrangler installed in this package, and gives its exit code. */
  readonly wrangler: (args: readonly string[], call: WranglerCall) => Promise<number>;
  readonly fetch: typeof fetch;
  /** Prints one line for the operator. */
  readonly say: (line: string) => void;
}

/** This package's folder. Wrangler runs here, where its config file is. */
const FOLDER = fileURLToPath(new URL("..", import.meta.url));

/**
 * Wrangler's own entry file, which `node_modules/.bin/wrangler` links to. The Node that
 * runs this script runs it, so it is never a Wrangler from outside this package.
 */
const WRANGLER = join(FOLDER, "node_modules", "wrangler", "bin", "wrangler.js");

/** The script's own process: this package's Wrangler, the network and standard output. */
export function processIo(): Io {
  return {
    installed: () =>
      access(WRANGLER).then(
        () => true,
        () => false,
      ),
    // Wrangler asks a question only when its input and its output are both a terminal.
    // In any other run it takes the answer to be yes.
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    wrangler: (args, call) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WRANGLER, ...args], {
          cwd: FOLDER,
          env: { ...process.env, ...call.env },
          // A hidden run still shows its standard error, where Wrangler says why it
          // failed. The account's details are on its standard output.
          stdio: call.shown ? "inherit" : ["ignore", "ignore", "inherit"],
        });
        child.on("error", reject);
        // A run that a signal ended has no code. It is a run that failed.
        child.on("exit", (code) => resolve(code ?? 1));
      }),
    fetch,
    say: (line) => {
      console.log(line);
    },
  };
}

const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const USAGE = "usage: npm run setup -- [--url <base-url>] [--domain <hostname>] [--index <index-address>]";

interface Options {
  readonly url: string | undefined;
  readonly domain: string | undefined;
  readonly index: string | undefined;
}

/** The options the script was given, or nothing when it was given anything else. */
function optionsOf(args: readonly string[]): Options | undefined {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { url: { type: "string" }, domain: { type: "string" }, index: { type: "string" } },
    });
    return { url: values.url, domain: values.domain, index: values.index };
  } catch {
    return undefined;
  }
}

/** What the top level of `wrangler.jsonc` deploys. A test holds these names to that file. */
const CREATED = [
  "the Worker cairnfield-node, with its Durable Object class ReadTokens",
  "the Artifacts namespace cairnfield-node",
  "the Workflow cairnfield-node-on-push",
  "the trigger that starts that Workflow on each push to that namespace",
];

/** The arguments of one deploy of the node, as `npm run deploy` gives them. */
function deployArgs(node: string, { domain, index }: Options): string[] {
  return [
    "deploy",
    // The top level of the config: the node a team deploys for itself, and no demo node.
    "--env=",
    "--var",
    `NODE_URL:${node}`,
    "--var",
    `INDEX_URL:${index ?? ""}`,
    // One argument, so Wrangler takes the value for a hostname whatever it holds.
    ...(domain === undefined ? [] : [`--domain=${domain}`]),
  ];
}

const NOT_DEPLOYED = "Wrangler did not deploy the node. What it printed above says why.";

/** Where a node lists its records. A read of it shows whether a node answers at an address. */
const listingUrl = (node: string): string => `${node}/${PATHS.listing}`;

/**
 * The address in Wrangler's record of a deploy. The record lists what Wrangler deployed
 * to, and of those only an address on workers.dev is written as a URL. It comes from
 * outside the script, so it is held to the same rule as an address the operator gives.
 */
function addressIn(record: string): string | undefined {
  for (const line of record.split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "deploy") continue;
    const targets: readonly unknown[] = "targets" in entry && Array.isArray(entry.targets) ? entry.targets : [];
    const address = targets.find(isNodeOrigin);
    if (address !== undefined) return address;
  }
  return undefined;
}

/**
 * Deploys the node with no address of its own, and gives the address Wrangler deployed
 * it to. With this variable set, Wrangler adds one line of JSON to the file it names for
 * each thing it did, so the script reads none of the text Wrangler prints for a person.
 * Says why when it gives no address.
 */
async function learnAddress(io: Io, options: Options): Promise<string | undefined> {
  const folder = await mkdtemp(join(tmpdir(), "cairnfield-setup-"));
  try {
    const record = join(folder, "deploy.ndjson");
    const code = await io.wrangler(deployArgs("", options), { shown: true, env: { WRANGLER_OUTPUT_FILE_PATH: record } });
    if (code !== 0) {
      io.say(NOT_DEPLOYED);
      return undefined;
    }
    const address = addressIn(await readFile(record, "utf8").catch(() => ""));
    if (address === undefined) {
      io.say("Wrangler deployed the node and recorded no address for it on workers.dev.");
      io.say("Run the setup again with --url and the address the node answers at.");
    }
    return address;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** How long the script waits for the node to answer. */
const ANSWER_DEADLINE_MS = 20_000;

/**
 * Whether a node answers at this address. A node that holds records answers a read of
 * them with its listing. A new node has no team repo yet, so it answers that there is
 * none. Anything else is no node: another server, or an address that has not started.
 */
async function answers(io: Io, node: string): Promise<boolean> {
  try {
    const response = await io.fetch(listingUrl(node), { signal: AbortSignal.timeout(ANSWER_DEADLINE_MS) });
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return false;
    if (response.status === 200) return "head" in body && typeof body.head === "string";
    return response.status === 404 && "error" in body && body.error === "not-found";
  } catch {
    return false;
  }
}

function sayAll(io: Io, lines: readonly string[]): void {
  for (const line of lines) io.say(line);
}

export async function setupNode(io: Io, args: readonly string[]): Promise<ExitCode> {
  const options = optionsOf(args);
  if (!options) {
    io.say(USAGE);
    return EXIT.usage;
  }
  const { url, domain, index } = options;
  // Every address is checked before anything is deployed. The operator's own value is not
  // printed back, because a URL can hold a password.
  const given = url ?? (domain === undefined ? undefined : `https://${domain}`);
  // A hostname given beside a URL is held to the same rule: it goes to Wrangler, and into what the script says.
  const refused = url !== undefined && !isNodeOrigin(url) ? "--url" : domain !== undefined && !isNodeOrigin(`https://${domain}`) ? "--domain" : undefined;
  if (refused !== undefined) {
    sayAll(io, [
      `The value given with ${refused} gives no address a node can have.`,
      "A node's address is the origin it answers at: https, a lower-case hostname, no path and no slash at its end.",
      "For example: --url https://node.team-a.example, or --domain node.team-a.example",
    ]);
    return EXIT.usage;
  }
  // With a hostname the node answers there and nowhere else. A URL beside it that names
  // another address would be the address the node is told, at which it does not answer.
  if (url !== undefined && domain !== undefined && url !== `https://${domain}`) {
    sayAll(io, [
      "The values given with --url and --domain name two addresses.",
      "With --domain the node's address is https:// and that hostname. Give --domain alone, or a --url that names the same address.",
    ]);
    return EXIT.usage;
  }
  if (index !== undefined && !isIndexUrl(index)) {
    sayAll(io, [
      "The value given with --index is no address a node can send a notice to.",
      "An index address is an HTTPS URL with no slash at its end.",
      "For example: --index https://index.cairnfield.example",
    ]);
    return EXIT.usage;
  }

  // With a custom domain, Wrangler asks before it replaces a DNS record or another
  // Worker's custom domain at the hostname. Outside a terminal it asks nothing and
  // replaces both.
  if (domain !== undefined && !io.interactive) {
    sayAll(io, [
      "A hostname is given with --domain only from a terminal.",
      "Outside one, Wrangler replaces what is at that hostname without asking: a DNS record, or another Worker's custom domain.",
    ]);
    return EXIT.usage;
  }

  // Without this check, the login check below would fail on a missing Wrangler and be
  // read as a missing login.
  if (!(await io.installed())) {
    sayAll(io, ["Wrangler is not installed in this folder. Install it from this folder, then run the setup again:", "  npm install"]);
    return EXIT.failed;
  }
  // Wrangler answers with the account's details and ends with 0 only when it is logged
  // in. It ends with another code for any other failure too, so the script does not say
  // which one this was.
  if ((await io.wrangler(["whoami", "--json"], { shown: false })) !== 0) {
    sayAll(io, ["The login check failed. To log Wrangler in, run this from this folder, then run the setup again:", "  npx wrangler login"]);
    return EXIT.failed;
  }

  sayAll(io, [
    "This deploys a team node to the Cloudflare account that Wrangler is logged in to.",
    "It creates each of these that is missing, and updates each that is there:",
    ...[...CREATED, ...(domain === undefined ? [] : [`the custom domain ${domain}`])].map((created) => `  ${created}`),
    // Wrangler gives a Worker no address on workers.dev when it deploys it with a custom
    // domain and the config does not ask for one.
    ...(domain === undefined ? [] : ["It switches off the node's address on workers.dev, because the node gets a custom domain."]),
    "It deletes nothing.",
  ]);
  let node = given;
  if (node === undefined) {
    io.say("No address was given, so it deploys twice: once to learn the node's address on workers.dev, and once to give the node that address.");
    node = await learnAddress(io, options);
    if (node === undefined) return EXIT.failed;
    io.say(`The node's address is ${node}. Deploying again to give the node that address.`);
  }
  if ((await io.wrangler(deployArgs(node, options), { shown: true })) !== 0) {
    if (given !== undefined) io.say(NOT_DEPLOYED);
    else {
      // The first deploy made the node. The address is one the script checked, and so is
      // the index address, so both can be said back.
      sayAll(io, [
        `The node is deployed at ${node}, but the deploy that gives it that address failed. What Wrangler printed above says why.`,
        "Run the setup again with that address, so that the node has it:",
        `  npm run setup -- --url ${node}${index === undefined ? "" : ` --index ${index}`}`,
      ]);
    }
    return EXIT.failed;
  }

  const answered = await answers(io, node);
  io.say("");
  if (answered) io.say(`The node answers at ${node}`);
  else {
    sayAll(io, [
      `The node is deployed, but nothing answered as a node at ${listingUrl(node)}`,
      "A new address can take a few minutes to start. Read it again with:",
      `  curl ${listingUrl(node)}`,
      'A new node answers {"error":"not-found"}, because it has no team repo yet.',
    ]);
  }
  sayAll(io, [
    "",
    "Two steps are left, and both are yours.",
    "",
    "1. Set the node's admin key. The node refuses every admin call until it has one.",
    "   Make a key, for example with:",
    "     openssl rand -hex 32",
    "   Then give it to the node from this folder. Wrangler asks for the value:",
    '     npx wrangler secret put ADMIN_KEY --env=""',
    "   Write the key in no file. The cairnfield command reads it from CAIRNFIELD_ADMIN_KEY.",
    "",
    "2. Name the node in the cairnfield.json of the folder you work in:",
    `     { "node": "${node}"${index === undefined ? "" : `, "index": "${index}"`} }`,
  ]);
  return answered ? EXIT.ok : EXIT.failed;
}
