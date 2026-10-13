// One node for a test: the Worker's own `fetch` handler, over the fake in place of the
// Artifacts binding. The paths and the header are written out here as the node contract
// states them, and are not taken from the node's own copy of the contract.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import type { FakeArtifacts } from "./fake-artifacts.ts";

export const BASE = "https://node.team-a.example";
/** The repo a component is imported from. */
export const UPSTREAM = "https://git.fellbeck-tools.example/demo-plugin.git";
/** Not a real key. */
export const ADMIN_KEY = "test-admin-key";

export interface TestNode {
  /** A `GET` of a public path, with the headers a browser sends when a test gives some. */
  get(path: string, headers?: { readonly [name: string]: string }): Promise<Response>;
  /** A `POST` to a public path. No public route takes one. */
  post(path: string): Promise<Response>;
  /** An admin call. It carries the node's key unless another key, or none, is given. */
  admin(path: string, body?: unknown, key?: string | null): Promise<Response>;
}

/**
 * A node over the fake. Give `{}` as the settings for a node with no admin key set, and
 * a `NODE_URL` for a node that was deployed with another address than `BASE`. `served`
 * is the Worker that answers.
 */
export function nodeOver(
  artifacts: FakeArtifacts,
  settings: Partial<Pick<Env, "ADMIN_KEY" | "NODE_URL">> = { ADMIN_KEY },
  served: typeof worker = worker,
): TestNode {
  const bindings: Env = { ARTIFACTS: artifacts, READ_TOKENS: env.READ_TOKENS, NODE_URL: BASE, ...settings };
  // One request with a context of its own, as the runtime gives each request. The call
  // ends when the work the request left running has ended too.
  const fetch = async (request: Request): Promise<Response> => {
    const context = createExecutionContext();
    try {
      return await served.fetch(request, bindings, context);
    } finally {
      await waitOnExecutionContext(context);
    }
  };
  return {
    get: (path, headers = {}) => fetch(new Request(`${BASE}/${path}`, { headers })),
    post: (path) => fetch(new Request(`${BASE}/${path}`, { method: "POST" })),
    admin: (path, body, key = ADMIN_KEY) => {
      const headers = new Headers({ "content-type": "application/json" });
      if (key !== null) headers.set("x-cairnfield-admin-key", key);
      const init = { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      return fetch(new Request(`${BASE}/admin/${path}`, init));
    },
  };
}

/**
 * A node in an isolate of its own, as far as a test can make one: the Worker's modules
 * are loaded afresh for it, so it holds nothing that another node of the test kept.
 */
export async function freshNode(
  artifacts: FakeArtifacts,
  settings: Partial<Pick<Env, "ADMIN_KEY" | "NODE_URL">> = { ADMIN_KEY },
): Promise<TestNode> {
  vi.resetModules();
  const fresh = await import("../src/index.ts");
  return nodeOver(artifacts, settings, fresh.default);
}

/** The status and the JSON body of a response. */
export async function answer(response: Response | Promise<Response>): Promise<{ status: number; body: unknown }> {
  const settled = await response;
  return { status: settled.status, body: await settled.json() };
}

/** The repo an admin call names in its answer. */
export async function repoOf(response: Promise<Response>): Promise<string> {
  const { status, body } = await answer(response);
  expect(status).toBe(200);
  return (body as { repo: string }).repo;
}

/** Imports a copy and waits until it is ready, as the command does. */
export async function importCopy(
  node: TestNode,
  artifacts: FakeArtifacts,
  branch: string,
  commit: string,
): Promise<string> {
  const copy = await repoOf(node.admin("import", { url: UPSTREAM, branch, commit }));
  artifacts.finish();
  expect(await answer(node.admin("import", { url: UPSTREAM, branch, commit }))).toEqual({
    status: 200,
    body: { repo: copy, ready: true },
  });
  return copy;
}

/** Forks a copy and waits until the fork is ready, as the command does. */
export async function forkCopy(node: TestNode, artifacts: FakeArtifacts, component: string): Promise<string> {
  const fork = await repoOf(node.admin("fork", { component }));
  artifacts.finish();
  expect(await answer(node.admin("fork", { component }))).toEqual({ status: 200, body: { repo: fork, ready: true } });
  return fork;
}
