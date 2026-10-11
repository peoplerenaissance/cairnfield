#!/usr/bin/env node
// What `cairnfield` starts with. The command is TypeScript that Node runs as it is, and
// a Node older than 22.22 stops on its first file with an error that names no version.
// So does Node 23 before 23.6, the first of that line to run TypeScript as it is.
// So this file is plain JavaScript that an old Node reads too, and it says what is needed
// in the form every other failure of the command has: one line of JSON and exit code 3.

const [major, minor] = process.versions.node.split(".").map(Number);
const needs = major === 23 ? "23.6" : "22.22";
if (major < 22 || (major === 22 && minor < 22) || (major === 23 && minor < 6)) {
  console.error(`cairnfield needs Node ${needs} or later. This is Node ${process.versions.node}.`);
  process.stdout.write(`${JSON.stringify({ error: "node-too-old", needs, found: process.versions.node })}\n`);
  process.exit(3);
}
// Not awaited at the top of the file, which a Node older than 14.8 could not read.
import("../src/main.ts");
