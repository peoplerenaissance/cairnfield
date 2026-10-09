#!/usr/bin/env node
// The `cairnfield` command. It prints one line of JSON and returns an exit code.

import { processIo } from "./io.ts";
import { run } from "./run.ts";

const outcome = await run(processIo(), process.argv.slice(2));
process.stdout.write(`${JSON.stringify(outcome.output)}\n`);
process.exitCode = outcome.code;
