// A bench for the command's tests: a folder with a config file, a fake node and a fake
// index behind `fetch`, and real Git against local repos that stand in for the node's
// Artifacts repos. Every host, key and token here is invented.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_KEY_HEADER,
  REGISTRATION_KEY_HEADER,
  SCHEMA_VERSION,
  TEAM_BRANCH,
  isCommit,
  parseRecordPath,
  recordId,
  recordPath,
} from "@cairnfield/protocol";
import type { AnyRecord } from "@cairnfield/protocol";
import { runGit } from "../src/git.ts";
import type { GitCall, GitRunner } from "../src/git.ts";
import type { Io } from "../src/io.ts";
import type { Outcome } from "../src/outcome.ts";
import { run } from "../src/run.ts";

export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
export const NODE = "https://node.team-a.example";
export const OTHER_NODE = "https://node.team-b.example";
export const INDEX = "https://index.cairnfield.example";
export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const NAMESPACE = "cairnfield-team-a";
export const ADMIN_KEY = "the-admin-key-of-team-a";
export const REGISTRATION_KEY = "the-registration-key";
export const MODEL_API = "https://api.anthropic.com";
// Drawn for each run. It stands in for a model key, and no service ever sees it.
export const MODEL_KEY = `model-key-${randomUUID()}`;
// Built here, so the secret scan does not read the source as holding a token.
export const TOKEN = `art_v2_${"5e".repeat(20)}?expires=1900000000`;

/** The remote the fake node names for one of its repos, in the Artifacts form. */
export const remoteOf = (repo: string): string =>
  `https://${ACCOUNT}.artifacts.cloudflare.net/git/${NAMESPACE}/${repo}.git`;

const GIT_ENV = {
  PATH: process.env["PATH"] ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "A test",
  GIT_AUTHOR_EMAIL: "test@cairnfield.example",
  GIT_COMMITTER_NAME: "A test",
  GIT_COMMITTER_EMAIL: "test@cairnfield.example",
  GIT_AUTHOR_DATE: "2026-10-09T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-09T12:00:00Z",
};

/** Runs Git for a test's own setup, with no user configuration. */
export function git(dir: string, args: readonly string[], input?: string | Uint8Array): string {
  // Letter case is kept apart, so a test can build a tree that a disk of this machine could not hold.
  const all = ["-c", "core.ignorecase=false", "-C", dir, ...args];
  return execFileSync("git", all, { env: GIT_ENV, encoding: "utf8", ...(input === undefined ? {} : { input }) }).trim();
}

/** One entry of a tree a test builds. Content gives a blob, and `hash` names an object the repo need not hold. */
export interface Entry {
  readonly path: string;
  readonly content?: string | Uint8Array;
  readonly mode?: string;
  readonly hash?: string;
}

/** Commits a tree with Git's plumbing, so a test can hold entries a work tree cannot. Returns the commit. */
export function commitEntries(repo: string, entries: readonly Entry[], parent?: string): string {
  git(repo, ["read-tree", "--empty"]);
  for (const entry of entries) {
    const blob = entry.hash ?? git(repo, ["hash-object", "-w", "--stdin"], entry.content ?? "");
    git(repo, ["update-index", "--add", "--cacheinfo", `${entry.mode ?? "100644"},${blob},${entry.path}`]);
  }
  const tree = git(repo, ["write-tree"]);
  const commit = git(repo, ["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", "a test commit"]);
  git(repo, ["update-ref", `refs/heads/${TEAM_BRANCH}`, commit]);
  return commit;
}

/** One HTTP request the command made. */
export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
  /** What the request asked `fetch` to do with a redirect. */
  readonly redirect: string | undefined;
}

export interface FakeNode {
  /** How many more answers say `ready: false`. */
  notReadyFor: number;
  /** A refusal the import route gives in place of a repo. */
  importRefusal: string | undefined;
  /** The remote the token route names for a repo. */
  remote: (repo: string) => string;
}

