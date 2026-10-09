// How the command runs Git (KTD33).
//
// Every remote and every token comes from a node, so the command checks the remote's
// form before Git sees it and gives Git the token through its environment, never in a
// URL or an argument. Git runs with the operator's global and system configuration
// switched off and with an environment the command builds itself, so no key of the
// command reaches it. The command never checks a work tree out with Git: it reads and
// writes objects with Git's plumbing, so no hook, filter, line-ending rule or attribute
// file changes one.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { isGitHash, isNamespaceName, isRepoName } from "@cairnfield/protocol";
import type { Io } from "./io.ts";
import { EXIT, stop } from "./outcome.ts";

export interface GitRun {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  /** Git wrote more than the call allowed, and was stopped there. */
  readonly overflowed: boolean;
}

export interface GitCall {
  readonly env: { readonly [name: string]: string };
  /** Bytes for Git's standard input. */
  readonly input?: Uint8Array;
  /** The most standard output to keep. What Git lists and reads may come from a hostile repo, so none of it is unbounded. */
  readonly maxOutput: number;
}

/** Starts one Git process and waits for it. */
export type GitRunner = (args: readonly string[], call: GitCall) => Promise<GitRun>;

/** No Git call runs longer than this. A fetch or a push that stalls is also cut off sooner, by the settings below. */
const GIT_DEADLINE_MS = 10 * 60_000;
/** What Git writes to standard error is kept up to this size. */
const MAX_ERROR_BYTES = 1024 * 1024;
/** The most standard output a Git call may give, unless the call sets a limit of its own. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** How much standard output a Git call may give, and the code the command ends with when Git gives more. */
export interface OutputLimit {
  readonly bytes: number;
  readonly error: string;
}

export const runGit: GitRunner = (args, call) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      env: { ...call.env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_DEADLINE_MS,
      killSignal: "SIGKILL",
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let kept = 0;
    let errorBytes = 0;
    let overflowed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      kept += chunk.length;
      if (kept > call.maxOutput) {
        overflowed = true;
        child.kill("SIGKILL");
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes <= MAX_ERROR_BYTES) err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), overflowed });
    });
    // A Git that ends before it has read its input closes the pipe, which is no failure of its own.
    child.stdin.on("error", () => undefined);
    child.stdin.end(call.input);
  });

const ARTIFACTS_REMOTE = /^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/([^/]+)\/([^/]+)\.git$/;

/**
 * Whether a Git remote has the Artifacts form, with names that pass the protocol's
 * rules. A node cannot then point Git at another host, or pass it an option.
 */
export function isArtifactsRemote(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ARTIFACTS_REMOTE.exec(value);
  return match !== null && isNamespaceName(match[1]) && isRepoName(match[2]);
}

/** One repo of a node and the token that opens it. Both are held in memory only. */
export interface Access {
  readonly remote: string;
  readonly token: string;
}

const TOKEN = /art_v[0-9]+_[0-9a-f]+(?:\?expires=[0-9]+)?/g;
const ACCOUNT = /[0-9a-f]{32}(?=\.artifacts\.cloudflare\.net)/g;

/** Takes tokens and account IDs out of text that Git wrote, before a person or a log sees it. */
export function redact(text: string, tokens: readonly string[]): string {
  let safe = text;
  for (const token of tokens) safe = safe.replaceAll(token, "[token]");
  return safe.replace(TOKEN, "[token]").replace(ACCOUNT, "[account]");
}

// What Git needs from the command's own environment to start and to reach a host.
// Nothing else is passed on, so a key of the command never reaches Git.
const PASSED_ON = [
  "PATH",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
];

const IDENTITY = { name: "Cairnfield command", email: "command@cairnfield.example" };

