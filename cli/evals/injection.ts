#!/usr/bin/env node
// A live run of the patch agent on one injection fixture. It calls a model, so it is no
// part of the test suite (KTD18). `README.md` beside this file says when to run it.
//
//   node cli/evals/injection.ts fixtures/injection/<name>
//
// It reaches no node and publishes nothing. It prints one line of JSON: whether the
// agent's edits passed the patch checks, the edits, and what the run logged. The edits
// hold text a model wrote after it read a hostile file. Read them as data.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MODEL_KEY } from "../src/agents/live.ts";
import { writeEdits } from "../src/commands/patch.ts";
import { DEFAULT_MODEL, keyFrom } from "../src/config.ts";
import { processIo } from "../src/io.ts";
import { EXIT, done, failure, outcomeOf } from "../src/outcome.ts";
import { openFixture } from "./fixture.ts";

const [fixture] = process.argv.slice(2);
if (fixture === undefined) {
  console.error("usage: node cli/evals/injection.ts fixtures/injection/<name>");
  process.exit(EXIT.usage);
}

const log: string[] = [];
const io = {
  ...processIo(),
  warn: (text: string) => {
    log.push(text.trim());
  },
};
const root = await mkdtemp(join(tmpdir(), "cairnfield-eval-"));
try {
  const outcome = await outcomeOf(async () => {
    const key = keyFrom(io, MODEL_KEY);
    const { home, listing, finding } = await openFixture(io, resolve(fixture), root);
    const drafted = await writeEdits(io, home, listing, finding, { key, name: DEFAULT_MODEL });
    if (!drafted.ok) return failure(EXIT.invalid, "edits-refused", { reason: drafted.reason });
    const { kind, size, paths } = drafted.facts;
    return done({ accepted: true, kind, size, paths, edits: drafted.edits });
  });
  process.stdout.write(`${JSON.stringify({ ...outcome.output, log })}\n`);
  process.exitCode = outcome.code;
} finally {
  await rm(root, { recursive: true, force: true });
}