/** One answer of the fake model: the content of its message and why it stopped. */
export interface ModelAnswer {
  readonly content: readonly object[];
  readonly stop: string;
  readonly details?: object;
  /** The tokens the answer reports, when a test counts them. */
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
}

export interface FakeModel {
  /** The answers the model gives, in order. */
  readonly answers: ModelAnswer[];
  /** Every request the command sent to the model. */
  readonly requests: Seen[];
}

let toolCalls = 0;

/** An answer in which the model calls tools. */
export function calls(...uses: readonly (readonly [name: string, input: object])[]): ModelAnswer {
  return {
    stop: "tool_use",
    content: uses.map(([name, input]) => ({ type: "tool_use", id: `toolu_${toolCalls++}`, name, input })),
  };
}

/** An answer that ends the model's turn with a value, or with text that is no JSON. */
export function answers(value: unknown): ModelAnswer {
  return { stop: "end_turn", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

export const REFUSAL: ModelAnswer = { stop: "refusal", content: [], details: { type: "refusal", category: "cyber", explanation: null } };

export interface FakeIndex {
  readonly nodes: string[];
  readonly components: unknown[];
  readonly notices: unknown[];
  /** The view the index serves, by component. */
  readonly views: Map<string, unknown>;
  /** A status the notice route answers in place of 200. */
  noticeStatus: number | undefined;
}

export interface Bench {
  /** The folder that holds the config file. */
  readonly home: string;
  /** The local repos that stand in for the node's Artifacts repos. */
  readonly remotes: string;
  readonly io: Io;
  /** The environment the command runs in. A test may take a key out. */
  readonly env: { [name: string]: string | undefined };
  /** The arguments of every Git call the command made. */
  readonly gitCalls: (readonly string[])[];
  /** The environment of every Git call the command made. */
  readonly gitEnvs: GitCall["env"][];
  readonly requests: Seen[];
  /** What the command wrote to standard error. */
  readonly warnings: string[];
  readonly sleeps: number[];
  readonly node: FakeNode;
  readonly index: FakeIndex;
  readonly model: FakeModel;
  /** The whole number the command draws next. */
  nextRandom: number;
  /** Called before each Git call, so a test can change the remote under the command. */
  beforeGit: ((args: readonly string[], call: GitCall) => void) | undefined;
  /** Answers a request in place of the fake node and index, or throws as a network would. */
  respond: ((seen: Seen) => Response | undefined) | undefined;
  /** Writes the config file. */
  configure(config: { readonly [field: string]: unknown }): void;
  run(...argv: string[]): Promise<Outcome>;
  /** The path of one of the node's repos on this disk. */
  repo(name: string): string;
  /** Makes one of the node's repos, empty. */
  createRepo(name: string): string;
  dispose(): void;
}

const NODE_STATUS: { readonly [error: string]: number } = {
  "bad-request": 400,
  unauthorized: 401,
  refused: 403,
  "not-found": 404,
  "not-ready": 409,
};

function refuse(error: string): Response {
  return Response.json({ error }, { status: NODE_STATUS[error] ?? 400 });
}

function repoName(body: { readonly repo?: unknown; readonly component?: unknown }): string {
  return body.repo === "team" ? "team" : `${String(body.repo)}-${String(body.component)}`;
}

/** Makes a bench. A bench that shares another's remotes is a second command of the same team. */
export function bench(sharing?: Bench): Bench {
  const root = mkdtempSync(join(tmpdir(), "cairnfield-cli-"));
  const home = join(root, "home");
  const remotes = sharing?.remotes ?? join(root, "remotes");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(remotes, NAMESPACE), { recursive: true });

  const repo = (name: string): string => join(remotes, NAMESPACE, `${name}.git`);
  const createRepo = (name: string): string => {
    const dir = repo(name);
    if (!existsSync(dir)) {
      execFileSync("git", ["init", "--quiet", "--bare", `--initial-branch=${TEAM_BRANCH}`, dir], { env: GIT_ENV });
      // The Artifacts service gives a commit by its hash, and a local repo does so only when told to.
      git(dir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    }
    return dir;
  };

  const node: FakeNode = { notReadyFor: 0, importRefusal: undefined, remote: remoteOf };
  const index: FakeIndex = { nodes: [], components: [], notices: [], views: new Map(), noticeStatus: undefined };
  const ready = (): boolean => {
    if (node.notReadyFor === 0) return true;
    node.notReadyFor -= 1;
    return false;
  };

  /** The team repo's head and its record files, as the node lists them. */
  function listing(): Response {
    let head: string;
    try {
      head = git(repo("team"), ["rev-parse", "--verify", "--quiet", `refs/heads/${TEAM_BRANCH}`]);
    } catch {
      return refuse("not-found");
    }
    const listed = git(repo("team"), ["ls-tree", "-r", head, "records/"]);
    const records = (listed === "" ? [] : listed.split("\n")).map((line) => {
      const [entry = "", path = ""] = line.split("\t");
      return { path, blob: entry.split(" ")[2] };
    });
    return Response.json({ head, records });
  }

  /** One file of the team repo at a commit, as the node serves it: the bytes, unchecked. */
  function file(query: URLSearchParams): Response {
    const { commit, path } = Object.fromEntries(query);
    // As on the node: only a commit hash and a record's path name a file.
    if (!isCommit(commit) || path === undefined || !parseRecordPath(path)) return refuse("bad-request");
    try {
      const bytes = execFileSync("git", ["-C", repo("team"), "cat-file", "blob", `${commit}:${path}`], { env: GIT_ENV });
      return new Response(bytes, { headers: { "content-type": "application/json" } });
    } catch {
      return refuse("not-found");
    }
  }

  function nodeAnswer(seen: Seen, path: string, query: URLSearchParams): Response {
    if (seen.method === "GET" && path === "records") return listing();
    if (seen.method === "GET" && path === "file") return file(query);
    if (!path.startsWith("admin/")) return refuse("not-found");
    if (seen.headers.get(ADMIN_KEY_HEADER) !== ADMIN_KEY) return refuse("unauthorized");
    const body = (seen.body ?? {}) as { readonly repo?: unknown; readonly component?: unknown; readonly commit?: unknown };
    if (path === "admin/import") {
      if (node.importRefusal !== undefined) return refuse(node.importRefusal);
      return Response.json({ repo: `copy-${String(body.commit)}`, ready: ready() });
    }
    if (path === "admin/team-repo") {
      createRepo("team");
      return Response.json({ repo: "team", ready: ready() });
    }
    if (path === "admin/fork") {
      const copy = repo(`copy-${String(body.component)}`);
      if (!existsSync(copy)) return refuse("not-found");
      const name = `fork-${String(body.component)}`;
      // A fork holds everything its copy holds.
      if (!existsSync(repo(name))) git(copy, ["push", "--quiet", createRepo(name), "refs/*:refs/*"]);
      return Response.json({ repo: name, ready: ready() });
    }
    if (path === "admin/token") {
      const name = repoName(body);
      if (!existsSync(repo(name))) return refuse("not-found");
      return Response.json({ remote: node.remote(name), token: TOKEN, expires: 1_900_000_000 });
    }
    return refuse("not-found");
  }

  function indexAnswer(seen: Seen, path: string): Response {
    const answer = (body: object, status = 200): Response => Response.json({ version: SCHEMA_VERSION, ...body }, { status });
    const keyed = seen.headers.get(REGISTRATION_KEY_HEADER) === REGISTRATION_KEY;
    if (seen.method === "POST" && path === "/nodes") {
      if (!keyed) return answer({ error: "unauthorized" }, 401);
      const { url } = seen.body as { readonly url: string };
      if (index.nodes.includes(url)) return answer({ error: "already-registered" }, 409);
      index.nodes.push(url);
      return answer({ node: url });
    }
    if (seen.method === "POST" && path === "/components") {
      if (!keyed) return answer({ error: "unauthorized" }, 401);
      index.components.push(seen.body);
      return answer({ component: (seen.body as { readonly commit: string }).commit, state: "importing" });
    }
    if (seen.method === "POST" && path === "/notices") {
      if (index.noticeStatus !== undefined) return new Response("", { status: index.noticeStatus });
      index.notices.push(seen.body);
      return answer({});
    }
    const view = /^\/components\/([0-9a-f]{40})\/view$/.exec(path);
    if (seen.method === "GET" && view) {
      const held = index.views.get(view[1] ?? "");
      return held === undefined ? answer({ error: "not-found" }, 404) : Response.json(held);
    }
    return answer({ error: "not-found" }, 404);
  }

  const model: FakeModel = { answers: [], requests: [] };
  function modelAnswer(seen: Seen): Response {
    model.requests.push(seen);
    const next = model.answers.shift();
    // A status the command does not try again.
    if (!next) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "no answer left" } }, { status: 400 });
    return Response.json({
      id: `msg_${model.requests.length}`,
      type: "message",
      role: "assistant",
      model: (seen.body as { readonly model: string }).model,
      content: next.content,
      stop_reason: next.stop,
      stop_sequence: null,
      stop_details: next.details ?? null,
      usage: next.usage ?? { input_tokens: 100, output_tokens: 10 },
    });
  }

  const requests: Seen[] = [];
  const fetchFake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const text = typeof init?.body === "string" ? init.body : undefined;
    const seen: Seen = {
      method: init?.method ?? "GET",
      url: url.href,
      headers: new Headers(init?.headers),
      body: text === undefined ? undefined : (JSON.parse(text) as unknown),
      redirect: init?.redirect,
    };
    requests.push(seen);
    const given = made.respond?.(seen);
    if (given) return given;
    if (url.origin === NODE) return nodeAnswer(seen, url.pathname.slice(1), url.searchParams);
    if (url.origin === INDEX) return indexAnswer(seen, url.pathname);
    if (url.origin === MODEL_API && url.pathname === "/v1/messages") return modelAnswer(seen);
    throw new TypeError(`no such host: ${url.host}`);
  };

  const gitCalls: (readonly string[])[] = [];
  const gitEnvs: GitCall["env"][] = [];
  // The command names a remote on the Artifacts host. Git is told here, and only here,
  // to read that host from this disk.
  const gitFake: GitRunner = async (args, call) => {
    gitCalls.push([...args]);
    gitEnvs.push(call.env);
    made.beforeGit?.(args, call);
    const count = Number(call.env["GIT_CONFIG_COUNT"] ?? "0");
    return runGit(args, {
      ...call,
      env: {
        ...call.env,
        GIT_CONFIG_COUNT: String(count + 1),
        [`GIT_CONFIG_KEY_${count}`]: `url.file://${remotes}/.insteadOf`,
        [`GIT_CONFIG_VALUE_${count}`]: `https://${ACCOUNT}.artifacts.cloudflare.net/git/`,
      },
    });
  };

  let clock = 0;
  const env: Bench["env"] = {
    PATH: process.env["PATH"],
    CAIRNFIELD_ADMIN_KEY: ADMIN_KEY,
    CAIRNFIELD_REGISTRATION_KEY: REGISTRATION_KEY,
    ANTHROPIC_API_KEY: MODEL_KEY,
  };
  const warnings: string[] = [];
  const sleeps: number[] = [];
  const made: Bench = {
    home,
    remotes,
    env,
    gitCalls,
    gitEnvs,
    requests,
    warnings,
    sleeps,
    node,
    index,
    model,
    nextRandom: 7,
    beforeGit: undefined,
    respond: undefined,
    io: {
      env,
      cwd: home,
      fetch: fetchFake,
      git: gitFake,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        sleeps.push(ms);
      },
      random: (bound) => Math.min(made.nextRandom, bound - 1),
      warn: (text) => {
        warnings.push(text);
      },
    },
    configure: (config) => {
      writeFileSync(join(home, "cairnfield.json"), JSON.stringify(config));
    },
    run: (...argv) => run(made.io, argv),
    repo,
    createRepo,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
  made.configure({ node: NODE });
  return made;
}

