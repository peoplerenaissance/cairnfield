#!/usr/bin/env node
// The `cairnfield` command. It prints one line of JSON and returns an exit code.

import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { runGit } from "./git.ts";
import { run } from "./run.ts";

const outcome = await run(
  {
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
  },
  process.argv.slice(2),
);
process.stdout.write(`${JSON.stringify(outcome.output)}\n`);
process.exitCode = outcome.code;
