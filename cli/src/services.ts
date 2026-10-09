// The two services the command calls over HTTP: the team's own node and, when the
// config names one, an index. Each call goes to a route of the protocol's contract, and
// each answer is held to that route's shape before the command reads it.
//
// Every call runs under a deadline, follows no redirect and stops reading at a size
// limit (KTD33). An answer is data. A refusal is a code from the service's closed list.

import { ADMIN_REPO, INDEX_REFUSAL, MAX_RECORD_BYTES, NODE_REFUSAL, NODE_ROUTES, conforms } from "@cairnfield/protocol";
import type { Infer, Route, ShapeKind } from "@cairnfield/protocol";
import { ADMIN_KEY, keyFrom } from "./config.ts";
import type { Home } from "./config.ts";
import { isArtifactsRemote } from "./git.ts";
import type { Access } from "./git.ts";
import type { Io } from "./io.ts";
import { EXIT, stop } from "./outcome.ts";
import type { ExitCode } from "./outcome.ts";

const DEADLINE_MS = 30_000;
/** No answer is read past this size. The view of a large component is the largest answer. */
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;

export type Answer<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly error: "unreachable" | "bad-answer" }
  /** The service refused, with a code from its closed list. */
  | { readonly ok: false; readonly error: "refused"; readonly reason: string };

/** A route that answers with JSON in a shape of the protocol. */
type JsonRoute = Route & { readonly response: ShapeKind };

/** What one call sends. */
export interface Sent {
  readonly params?: { readonly [name: string]: string };
  /** The key the route needs. It travels in the route's own header. */
  readonly key?: string;
  readonly body?: object;
}

async function readUpTo(response: Response, max: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.length;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks);
}

async function call<R extends JsonRoute>(
  io: Io,
  base: string,
  route: R,
  refusal: ShapeKind,
  sent: Sent,
): Promise<Answer<Infer<R["response"]>>> {
  // An index path starts at the index address. A node path is joined to the node's base URL.
  const path = route.path.replace(/\{([a-z]+)\}/g, (_, name: string) => encodeURIComponent(sent.params?.[name] ?? ""));
  const headers = new Headers();
  if (sent.body !== undefined) headers.set("content-type", "application/json");
  if (route.key !== undefined && sent.key !== undefined) headers.set(route.key, sent.key);
  let status: number;
  let bytes: Uint8Array | undefined;
  try {
    const response = await io.fetch(`${base}${path.startsWith("/") ? "" : "/"}${path}`, {
      method: route.method,
      headers,
      ...(sent.body === undefined ? {} : { body: JSON.stringify(sent.body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    status = response.status;
    bytes = await readUpTo(response, MAX_ANSWER_BYTES);
  } catch {
    return { ok: false, error: "unreachable" };
  }
  let body: unknown;
  try {
    body = bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    body = undefined;
  }
  if (status === 200) {
    return conforms(route.response, body) ? { ok: false, error: "bad-answer" } : { ok: true, body: body as Infer<R["response"]> };
  }
  if (conforms(refusal, body)) return { ok: false, error: "bad-answer" };
  return { ok: false, error: "refused", reason: (body as { readonly error: string }).error };
}

export function callNode<R extends JsonRoute>(io: Io, home: Home, route: R, sent: Sent = {}) {
  return call(io, home.config.node, route, NODE_REFUSAL, sent);
}

export function callIndex<R extends JsonRoute>(io: Io, index: string, route: R, sent: Sent = {}) {
  return call(io, index, route, INDEX_REFUSAL, sent);
}

type Failed = Exclude<Answer<never>, { readonly ok: true }>;

function failed(code: ExitCode, service: string, answer: Failed): never {
  return answer.error === "refused"
    ? stop(code, `${service}-refused`, { reason: answer.reason })
    : stop(code, `${service}-${answer.error}`);
}

/** Ends the command for a call to the node that did not succeed. */
export const nodeFailed = (answer: Failed): never => failed(EXIT.node, "node", answer);
/** Ends the command for a call to the index that did not succeed. */
export const indexFailed = (answer: Failed): never => failed(EXIT.index, "index", answer);

/**
 * Reads one record file of the team repo as the node serves it at a commit. The node
 * validates nothing (KTD7), so the caller checks the bytes. Returns nothing for a file
 * the node does not serve, or one too large to be a record.
 */
export async function readRecordFile(io: Io, home: Home, commit: string, path: string): Promise<Uint8Array | undefined> {
  const query = new URLSearchParams({ commit, path });
  let response: Response;
  try {
    response = await io.fetch(`${home.config.node}/${NODE_ROUTES.file.path}?${query}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    return response.status === 200 ? await readUpTo(response, MAX_RECORD_BYTES) : undefined;
  } catch {
    return nodeFailed({ ok: false, error: "unreachable" });
  }
}

/** The node's admin key, from the environment. */
export const adminKey = (io: Io): string => keyFrom(io, ADMIN_KEY);

type AdminRepo = Infer<typeof ADMIN_REPO>;

const READY_DEADLINE_MS = 5 * 60_000;
const POLL_MS = 2_000;

/**
 * Asks the node for a repo until it is ready. A create, an import or a fork takes time,
 * and each of those routes may be called again and again (KTD36).
 */
export async function untilReady(io: Io, ask: () => Promise<Answer<AdminRepo>>): Promise<Answer<AdminRepo>> {
  const deadline = io.now() + READY_DEADLINE_MS;
  for (;;) {
    const answer = await ask();
    const waiting = answer.ok ? !answer.body.ready : answer.error === "refused" && answer.reason === "not-ready";
    if (!waiting) return answer;
    if (io.now() >= deadline) return stop(EXIT.node, "node-not-ready");
    await io.sleep(POLL_MS);
  }
}

/**
 * Gets a token for one of the node's repos. The remote comes from the node, so its form
 * is checked here, before any of it reaches Git (KTD33).
 */
export async function repoAccess(
  io: Io,
  home: Home,
  wanted: { readonly repo: "team" | "copy" | "fork"; readonly component?: string; readonly scope: "read" | "write" },
): Promise<Access> {
  const answer = await callNode(io, home, NODE_ROUTES.repoToken, { key: adminKey(io), body: wanted });
  if (!answer.ok) return nodeFailed(answer);
  if (!isArtifactsRemote(answer.body.remote)) return stop(EXIT.node, "node-bad-answer");
  return { remote: answer.body.remote, token: answer.body.token };
}
