// The command line: which command, with which arguments. Every command is
// non-interactive, gives one JSON value and returns a stable exit code (see `outcome.ts`).
//
//   cairnfield pin <git-url> --branch <branch> --commit <full-hash>
//   cairnfield validate
//   cairnfield publish
//   cairnfield claim <component> --kind review --check <kind> [--number <n>]
//   cairnfield claim <component> --kind patch --findings <id>[,<id>] --intent <intent> [--number <n>]
//   cairnfield view <component>
//
// Each takes `--config <file>`. Without it the command reads `cairnfield.json` in the
// working folder.

import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { isBranchName, isCommit, isHttpsUrl } from "@cairnfield/protocol";
import { claim } from "./commands/claim.ts";
import { pin } from "./commands/pin.ts";
import { publish } from "./commands/publish.ts";
import { validate } from "./commands/validate.ts";
import { view } from "./commands/view.ts";
import { loadHome } from "./config.ts";
import type { Home } from "./config.ts";
import type { Io } from "./io.ts";
import { EXIT, failure, outcomeOf, stop } from "./outcome.ts";
import type { Outcome } from "./outcome.ts";

type Options = { readonly [name: string]: string | undefined };

interface Command {
  /** The options the command takes beside `--config`. Each has a value. */
  readonly options: readonly string[];
  /** How many arguments the command takes that are no option. */
  readonly arguments: number;
  run(io: Io, home: Home, args: readonly string[], options: Options): Promise<Outcome>;
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
};

async function dispatch(io: Io, argv: readonly string[]): Promise<Outcome> {
  const [name = "", ...rest] = argv;
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) return usage();
  const options: NonNullable<ParseArgsConfig["options"]> = { config: { type: "string" } };
  for (const option of command.options) options[option] = { type: "string" };
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  } catch {
    return usage();
  }
  if (parsed.positionals.length !== command.arguments) return usage();
  const values = parsed.values as Options;
  return command.run(io, await loadHome(io, values["config"]), parsed.positionals, values);
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
