// `publish`: the outbox is the publish boundary (KTD20). The command validates it,
// pushes it to the team repo with pull and retry, and tells a configured index.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEAM_BRANCH, recordId } from "@cairnfield/protocol";
import { EXIT } from "../src/outcome.ts";
import {
  ACCOUNT,
  ADMIN_KEY,
  INDEX,
  NODE,
  OUTBOX,
  TOKEN,
  bench,
  commitEntries,
  finding,
  git,
  pinned,
  published,
  putFile,
  putRecord,
  saveOutbox,
} from "./support.ts";
import type { Bench } from "./support.ts";

let on: Bench;
const others: Bench[] = [];
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  for (const other of others.splice(0)) other.dispose();
  on.dispose();
});

/** Pushes one more file to the team repo from somewhere else, as another run of the team's command would. */
function pushFromElsewhere(path: string, content = "{}\n"): void {
  const team = on.createRepo("team");
  const elsewhere = on.createRepo("elsewhere");
  const head = git(team, ["rev-parse", "--verify", "--quiet", `refs/heads/${TEAM_BRANCH}`]);
  git(elsewhere, ["fetch", "--quiet", team, TEAM_BRANCH]);
  const there = git(elsewhere, ["ls-tree", "-r", head]).split("\n").map((line) => {
    const [entry = "", held = ""] = line.split("\t");
    const [mode = "", , hash = ""] = entry.split(" ");
    return { path: held, mode, hash };
  });
  const commit = commitEntries(elsewhere, [...there, { path, content }], head);
  git(elsewhere, ["push", "--quiet", team, `${commit}:refs/heads/${TEAM_BRANCH}`]);
}

