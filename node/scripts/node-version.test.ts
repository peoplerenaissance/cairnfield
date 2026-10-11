// What `node-version.cjs` does on each Node. The tests run on one Node, so each case
// starts a child Node that is told it is another version before it reads the file.

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FILE = fileURLToPath(new URL("node-version.cjs", import.meta.url));

/** Runs the file in a child Node that takes itself for this version. */
function runAs(version: string): SpawnSyncReturns<string> {
  const told = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`;
  return spawnSync(process.execPath, ["-e", `${told} require(${JSON.stringify(FILE)});`], { encoding: "utf8" });
}

describe("the Node version check of the setup", () => {
  it.each(["20.19.4", "22.21.9"])("stops on Node %s, and names the version it found", (version) => {
    const { status, stdout, stderr } = runAs(version);

    expect(status).toBe(1);
    expect(stderr).toContain("Node 22.22 or later");
    expect(stderr).toContain(`This is Node ${version}.`);
    expect(stdout).toBe("");
  });

  it.each(["22.22.0", "23.0.0"])("lets Node %s through, and prints nothing", (version) => {
    const { status, stdout, stderr } = runAs(version);

    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
