// Everything the command reaches outside its own process. A test puts a fake node, a
// fake index and local repos behind these, and the commands run unchanged.

import { randomInt } from "node:crypto";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { runGit } from "./git.ts";
import type { GitRunner } from "./git.ts";

export interface Io {
  /** The environment. Keys are read from here and from nowhere else. */
  readonly env: { readonly [name: string]: string | undefined };
  /** The folder a relative path on the command line is read from. */
  readonly cwd: string;
  readonly fetch: typeof fetch;
  readonly git: GitRunner;
  /** The time in milliseconds. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** A whole number from 0 to one below `bound`. */
  readonly random: (bound: number) => number;
  /**
   * Writes to standard error, and is done once standard error has room for more. Standard
   * output holds the command's JSON and nothing else.
   */
  readonly warn: (text: string) => Promise<void>;
}

/** The command's own process: its environment, its working folder, the network and Git. */
export function processIo(): Io {
  return {
    env: process.env,
    cwd: process.cwd(),
    fetch,
    git: runGit,
    now: Date.now,
    sleep: async (ms) => {
      await sleep(ms);
    },
    random: (bound) => randomInt(bound),
    warn: async (text) => {
      // A write to a terminal or a file is over when it returns. A write to a pipe is not:
      // Node holds what the pipe has not taken yet. So the command waits here for the pipe.
      if (!process.stderr.write(text)) await once(process.stderr, "drain");
    },
  };
}
