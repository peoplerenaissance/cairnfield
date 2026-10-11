// The skill file is all that a team's own review agent knows of Cairnfield (R21). It
// copies the protocol's closed lists and limits, and it works one example through to what
// `validate` prints. These tests read the file and fail when a copy no longer matches the code.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECK_KINDS,
  COUNTER_FINDING_REASONS,
  CRITERIA,
  MAX_PATH_LENGTH,
  MAX_RECORD_BYTES,
  MODELS,
  OBSERVATIONS,
  PATCH_RECHECK_VERDICTS,
  RECORD_SHAPES,
  REJECTION_REASONS,
  canonicalJson,
  recordId,
  recordPath,
} from "@cairnfield/protocol";
import type { Finding } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import { OUTBOX, bench, pinTree, putFile, putRecord } from "./support.ts";
import type { Bench } from "./support.ts";

const SKILL = readFileSync(new URL("../../skills/cairnfield/SKILL.md", import.meta.url), "utf8");

/** The one item of a list in which the file should hold exactly one. */
function only<T>(what: string, items: readonly T[]): T {
  const [item, ...more] = items;
  if (item === undefined || more.length > 0) throw new Error(`the skill file holds ${items.length} ${what}, and the test reads one`);
  return item;
}

/** What a piece of the file holds in backticks. */
const coded = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map(([, value = ""]) => value);

/** The fenced blocks of a piece of the file, each without its fences. With a language, only the blocks marked as that. */
function blocksOf(text: string, language?: string): string[] {
  return [...text.matchAll(/^```(\w*)\n([\s\S]*?)\n```$/gm)]
    .filter(([, marked]) => language === undefined || marked === language)
    .map(([, , block = ""]) => block);
}

