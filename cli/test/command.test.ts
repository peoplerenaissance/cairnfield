// The command as a whole: its config file, its keys, its arguments and what it prints.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../src/outcome.ts";
import { isArtifactsRemote, redact } from "../src/git.ts";
import { run } from "../src/run.ts";
import { ACCOUNT, INDEX, NODE, TOKEN, bench, remoteOf } from "./support.ts";
import type { Bench } from "./support.ts";

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

describe("the config file", () => {
  it("is read from the working folder, or from the path the command is given", async () => {
    expect(await on.run("validate")).toMatchObject({ code: EXIT.ok });

    const elsewhere = join(on.home, "team-b");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "team-b.json"), JSON.stringify({ node: "https://node.team-b.example" }));
    expect(await on.run("validate", "--config", "team-b/team-b.json")).toMatchObject({ code: EXIT.ok });
  });

  it.each(["checkouts", "copies"])("is never read from inside one of the %s, where a component could have put one", async (folder) => {
    const inside = join(on.home, ".cairnfield", folder, "1f".repeat(20));
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, "cairnfield.json"), JSON.stringify({ node: "https://node.elsewhere.example" }));

    const named = await on.run("validate", "--config", join(inside, "cairnfield.json"));
    expect(named).toEqual({ code: EXIT.usage, output: { error: "bad-config" } });
    expect(await run({ ...on.io, cwd: inside }, ["validate"])).toEqual({ code: EXIT.usage, output: { error: "bad-config" } });
  });

  it("must be there", async () => {
    expect(await on.run("validate", "--config", "none.json")).toEqual({ code: EXIT.usage, output: { error: "no-config" } });
  });

  it.each([
    ["text that is not JSON", "{ node: "],
    ["no node", JSON.stringify({ index: INDEX })],
    ["a node address that is not HTTPS", JSON.stringify({ node: "http://node.team-a.example" })],
    ["a node address with a slash at its end", JSON.stringify({ node: `${NODE}/` })],
    ["an index address that is not HTTPS", JSON.stringify({ node: NODE, index: "http://index.cairnfield.example" })],
    ["an index address with a slash at its end", JSON.stringify({ node: NODE, index: `${INDEX}/` })],
    ["a field it does not know", JSON.stringify({ node: NODE, adminKey: "kept-in-a-file" })],
  ])("is refused when it holds %s", async (_why, text) => {
    writeFileSync(join(on.home, "cairnfield.json"), text);
    expect(await on.run("validate")).toEqual({ code: EXIT.usage, output: { error: "bad-config" } });
  });
});

describe("a key", () => {
  it("is refused when it could not travel in a header", async () => {
    on.env["CAIRNFIELD_ADMIN_KEY"] = "a key\nwith a line break";
    const outcome = await on.run("pin", "https://git.fellbeck-tools.example/plugin.git", "--branch", "main", "--commit", "1f".repeat(20));
    expect(outcome).toEqual({ code: EXIT.usage, output: { error: "no-key", key: "CAIRNFIELD_ADMIN_KEY" } });
  });
});

describe("the arguments", () => {
  it.each([
    ["no command", []],
    ["a command that does not exist", ["review"]],
    ["an argument too many", ["validate", "now"]],
    ["an option of another command", ["validate", "--commit", "1f".repeat(20)]],
    ["a view of something that is no commit", ["view", "main"]],
    ["a copy of something that is no commit", ["assemble", "main"]],
    ["a verdict for something that is no commit", ["decide", "main", "--verdict", "approved"]],
    ["a verdict on a tree that is no hash", ["decide", "1f".repeat(20), "--verdict", "approved", "--tree", "main"]],
    ["a check of a component that is named by no URL", ["verify", "fellbeck-sync", ".", "--approvals", "approvals.json"]],
    ["a check with no folder", ["verify", "https://git.fellbeck-tools.example/plugin.git", "--approvals", "approvals.json"]],
    ["a check with a config file, which it does not read", ["verify", "https://git.fellbeck-tools.example/plugin.git", ".", "--config", "cairnfield.json"]],
  ])("are refused for %s", async (_why, argv) => {
    expect(await on.run(...argv)).toEqual({ code: EXIT.usage, output: { error: "usage" } });
  });
});

