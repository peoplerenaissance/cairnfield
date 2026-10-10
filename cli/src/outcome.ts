// What a command gives back: one JSON value for standard output and an exit code.
// The codes are stable, so a person, a script or another agent can act on them. Every
// string the command writes itself is a code, a path or a hash, and none is a sentence.
// One output holds text from outside: `pin` lists the paths of the pinned tree that its
// checkout leaves out, and a component's author chose those.

export const EXIT = {
  ok: 0,
  /** Something failed that has no code of its own. */
  failed: 1,
  /** A record was refused. Nothing was published. */
  invalid: 2,
  /** The arguments, the config file or a key in the environment is missing or wrong. */
  usage: 3,
  /** The node could not be reached, refused, or gave an answer the contract does not allow. */
  node: 4,
  /** The node's copy of the component does not hold the commit. */
  notHeld: 5,
  /** The command needs an index and the config names none (KTD40). */
  noIndex: 6,
  /** The index could not be reached, refused, or gave an answer the contract does not allow. */
  index: 7,
  /** A Git step failed. */
  git: 8,
  /** The bundled agent gave no answer to use: it refused, ran past a limit, or its service failed. */
  agent: 9,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface Outcome {
  readonly code: ExitCode;
  readonly output: { readonly [field: string]: unknown };
}

export function done(output: Outcome["output"], code: ExitCode = EXIT.ok): Outcome {
  return { code, output };
}

/** An outcome that names what went wrong by a code. */
export function failure(code: ExitCode, error: string, detail: Outcome["output"] = {}): Outcome {
  return { code, output: { error, ...detail } };
}

/** Thrown to end a command at once with the outcome it carries. */
export class Stop extends Error {
  readonly outcome: Outcome;

  constructor(outcome: Outcome) {
    super(String(outcome.output["error"]));
    this.outcome = outcome;
  }
}

/** Runs work that may end the command, and gives its outcome either way. */
export async function outcomeOf(work: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Stop) return error.outcome;
    throw error;
  }
}

/** Ends the command with a failure. */
export function stop(code: ExitCode, error: string, detail: Outcome["output"] = {}): never {
  throw new Stop(failure(code, error, detail));
}