interface Commits {
  readonly url: string;
  readonly branch: string;
  readonly first: string;
  readonly later: string;
}

// The demo plugin's repo is built once for each test file, and every bench copies from it.
let built: string | undefined;

function pluginRepo(): string {
  if (built === undefined) {
    const root = mkdtempSync(join(tmpdir(), "cairnfield-plugin-"));
    process.on("exit", () => {
      rmSync(root, { recursive: true, force: true });
    });
    built = join(root, "plugin");
    execFileSync("sh", [`${FIXTURES}demo-plugin/build-repo.sh`, built], { env: GIT_ENV });
  }
  return built;
}

/** The demo plugin, as the node would hold it after an import: the copy of its first commit. */
export function demoPlugin(on: Bench): Commits {
  const repo = pluginRepo();
  const [first = "", later = ""] = git(repo, ["rev-parse", "HEAD~1", "HEAD"]).split("\n");
  git(repo, ["push", "--quiet", on.createRepo(`copy-${first}`), TEAM_BRANCH]);
  return { url: "https://github.com/peoplerenaissance/fellbeck-sync", branch: TEAM_BRANCH, first, later };
}

/** Pins the demo plugin's first commit, so a test starts with its checkout. */
export async function pinned(on: Bench): Promise<Commits> {
  const plugin = demoPlugin(on);
  const outcome = await on.run("pin", plugin.url, "--branch", plugin.branch, "--commit", plugin.first);
  if (outcome.code !== 0) throw new Error(`the pin failed: ${JSON.stringify(outcome.output)}`);
  return plugin;
}

