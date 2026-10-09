// Everything the command reaches outside its own process. A test puts a fake node, a
// fake index and local repos behind these, and the commands run unchanged.

import { randomInt } from "node:crypto";
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
  /** Writes to standard error. Standard output holds the command's JSON and nothing else. */
  readonly warn: (text: string) => void;
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
    warn: (text) => {
      process.stderr.write(text);
    },
  };
}
