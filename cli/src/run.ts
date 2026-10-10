// The command line: which command, with which arguments. Every command is
// non-interactive, gives one JSON value and returns a stable exit code (see `outcome.ts`).
//
//   cairnfield pin <git-url> --branch <branch> --commit <full-hash>
//   cairnfield validate
//   cairnfield publish
//   cairnfield claim <component> --kind review --check <kind> [--number <n>]
//   cairnfield claim <component> --kind patch --findings <id>[,<id>] --intent <intent> [--number <n>]
//   cairnfield view <component>
//   cairnfield patch <component> --finding <id> [--replay]
//   cairnfield assemble <component>
//   cairnfield decide <git-url> --commit <full-hash> --verdict <verdict>
//   cairnfield approvals
//   cairnfield verify <git-url> <folder> --approvals <file>
//
// Each takes `--config <file>`. Without it the command reads `cairnfield.json` in the
// working folder. `verify` reads no config file, so it runs on a machine that has none.

import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { isBranchName, isCommit, isHttpsUrl } from "@cairnfield/protocol";
import { approvals } from "./commands/approvals.ts";
import { assemble } from "./commands/assemble.ts";
import { claim } from "./commands/claim.ts";
import { decide } from "./commands/decide.ts";
import { patch } from "./commands/patch.ts";
import { pin } from "./commands/pin.ts";
import { publish } from "./commands/publish.ts";
import { validate } from "./commands/validate.ts";
import { verify } from "./commands/verify.ts";
import { view } from "./commands/view.ts";
import { loadHome } from "./config.ts";
import type { Home } from "./config.ts";
import type { Io } from "./io.ts";
import { EXIT, failure, outcomeOf, stop } from "./outcome.ts";
import type { Outcome } from "./outcome.ts";

type Options = { readonly [name: string]: string | undefined };
type Flags = { readonly [name: string]: boolean | undefined };

interface Declared {
  /** The options the command takes beside `--config`. Each has a value. */
  readonly options: readonly string[];
  /** The options the command takes that have no value. */
  readonly flags?: readonly string[];
  /** How many arguments the command takes that are no option. */
  readonly arguments: number;
}

interface Command extends Declared {
  run(io: Io, home: Home, args: readonly string[], options: Options, flags: Flags): Promise<Outcome>;
}

/** A command that reads no config file and takes no `--config`, so it runs on a machine that has none. */
interface Standalone extends Declared {
  readonly standalone: true;
  run(io: Io, args: readonly string[], options: Options): Promise<Outcome>;
}

const usage = (): never => stop(EXIT.usage, "usage");

const COMMANDS: { readonly [name: string]: Command } = {
  pin: {
    options: ["branch", "commit"],
    arguments: 1,
    run: (io, home, [url], { branch, commit }) =>
      isHttpsUrl(url) && isBranchName(branch) && isCommit(commit) ? pin(io, home, { url, branch, commit }) : usage(),
  },
  validate: { options: [], arguments: 0, run: (_io, home) => validate(home) },
  publish: { options: [], arguments: 0, run: (io, home) => publish(io, home) },
  claim: {
    options: ["kind", "check", "findings", "intent", "number"],
    arguments: 1,
    run: (io, home, [component], { kind, check, findings, intent, number }) =>
      isCommit(component) ? claim(io, home, { component, kind, check, findings, intent, number }) : usage(),
  },
  view: {
    options: [],
    arguments: 1,
    run: (io, home, [component]) => (isCommit(component) ? view(io, home, component) : usage()),
  },
  patch: {
    options: ["finding"],
    flags: ["replay"],
    arguments: 1,
    run: (io, home, [component], { finding }, { replay }) =>
      isCommit(component) ? patch(io, home, { component, finding, replay: replay === true }) : usage(),
  },
  assemble: {
    options: [],
    arguments: 1,
    run: (io, home, [component]) => (isCommit(component) ? assemble(io, home, component) : usage()),
  },
  decide: {
    options: ["commit", "verdict"],
    arguments: 1,
    run: (io, home, [url], { commit, verdict }) => (isHttpsUrl(url) && isCommit(commit) ? decide(io, home, { url, commit, verdict }) : usage()),
  },
  approvals: { options: [], arguments: 0, run: (_io, home) => approvals(home) },
};

const STANDALONE: { readonly [name: string]: Standalone } = {
  verify: {
    standalone: true,
    options: ["approvals"],
    arguments: 2,
    run: (io, [url, folder], { approvals: file }) => (isHttpsUrl(url) && folder !== undefined ? verify(io, { url, folder, approvals: file }) : usage()),
  },
};

async function dispatch(io: Io, argv: readonly string[]): Promise<Outcome> {
  const [name = "", ...rest] = argv;
  const named = (commands: { readonly [name: string]: Command | Standalone }) => (Object.hasOwn(commands, name) ? commands[name] : undefined);
  const command = named(COMMANDS) ?? named(STANDALONE);
  if (!command) return usage();
  const options: NonNullable<ParseArgsConfig["options"]> = "standalone" in command ? {} : { config: { type: "string" } };
  for (const option of command.options) options[option] = { type: "string" };
  for (const flag of command.flags ?? []) options[flag] = { type: "boolean" };
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  } catch {
    return usage();
  }
  if (parsed.positionals.length !== command.arguments) return usage();
  // Each option was declared above with a value or without one, and is read as it was declared.
  const values = parsed.values as Options;
  if ("standalone" in command) return command.run(io, parsed.positionals, values);
  return command.run(io, await loadHome(io, values["config"]), parsed.positionals, values, parsed.values as Flags);
}

/** Runs one command. It never throws: whatever happens comes back as an outcome. */
export async function run(io: Io, argv: readonly string[]): Promise<Outcome> {
  try {
    return await outcomeOf(() => dispatch(io, argv));
  } catch (error) {
    io.warn(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return failure(EXIT.failed, "failed");
  }
}