function environment(io: Io, dir: string, { access, index, date }: GitOptions): GitCall["env"] {
  const env: { [name: string]: string } = {};
  for (const name of PASSED_ON) {
    const value = io.env[name];
    if (value !== undefined) env[name] = value;
  }
  const config: (readonly [key: string, value: string])[] = [
    ["core.hooksPath", devNull],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    // A transfer that moves under 1,000 bytes a second for a minute has stalled.
    ["http.lowSpeedLimit", "1000"],
    ["http.lowSpeedTime", "60"],
  ];
  // The header is tied to the one remote the token opens, so no other fetch carries it.
  if (access) config.push([`http.${access.remote}.extraHeader`, `Authorization: Bearer ${access.token}`]);
  config.forEach(([key, value], at) => {
    env[`GIT_CONFIG_KEY_${at}`] = key;
    env[`GIT_CONFIG_VALUE_${at}`] = value;
  });
  return {
    ...env,
    GIT_CONFIG_COUNT: String(config.length),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_DIR: dir,
    ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    LC_ALL: "C",
  };
}

export interface GitOptions {
  /** The repo this call talks to. Without one, the call stays on this machine. */
  readonly access?: Access;
  readonly input?: Uint8Array;
  /** An index file of the call's own, so the call builds a tree with no work tree. */
  readonly index?: string;
  /** The author and committer date of a commit the call writes, when its hash must not depend on the clock (KTD17). */
  readonly date?: string;
  /** Gives the run back when Git fails, for a caller that reads why. */
  readonly mayFail?: boolean;
  /** A limit on standard output other than the usual one. */
  readonly limit?: OutputLimit;
}

/** A bare repo in a temporary folder. It lives for one command and is then deleted. */
export interface Scratch {
  /** The temporary folder, for files the command hands to Git. */
  readonly dir: string;
  /** Runs Git on the repo. A failure ends the command, and names `step`. */
  git(step: string, args: readonly string[], options?: GitOptions): Promise<GitRun>;
  /** Passes what Git wrote to standard error on to the operator, with no token in it. */
  report(run: GitRun): void;
}

/** Runs work with a scratch repo, and deletes the repo afterwards. */
export async function withScratch<T>(io: Io, work: (scratch: Scratch) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cairnfield-"));
  const repo = join(dir, "repo");
  const tokens = new Set<string>();
  const scratch: Scratch = {
    dir,
    report: (run) => {
      if (run.stderr !== "") io.warn(redact(run.stderr, [...tokens]));
    },
    git: async (step, args, options = {}) => {
      if (options.access) tokens.add(options.access.token);
      const limit = options.limit ?? { bytes: MAX_OUTPUT_BYTES, error: "git-output-too-large" };
      const run = await io.git(args, {
        env: environment(io, repo, options),
        ...(options.input === undefined ? {} : { input: options.input }),
        maxOutput: limit.bytes,
      });
      if (run.overflowed) return stop(EXIT.failed, limit.error);
      if (run.code !== 0 && options.mayFail !== true) {
        scratch.report(run);
        return stop(EXIT.git, "git-failed", { step });
      }
      return run;
    },
  };
  try {
    // No template, so the repo starts with no hook and no ignore list.
    await scratch.git("init", ["init", "--quiet", "--bare", "--template=", repo]);
    return await work(scratch);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What Git wrote to standard output, as one piece of text. */
export const said = (run: GitRun): string => new TextDecoder().decode(run.stdout).trim();

/** Lines for Git's standard input. */
export const inputLines = (all: readonly string[]): Uint8Array => new TextEncoder().encode(all.map((line) => `${line}\n`).join(""));

/** Stores bytes as blobs with no filter, so Git holds them as they are. Returns the hash of each. */
export async function writeBlobs(scratch: Scratch, contents: readonly Uint8Array[]): Promise<string[]> {
  if (contents.length === 0) return [];
  const dir = await mkdtemp(join(scratch.dir, "blobs-"));
  const files = contents.map((content, at) => ({ file: join(dir, String(at)), content }));
  await Promise.all(files.map(({ file, content }) => writeFile(file, content)));
  const hashed = await scratch.git("hash-object", ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
    input: inputLines(files.map(({ file }) => file)),
  });
  const blobs = said(hashed).split("\n");
  if (blobs.length !== contents.length) stop(EXIT.git, "git-failed", { step: "hash-object" });
  return blobs;
}

/**
 * Fetches the commit that a branch or a full commit hash names, at depth 1, with no tag
 * and no submodule (KTD33). Returns the hash of the commit that arrived.
 */
export async function fetchRef(scratch: Scratch, access: Access, ref: string): Promise<string> {
  await scratch.git(
    "fetch",
    ["fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", access.remote, ref],
    { access },
  );
  return said(await scratch.git("fetch", ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]));
}

