// Writes the generated files under `protocol/schemas/` (KTD35).
// Run it with `npm run generate -w @cairnfield/protocol` after a change to a record or a contract shape.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generatedFiles } from "../src/generate.ts";

const directory = fileURLToPath(new URL("../schemas/", import.meta.url));
const files = generatedFiles();

mkdirSync(directory, { recursive: true });
// A JSON file that is no longer generated is removed, so the folder holds nothing stale.
for (const name of readdirSync(directory)) {
  if (name.endsWith(".json") && !Object.hasOwn(files, name)) rmSync(`${directory}${name}`);
}
for (const [name, content] of Object.entries(files)) {
  writeFileSync(`${directory}${name}`, content);
}
console.log(`wrote ${Object.keys(files).length} files to ${directory}`);