/** Makes the node's copy of a component from the given tree, and pins it. */
export async function pinTree(on: Bench, tree: readonly Entry[]): Promise<{ readonly commit: string; readonly outcome: Outcome }> {
  const source = on.createRepo("source");
  const commit = commitEntries(source, tree);
  git(source, ["push", "--quiet", on.createRepo(`copy-${commit}`), TEAM_BRANCH]);
  const outcome = await on.run("pin", "https://git.fellbeck-tools.example/plugin.git", "--branch", TEAM_BRANCH, "--commit", commit);
  return { commit, outcome };
}

export const OUTBOX = ".cairnfield/outbox";

/** Writes a record file to the outbox as a person would, with spaces and line breaks. Returns its path there. */
export async function putRecord(on: Bench, record: object): Promise<string> {
  const path = recordPath(record as AnyRecord, await recordId(record));
  putFile(on, path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function putFile(on: Bench, path: string, content: string | Uint8Array): void {
  const file = join(on.home, OUTBOX, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Copies one demo team's saved findings into the outbox. */
export function saveOutbox(on: Bench, team: string): void {
  cpSync(`${FIXTURES}outboxes/${team}`, join(on.home, OUTBOX), { recursive: true });
}

/** A finding a person might write: the any-host rule of the demo plugin. */
export function finding(component: string, overrides: { readonly [field: string]: unknown } = {}): object {
  return {
    version: SCHEMA_VERSION,
    type: "finding",
    component,
    location: { path: "plugin.json", start: 12, end: 12 },
    criterion: "safe-to-run-with-access",
    observation: "network-access-any-host",
    check: "permissions",
    model: "none",
    ...overrides,
  };
}

/** The paths of the record files on the team repo's branch. */
export function published(on: Bench): string[] {
  const listed = git(on.repo("team"), ["ls-tree", "-r", "--name-only", TEAM_BRANCH]);
  return listed === "" ? [] : listed.split("\n");
}