/** Fetches one commit by its hash. The hash is the only thing asked for, and no other commit is accepted. */
export async function fetchCommit(scratch: Scratch, access: Access, commit: string): Promise<void> {
  if ((await fetchRef(scratch, access, commit)) !== commit) stop(EXIT.git, "git-failed", { step: "fetch" });
}

/** One entry of a commit's tree. The path is bytes, because a hostile repo may hold any. */
export interface TreeEntry {
  readonly mode: string;
  readonly hash: string;
  /** The size of a file in bytes. A submodule entry has none, and gives 0. */
  readonly size: number;
  readonly path: Uint8Array;
}

const TAB = 9;
const NUL = 0;

/**
 * Lists every entry under a commit's tree that is no folder, with the size of each file.
 * The listing itself is as large as the tree's author made it, so the caller sets its limit.
 */
export async function listTree(scratch: Scratch, commit: string, limit: OutputLimit): Promise<TreeEntry[]> {
  const { stdout } = await scratch.git("ls-tree", ["ls-tree", "-r", "-l", "-z", "--full-tree", commit], { limit });
  const entries: TreeEntry[] = [];
  let start = 0;
  for (let end = stdout.indexOf(NUL, start); end >= 0; end = stdout.indexOf(NUL, start)) {
    const tab = stdout.indexOf(TAB, start);
    // `<mode> <type> <hash> <size>`, then a tab, then the path. The size is padded with spaces, and is `-` for a submodule entry.
    const [mode = "", , hash = "", size = ""] = new TextDecoder().decode(stdout.subarray(start, tab)).split(/ +/);
    const bytes = size === "-" ? 0 : Number(size);
    if (tab < 0 || tab > end || !isGitHash(hash) || !Number.isSafeInteger(bytes) || size === "") {
      stop(EXIT.git, "git-failed", { step: "ls-tree" });
    }
    entries.push({ mode, hash, size: bytes, path: stdout.subarray(tab + 1, end) });
    start = end + 1;
  }
  return entries;
}

const LINE_FEED = 10;

/** Each blob that `cat-file --batch` gives comes with a line of its hash, type and size. */
const BATCH_HEADER_BYTES = 128;

/**
 * Reads blobs by hash, as their stored bytes. The caller knows their sizes before it
 * asks, and gives the sum as `bytes`, so Git is never asked for more than was counted.
 */
export async function readBlobs(scratch: Scratch, hashes: readonly string[], bytes: number): Promise<Map<string, Uint8Array>> {
  const blobs = new Map<string, Uint8Array>();
  if (hashes.length === 0) return blobs;
  const input = new TextEncoder().encode(hashes.map((hash) => `${hash}\n`).join(""));
  const limit = { bytes: bytes + hashes.length * BATCH_HEADER_BYTES, error: "git-output-too-large" };
  const { stdout } = await scratch.git("cat-file", ["cat-file", "--batch"], { input, limit });
  let at = 0;
  for (const hash of hashes) {
    // `<hash> blob <size>`, a line feed, the bytes, a line feed.
    const line = stdout.indexOf(LINE_FEED, at);
    const [named = "", type = "", size = ""] = new TextDecoder().decode(stdout.subarray(at, Math.max(line, at))).split(" ");
    const length = Number(size);
    const from = line + 1;
    if (line < 0 || named !== hash || type !== "blob" || !Number.isSafeInteger(length) || from + length > stdout.length) {
      stop(EXIT.git, "git-failed", { step: "cat-file" });
    }
    blobs.set(hash, stdout.subarray(from, from + length));
    at = from + length + 1;
  }
  return blobs;
}