describe("a Git remote from a node (KTD33)", () => {
  it("is accepted in the Artifacts form", () => {
    expect(isArtifactsRemote(remoteOf("team"))).toBe(true);
    expect(isArtifactsRemote(remoteOf(`fork-${"1f".repeat(20)}`))).toBe(true);
  });

  it.each([
    ["plain HTTP", `http://${ACCOUNT}.artifacts.cloudflare.net/git/a-team/team.git`],
    ["another host", "https://git.other-host.example/git/a-team/team.git"],
    ["a host that only ends like the Artifacts host", `https://${ACCOUNT}.artifacts.cloudflare.net.other-host.example/git/a-team/team.git`],
    ["an account ID that is too short", "https://0123abcd.artifacts.cloudflare.net/git/a-team/team.git"],
    ["an account ID in upper case", `https://${ACCOUNT.toUpperCase()}.artifacts.cloudflare.net/git/a-team/team.git`],
    ["credentials", `https://user:pw@${ACCOUNT}.artifacts.cloudflare.net/git/a-team/team.git`],
    ["a port", `https://${ACCOUNT}.artifacts.cloudflare.net:8443/git/a-team/team.git`],
    ["a namespace Artifacts would not accept", `https://${ACCOUNT}.artifacts.cloudflare.net/git/A/team.git`],
    ["a repo name that starts like an option", `https://${ACCOUNT}.artifacts.cloudflare.net/git/a-team/--upload-pack=x.git`],
    ["a path under the repo", `https://${ACCOUNT}.artifacts.cloudflare.net/git/a-team/team.git/info`],
    ["a query", `${remoteOf("team")}?x=1`],
    ["a local path", "/tmp/team.git"],
    ["no string", undefined],
  ])("is refused with %s", (_why, remote) => {
    expect(isArtifactsRemote(remote)).toBe(false);
  });
});

describe("what Git wrote to standard error", () => {
  it("is passed on without a token and without an account ID", () => {
    const other = `art_v1_${"0d".repeat(20)}`;
    const said = `fatal: unable to access '${remoteOf("team")}/': ${TOKEN} and ${other} were refused`;
    expect(redact(said, [TOKEN])).toBe(
      "fatal: unable to access 'https://[account].artifacts.cloudflare.net/git/cairnfield-team-a/team.git/': [token] and [token] were refused",
    );
  });
});

describe("a write to standard error", () => {
  it("waits for a pipe that takes no more, so the command never holds all it prints", async () => {
    const io = new URL("../src/io.ts", import.meta.url).href;
    // 2 MiB in lines of 1 KiB, which is far more than a pipe holds. The script says when
    // it starts, and at its end the most that Node held back at any one time.
    const script = [
      `const { processIo } = await import(${JSON.stringify(io)});`,
      "const { warn } = processIo();",
      'const line = `${"x".repeat(1023)}\\n`;',
      "let held = 0;",
      'process.stdout.write("started\\n");',
      "for (let at = 0; at < 2048; at += 1) {",
      "  await warn(line);",
      "  held = Math.max(held, process.stderr.writableLength);",
      "}",
      "process.stdout.write(String(held));",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script]);
    let said = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      said += text;
    });

    // Nothing reads what the script prints until its pipe has had time to fill.
    await once(child.stdout, "data");
    await sleep(250);
    let printed = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      printed += text;
    });
    const [status] = await once(child, "close");

    expect(status).toBe(0);
    expect(printed.match(/^x{1023}$/gm)).toHaveLength(2048);
    expect(Number(said.split("\n")[1])).toBeLessThan(256 * 1024);
  });
});

describe("the command's own file", () => {
  it("prints one line of JSON and returns the exit code", () => {
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const ran = spawnSync(process.execPath, [main, "validate"], { cwd: on.home, encoding: "utf8" });
    expect(ran.stdout).toBe('{"records":0,"rejected":[]}\n');
    expect(ran.status).toBe(EXIT.ok);

    const refused = spawnSync(process.execPath, [main, "view", "1f".repeat(20)], { cwd: on.home, encoding: "utf8" });
    expect(refused.stdout).toBe('{"error":"no-index"}\n');
    expect(refused.status).toBe(EXIT.noIndex);
  });

  it("can be started by its name", () => {
    const bin = fileURLToPath(new URL("../../node_modules/.bin/cairnfield", import.meta.url));
    expect(execFileSync(bin, ["validate"], { cwd: on.home, encoding: "utf8" })).toBe('{"records":0,"rejected":[]}\n');
  });

  it("says which Node it needs on an older one, as its one line of JSON and as a sentence, and runs nothing", async () => {
    const versions = process.versions;
    const printed: string[] = [];
    const told: string[] = [];
    Object.defineProperty(process, "versions", { value: { ...versions, node: "20.19.4" }, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation((text) => (printed.push(String(text)), true));
    vi.spyOn(console, "error").mockImplementation((line: string) => void told.push(line));
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    try {
      // The launcher is what the command's name is linked to. It reads the version before it loads the command.
      await expect(import(new URL("../bin/cairnfield.mjs", import.meta.url).href)).rejects.toThrow(`exit ${EXIT.usage}`);
    } finally {
      vi.restoreAllMocks();
      Object.defineProperty(process, "versions", { value: versions, configurable: true });
    }

    expect(printed).toEqual(['{"error":"node-too-old","needs":"22.22","found":"20.19.4"}\n']);
    expect(told).toEqual(["cairnfield needs Node 22.22 or later. This is Node 20.19.4."]);
  });
});