describe("publish", () => {
  it("pushes a hand-written finding to the team repo under the ID it had in the outbox", async () => {
    const { first } = await pinned(on);
    const record = finding(first);
    const path = await putRecord(on, record);
    on.node.notReadyFor = 1;

    const outcome = await on.run("publish");

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { records: 1, published: [path], notice: "none" } });
    expect(path).toBe(`records/${first}/finding/${await recordId(record)}.json`);
    expect(published(on)).toEqual([path]);
    const pushed = git(on.repo("team"), ["cat-file", "blob", `${TEAM_BRANCH}:${path}`]);
    expect(pushed).toBe(readFileSync(join(on.home, OUTBOX, path), "utf8").trim());
    expect((outcome.output as { head: string }).head).toBe(git(on.repo("team"), ["rev-parse", TEAM_BRANCH]));
  });

  it("publishes a demo team's saved outbox", async () => {
    await pinned(on);
    saveOutbox(on, "team-a");
    expect(await on.run("publish")).toMatchObject({ code: EXIT.ok, output: { records: 4 } });
    expect(published(on)).toHaveLength(4);
  });

  it("refuses to push when a record fails validation", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    const bad = await putRecord(on, finding(first, { criterion: "safe-enough" }));
    const requests = on.requests.length;
    const gitCalls = on.gitCalls.length;

    expect(await on.run("publish")).toEqual({
      code: EXIT.invalid,
      output: { records: 1, rejected: [{ record: bad, reason: "unknown-value", field: "criterion" }] },
    });
    expect(on.requests).toHaveLength(requests);
    expect(on.gitCalls).toHaveLength(gitCalls);
  });

  it("pulls and tries again when the remote moved, and keeps both sides' records", async () => {
    const { first } = await pinned(on);
    const earlier = await putRecord(on, finding(first));
    await on.run("publish");
    const mine = await putRecord(on, finding(first, { location: { path: "plugin.json", start: 13, end: 13 }, observation: "environment-access-all-variables" }));
    const theirs = `records/${first}/finding/${"c".repeat(64)}.json`;
    let moved = false;
    on.beforeGit = ([command]) => {
      if (command !== "push" || moved) return;
      moved = true;
      pushFromElsewhere(theirs);
    };

    const outcome = await on.run("publish");

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { published: [mine] } });
    expect(published(on)).toEqual([earlier, mine, theirs].sort());
    expect(on.gitCalls.filter(([command]) => command === "push")).toHaveLength(3);
  });

  it("gives up after six tries when the remote keeps moving", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    await on.run("publish");
    const mine = await putRecord(on, finding(first, { location: { path: "README.md", start: 1, end: 1 } }));
    let moves = 0;
    on.beforeGit = ([command]) => {
      if (command !== "push") return;
      moves += 1;
      pushFromElsewhere(`records/${first}/finding/${String(moves).repeat(64)}.json`);
    };

    expect(await on.run("publish")).toEqual({ code: EXIT.git, output: { error: "git-failed", step: "push" } });
    expect(moves).toBe(6);
    expect(published(on)).not.toContain(mine);
    // Six rounds of fetch, build and push, each with a push from elsewhere in between.
  }, 30_000);

  it("lands three runs at once on one repo, with no lost file", async () => {
    const { first } = await pinned(on);
    const runs = [on, bench(on), bench(on)];
    others.push(...runs.slice(1));
    const paths: string[] = [];
    for (const [at, each] of runs.entries()) {
      if (each !== on) await pinned(each);
      paths.push(await putRecord(each, finding(first, { location: { path: "README.md", start: at + 1, end: at + 1 } })));
    }

    const outcomes = await Promise.all(runs.map((each) => each.run("publish")));

    expect(outcomes.map((outcome) => outcome.code)).toEqual([EXIT.ok, EXIT.ok, EXIT.ok]);
    expect(published(on)).toEqual([...paths].sort());
  });

  it("pushes nothing the second time, and never changes a published record", async () => {
    const { first } = await pinned(on);
    const record = finding(first);
    const path = await putRecord(on, record);
    await on.run("publish");
    const head = git(on.repo("team"), ["rev-parse", TEAM_BRANCH]);
    const before = git(on.repo("team"), ["rev-parse", `${TEAM_BRANCH}:${path}`]);

    // The same record, written again without the spaces.
    putFile(on, path, JSON.stringify(record));
    const outcome = await on.run("publish");

    expect(outcome).toMatchObject({ code: EXIT.ok, output: { records: 1, published: [], head } });
    expect(git(on.repo("team"), ["rev-parse", TEAM_BRANCH])).toBe(head);
    expect(git(on.repo("team"), ["rev-parse", `${TEAM_BRANCH}:${path}`])).toBe(before);
  });

  it("fails when the branch holds something else where a record belongs, and writes over nothing", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    await on.run("publish");
    const other = await putRecord(on, finding(first, { location: { path: "README.md", start: 1, end: 1 } }));
    const under = await putRecord(on, finding(first, { location: { path: "README.md", start: 2, end: 2 } }));
    // Someone pushed a file that is no record to one path, and a folder to the other.
    pushFromElsewhere(other);
    pushFromElsewhere(`${under}/stray.json`);
    const head = git(on.repo("team"), ["rev-parse", TEAM_BRANCH]);
    const pushes = on.gitCalls.filter(([command]) => command === "push").length;

    const outcome = await on.run("publish");

    expect(outcome).toEqual({ code: EXIT.git, output: { error: "record-conflict", records: [other, under].sort() } });
    expect(git(on.repo("team"), ["rev-parse", TEAM_BRANCH])).toBe(head);
    expect(on.gitCalls.filter(([command]) => command === "push")).toHaveLength(pushes);
  });

  it("does not read a file that is too large to be a record before it calls it a conflict", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    await on.run("publish");
    const mine = await putRecord(on, finding(first, { location: { path: "README.md", start: 3, end: 3 } }));
    pushFromElsewhere(mine, "x".repeat(5000));
    const reads = (): number => on.gitCalls.filter(([command, flag]) => command === "cat-file" && flag === "--batch").length;
    const before = reads();

    expect(await on.run("publish")).toEqual({ code: EXIT.git, output: { error: "record-conflict", records: [mine] } });
    expect(reads()).toBe(before);
  });

  it("does nothing for an empty outbox", async () => {
    await pinned(on);
    const requests = on.requests.length;
    expect(await on.run("publish")).toEqual({ code: EXIT.ok, output: { records: 0, published: [], notice: "none" } });
    expect(on.requests).toHaveLength(requests);
  });

  describe("with an index in the config", () => {
    beforeEach(() => {
      on.configure({ node: NODE, index: INDEX });
      on.index.nodes.push(NODE);
    });

    it("sends one notice that names its own node after the push lands", async () => {
      const { first } = await pinned(on);
      await putRecord(on, finding(first));

      expect(await on.run("publish")).toMatchObject({ code: EXIT.ok, output: { notice: "sent" } });
      expect(on.index.notices).toEqual([{ node: NODE }]);
      expect(on.gitCalls.filter(([command]) => command === "push")).toHaveLength(1);
    });

    it("sends no notice when the push fails", async () => {
      const { first } = await pinned(on);
      await putRecord(on, finding(first));
      on.beforeGit = ([command]) => {
        if (command === "push") rmSync(on.repo("team"), { recursive: true });
      };

      expect(await on.run("publish")).toEqual({ code: EXIT.git, output: { error: "git-failed", step: "push" } });
      expect(on.index.notices).toEqual([]);
    });

    it("says so when the push landed and the notice did not, and sends it on the next run", async () => {
      const { first } = await pinned(on);
      const path = await putRecord(on, finding(first));
      on.index.noticeStatus = 503;

      expect(await on.run("publish")).toMatchObject({ code: EXIT.index, output: { published: [path], notice: "failed" } });
      expect(published(on)).toEqual([path]);

      on.index.noticeStatus = undefined;
      expect(await on.run("publish")).toMatchObject({ code: EXIT.ok, output: { published: [], notice: "sent" } });
      expect(on.index.notices).toEqual([{ node: NODE }]);
    });
  });

  it("sends no notice and registers nothing when the config names no index", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    await on.run("publish");
    expect(on.requests.filter((seen) => seen.url.startsWith(INDEX))).toEqual([]);
  });

  it("refuses a remote that is not HTTPS, or not on an Artifacts host, before Git runs", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    const gitCalls = on.gitCalls.length;
    const wrong = [`http://${ACCOUNT}.artifacts.cloudflare.net/git/cairnfield-team-a/team.git`, "https://git.other-host.example/git/cairnfield-team-a/team.git"];
    for (const remote of wrong) {
      on.node.remote = () => remote;
      expect(await on.run("publish"), remote).toEqual({ code: EXIT.node, output: { error: "node-bad-answer" } });
    }
    expect(on.gitCalls).toHaveLength(gitCalls);
  });

  it("keeps the token and the keys out of Git's arguments, the repo's configuration and everything it prints", async () => {
    const { first } = await pinned(on);
    await putRecord(on, finding(first));
    let configAtPush = "";
    on.beforeGit = ([command], call) => {
      if (command !== "push") return;
      const dir = call.env["GIT_DIR"] ?? "";
      configAtPush = existsSync(join(dir, "config")) ? readFileSync(join(dir, "config"), "utf8") : "missing";
      rmSync(on.repo("team"), { recursive: true });
    };

    const outcome = await on.run("publish");

    expect(outcome.code).toBe(EXIT.git);
    expect(on.warnings.join("")).not.toBe("");
    const secret = TOKEN.slice(0, 20);
    expect(configAtPush).not.toBe("missing");
    expect(configAtPush).not.toContain(secret);
    expect(JSON.stringify(on.gitCalls)).not.toContain(secret);
    expect(JSON.stringify(outcome.output)).not.toContain(secret);
    expect(on.warnings.join("")).not.toContain(secret);
    expect(on.warnings.join("")).not.toContain(ACCOUNT);
    // Git gets the token through its environment, for the one remote the token opens, and gets no key.
    const env = on.gitEnvs.at(-1) ?? {};
    const keys = Object.keys(env).filter((name) => (env[name] ?? "").includes(secret));
    expect(keys).toEqual([expect.stringMatching(/^GIT_CONFIG_VALUE_\d+$/)]);
    expect(Object.values(env)).toContain(`http.https://${ACCOUNT}.artifacts.cloudflare.net/git/cairnfield-team-a/team.git.extraHeader`);
    expect(JSON.stringify(on.gitEnvs)).not.toContain(ADMIN_KEY);
  });
});
