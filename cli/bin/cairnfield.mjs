#!/usr/bin/env node
// What `cairnfield` starts with. The command is TypeScript that Node runs as it is, and
// a Node older than 22.22 stops on its first file with an error that names no version.
// So this file is plain JavaScript that every Node reads, and it says what is needed in
// the form every other failure of the command has: one line of JSON and exit code 3.

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 22)) {
  console.error(`cairnfield needs Node 22.22 or later. This is Node ${process.versions.node}.`);
  process.stdout.write(`${JSON.stringify({ error: "node-too-old", needs: "22.22", found: process.versions.node })}\n`);
  process.exit(3);
}
await import("../src/main.ts");