/** The text under one of the file's second-level headings. */
function under(heading: string): string {
  return only(`headings "${heading}"`, SKILL.split(/^## /m).filter((section) => section.startsWith(`${heading}\n`)));
}

/** A table: the headings of its columns, and each row as its cells by heading. */
interface Table {
  readonly headings: readonly string[];
  readonly rows: readonly { readonly [heading: string]: string }[];
}

const cellsOf = (line: string): string[] => line.split("|").slice(1, -1).map((cell) => cell.trim());

// A table is a run of lines that start with a bar: the headings, a rule, then the rows.
const TABLES: Table[] = [...SKILL.matchAll(/(?:^\|.*\n)+/gm)].map(([lines]) => {
  const [headings = [], , ...rows] = lines.trimEnd().split("\n").map(cellsOf);
  return { headings, rows: rows.map((cells) => Object.fromEntries(headings.map((heading, at) => [heading, cells[at] ?? ""]))) };
});

/**
 * The rows of the one table that has a column under each of the given headings. A table
 * is found by its headings and never by where it stands, so the prose around it can change.
 */
function table(...headings: string[]): Table["rows"] {
  const found = TABLES.filter((candidate) => headings.every((heading) => candidate.headings.includes(heading)));
  return only(`tables with a column headed ${headings.join(" and ")}`, found).rows;
}

/** The values in backticks down one column of a table. A second heading tells the table from another with that column. */
const listed = (column: string, ...beside: string[]): string[] => table(column, ...beside).flatMap((row) => coded(row[column] ?? ""));

/**
 * What the table of the other record types names in backticks for one type, besides the
 * record's own fields: the values of its closed list.
 */
function listedFor(type: "counter-finding" | "patch-re-check"): string[] {
  const row = only(`rows for \`${type}\``, table("`type`", "Its other fields").filter((candidate) => candidate["`type`"] === `\`${type}\``));
  return coded(row["Its other fields"] ?? "").filter((value) => !(value in RECORD_SHAPES[type].fields));
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

/** The record of the worked example: its one block of JSON. */
function example(): Finding {
  return JSON.parse(only("blocks of JSON in its worked example", blocksOf(under("Worked example"), "json"))) as Finding;
}

/** The name the file has an agent give a record before it knows the record's ID. */
const PLACEHOLDER = "0".repeat(64);

/** The outputs of `validate` that the worked example prints as blocks, in the order it prints them. */
const printedIn = (worked: string): string[] => blocksOf(worked).filter((block) => block.startsWith('{"records"'));

/** The finding moved to line 6, as the file moves it. That line does not hold the hostname. */
const onLine6 = (record: Finding): Finding => ({ ...record, location: { ...record.location, start: 6, end: 6 } });

describe("the skill file", () => {
  it("lists the protocol's criteria, in the protocol's order", () => {
    // The file gives the order a meaning: each of the first three implies the ones before it.
    expect(listed("Value", "The promise")).toEqual(CRITERIA);
  });

  it("lists every observation, kind of check and model of the protocol, and no other", () => {
    expect(sorted(listed("Value", "The cited lines"))).toEqual(sorted(OBSERVATIONS));
    expect(sorted(listed("`check`"))).toEqual(sorted(CHECK_KINDS));
    // One row holds the two models that have a name, and `other` and `none` have a row each.
    expect(sorted(listed("`model`"))).toEqual(sorted(MODELS));
  });

  it("lists every reason a counter-finding may give and every verdict of a patch re-check, and no other", () => {
    expect(sorted(listedFor("counter-finding"))).toEqual(sorted(COUNTER_FINDING_REASONS));
    expect(sorted(listedFor("patch-re-check"))).toEqual(sorted(PATCH_RECHECK_VERDICTS));
  });

  it("explains no reason for a rejection that the protocol does not have", () => {
    const reasons = listed("`reason`");
    // The reason its own example is refused for is among them, so the column was read.
    expect(reasons).toContain("host-not-in-lines");
    expect(reasons.filter((reason) => !(REJECTION_REASONS as readonly string[]).includes(reason))).toEqual([]);
  });

  it("states the protocol's limits for the bytes of a record file and the length of a path", () => {
    const counts = (stated: RegExp): number[] => [...SKILL.matchAll(stated)].map(([, digits = ""]) => Number(digits.replaceAll(",", "")));
    // The size comes up in more than one place, and each has to give the same number.
    expect(new Set(counts(/(\d[\d,]*) bytes/g))).toEqual(new Set([MAX_RECORD_BYTES]));
    // The line that says what `path` is also says how long one may be.
    expect(counts(/^- `path` .*?(\d[\d,]*) characters/gm)).toEqual([MAX_PATH_LENGTH]);
  });

  it("has the agent start one program, `validate`, after a check of its own shell that starts none", () => {
    // R21: an outside agent runs `validate` and no other command. The check for a key is the shell's own test.
    const [keys, ...started] = blocksOf(SKILL, "sh");
    expect(keys).toMatch(/^\[ -z "\$\{[A-Z_]+\+x\}\$\{[A-Z_]+\+x\}" \] && echo unset$/);
    // `--offline` keeps `npx` from asking the registry about the name when the command is not linked.
    expect(started).toEqual(["npx --no --offline cairnfield validate"]);
  });

  it("gives its worked example the canonical JSON and the ID the protocol gives that record", async () => {
    const worked = under("Worked example");
    const record = example();
    const id = await recordId(record);

    // Canonical JSON puts the keys in order, and `check` is the first key of a finding.
    expect(only("blocks that are a record on one line", blocksOf(SKILL).filter((block) => block.startsWith('{"check"')))).toBe(canonicalJson(record));
    // The example names two records and no other: the finding, and the same finding on line 6.
    // The third name is the one a record waits under until `validate` has said its ID.
    expect(new Set(worked.match(/\b[0-9a-f]{64}\b/g))).toEqual(new Set([PLACEHOLDER, id, await recordId(onLine6(record))]));
    expect(under("The file and its name")).toContain(`\`${PLACEHOLDER}.json\``);
    expect(blocksOf(worked)).toContain(`${OUTBOX}/${recordPath(record, id)}`);
  });
});

describe("validate, on the worked example of the skill file", () => {
  let on: Bench;
  beforeEach(() => {
    on = bench();
  });
  afterEach(() => {
    on.dispose();
  });

  it("says where the finding belongs while it waits under the placeholder name, with the output the file prints", async () => {
    const worked = under("Worked example");
    const record = example();
    const { commit, outcome } = await pinTree(on, [{ path: record.location.path, content: "#\n" }]);
    expect(outcome.code).toBe(EXIT.ok);

    const here = { ...record, component: commit };
    const waiting = recordPath(here, PLACEHOLDER);
    putFile(on, waiting, `${JSON.stringify(here, null, 2)}\n`);
    const refused = await on.run("validate");
    // The record is not yet held to the checkout, so the lines it cites need not be there.
    expect(refused).toEqual({ code: EXIT.invalid, output: { records: 0, rejected: [{ record: waiting, reason: "hash-mismatch", expected: recordPath(here, await recordId(here)) }] } });
    // The first output the example prints is this one, for the example's commit and its ID.
    const [printed = ""] = printedIn(worked);
    expect(printed.replaceAll(record.component, commit).replaceAll(await recordId(record), await recordId(here))).toBe(JSON.stringify(refused.output));
  });

  it("accepts the finding, and refuses the same finding on line 6, with the two outputs the file prints", async () => {
    const worked = under("Worked example");
    const record = example();

    // The file names the commit its author pinned and quotes three lines of one file there.
    // A commit's hash follows from every byte of its tree, and the file does not hold the
    // rest of that tree, so no test can make that commit again. This one pins a tree of its
    // own, with the quoted lines at the line numbers the file gives them, and writes the
    // example's record for that commit.
    const numbered = only("blocks of numbered lines in its worked example", blocksOf(worked).filter((block) => /^(?:\d+ {2}.*\n?)+$/.test(block)));
    const quoted = new Map(numbered.split("\n").map((line): [number, string] => [Number.parseInt(line, 10), line.replace(/^\d+ {2}/, "")]));
    // A line the file does not quote is an empty comment.
    const script = Array.from({ length: Math.max(...quoted.keys()) }, (_, at) => quoted.get(at + 1) ?? "#");
    const { commit, outcome } = await pinTree(on, [{ path: record.location.path, content: `${script.join("\n")}\n` }]);
    expect(outcome.code).toBe(EXIT.ok);

    const here = { ...record, component: commit };
    await putRecord(on, here);
    const accepted = await on.run("validate");
    expect(accepted).toEqual({ code: EXIT.ok, output: { records: 1, rejected: [] } });
    // The text of the worked example holds one output of `validate`, and it is this one.
    const inText = coded(worked).filter((value) => value.startsWith('{"records"'));
    expect(only("outputs of `validate` in the text of its worked example", inText)).toBe(JSON.stringify(accepted.output));

    const moved = await putRecord(on, onLine6(here));
    const refused = await on.run("validate");
    expect(refused).toEqual({ code: EXIT.invalid, output: { records: 1, rejected: [{ record: moved, reason: "host-not-in-lines", field: "host" }] } });
    // The line the file prints names the example's commit and the ID that follows from it.
    // With this test's commit and its ID in their place, it is the line the command prints.
    // It is the second of the two outputs the example prints as a block.
    const [, printed = "", ...more] = printedIn(worked);
    expect(more).toEqual([]);
    const forThisCommit = printed.replaceAll(record.component, commit).replaceAll(await recordId(onLine6(record)), await recordId(onLine6(here)));
    expect(forThisCommit).toBe(JSON.stringify(refused.output));
  });
});
