// Checks a deployed node against the node contract of the protocol library (KTD7).
//
// `node/` imports nothing from the workspace (KTD28), so it carries its own copy of the
// contract. This script calls a node and holds each answer to the protocol's own routes
// and shapes, which is what catches a difference between the two copies (Appendix H).
//
// Run it from the repo root, against a node whose team repo holds at least one record
// and whose fork of the component holds the patch commit:
//
//   node scripts/check-node-contract.ts <node-url> <component-commit> <patch-commit>
//
// The three values may come from CAIRNFIELD_NODE_URL, CAIRNFIELD_COMPONENT and
// CAIRNFIELD_PATCH_COMMIT instead. With CAIRNFIELD_ADMIN_KEY set, the script also checks
// that the node refuses a write token for the component copy (R8). The key is read from
// the environment only. The script prints no key, no token and no Git remote, because a
// remote holds the account ID.
//
// It exits with 0 when every check passes, 1 when one fails and 2 when it cannot start.

import {
  ADMIN_KEY_HEADER,
  DELETED_BLOB,
  DELETED_MODE,
  NODE_REFUSAL,
  NODE_ROUTES,
  conforms,
  gitBlobHash,
  isCommit,
  isNodeUrl,
} from "@cairnfield/protocol";
import type { ContractKind, NodeFetches, NodeListing, NodePatch, RepoToken, Route } from "@cairnfield/protocol";

const TIMEOUT_MS = 20_000;
/** The script reads at most this many record files and blobs. */
const MAX_CONTENT_CHECKS = 20;

const args = process.argv.slice(2);
const given = {
  node: args[0] ?? process.env["CAIRNFIELD_NODE_URL"],
  component: args[1] ?? process.env["CAIRNFIELD_COMPONENT"],
  patchCommit: args[2] ?? process.env["CAIRNFIELD_PATCH_COMMIT"],
};
if (!isNodeUrl(given.node) || !isCommit(given.component) || !isCommit(given.patchCommit)) {
  console.error("usage: node scripts/check-node-contract.ts <node-url> <component-commit> <patch-commit>");
  console.error("The node URL is an HTTPS base URL with no slash at its end. A commit is 40 hexadecimal characters.");
  process.exit(2);
}
const node: string = given.node;
const component: string = given.component;
const patchCommit: string = given.patchCommit;
const adminKey = process.env["CAIRNFIELD_ADMIN_KEY"];

let failures = 0;

function pass(check: string): void {
  console.log(`ok    ${check}`);
}

function fail(check: string, why: string): void {
  failures += 1;
  console.log(`FAIL  ${check}: ${why}`);
}

interface Answer {
  readonly status: number;
  readonly media: string;
  readonly bytes: Uint8Array;
  /** The body as JSON, or nothing when it is not JSON. */
  readonly json: unknown;
}

/** Calls one route of the node. The path and the method come from the protocol's own table. */
async function call(
  route: Route,
  query: { readonly [name: string]: string } = {},
  options: { readonly body?: unknown; readonly key?: string } = {},
): Promise<Answer> {
  const url = new URL(`${node}/${route.path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.append(name, value);
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.key !== undefined && route.key !== undefined) headers.set(route.key, options.key);
  const response = await fetch(url, {
    method: route.method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    json = undefined;
  }
  const media = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  return { status: response.status, media, bytes, json };
}

/** Why a JSON answer does not fit a shape of the protocol, or nothing when it fits. */
function misfit(answer: Answer, shape: ContractKind): string | undefined {
  if (answer.status !== 200) return `status ${answer.status}`;
  if (answer.media !== "application/json") return `media type ${answer.media}`;
  const rejection = conforms(shape, answer.json);
  // A rejection names a reason and a declared field, never text from the body.
  return rejection ? `${rejection.reason} at ${rejection.field ?? "the body"}` : undefined;
}

/** Checks that the node refuses a call with the given code, in the shape of a refusal. */
function checkRefusal(check: string, answer: Answer, code: string): void {
  const rejection = conforms(NODE_REFUSAL, answer.json);
  if (answer.status < 400) return fail(check, `status ${answer.status}`);
  if (rejection) return fail(check, `the body is no refusal: ${rejection.reason}`);
  const { error } = answer.json as { error: string };
  if (error !== code) return fail(check, `the node answered ${error}, not ${code}`);
  pass(check);
}

/** Checks served bytes against the media type of their route and against their blob hash. */
async function checkContent(check: string, answer: Answer, route: Route, blob: string): Promise<void> {
  const media = "media" in route.response ? route.response.media : "application/json";
  if (answer.status !== 200) return fail(check, `status ${answer.status}`);
  if (answer.media !== media) return fail(check, `media type ${answer.media}, not ${media}`);
  if ((await gitBlobHash(answer.bytes)) !== blob) return fail(check, "the bytes do not have the listed blob hash");
  pass(check);
}

async function checkRecords(): Promise<void> {
  const answer = await call(NODE_ROUTES.listing);
  const why = misfit(answer, NODE_ROUTES.listing.response);
  if (why !== undefined) return fail("listing", why);
  const listing = answer.json as NodeListing;
  if (listing.records.length === 0) return fail("listing", "the team repo holds no record");
  pass(`listing (${listing.records.length} records)`);

  for (const record of listing.records.slice(0, MAX_CONTENT_CHECKS)) {
    const file = await call(NODE_ROUTES.file, { commit: listing.head, path: record.path });
    await checkContent(`file ${record.path}`, file, NODE_ROUTES.file, record.blob);
  }

  const [first] = listing.records;
  const missing = first?.path.replace(/[0-9a-f]{64}\.json$/, `${"0".repeat(64)}.json`) ?? "";
  checkRefusal(
    "file at a missing path",
    await call(NODE_ROUTES.file, { commit: listing.head, path: missing }),
    "not-found",
  );
  checkRefusal(
    "file at a branch name",
    await call(NODE_ROUTES.file, { commit: "main", path: first?.path ?? "" }),
    "bad-request",
  );
}

async function checkPatch(): Promise<void> {
  const answer = await call(NODE_ROUTES.patch, { component, commit: patchCommit });
  const why = misfit(answer, NODE_ROUTES.patch.response);
  if (why !== undefined) return fail("patch", why);
  const patch = answer.json as NodePatch;
  if (patch.commit !== patchCommit) return fail("patch", "the answer names another commit");
  // A patch commit sits on the pinned commit (KTD4).
  if (patch.parent !== component) return fail("patch", "the parent is not the component commit");
  if (patch.changes.length === 0) return fail("patch", "the commit changes no file");
  const marked = patch.changes.filter((change) => (change.mode === DELETED_MODE) !== (change.blob === DELETED_BLOB));
  if (marked.length > 0) return fail("patch", "a change carries half of the deletion marker");
  pass(`patch (${patch.changes.length} changed paths)`);

  const kept = patch.changes.filter((change) => change.mode !== DELETED_MODE);
  for (const change of kept.slice(0, MAX_CONTENT_CHECKS)) {
    const blob = await call(NODE_ROUTES.blob, { component, blob: change.blob });
    await checkContent(`blob of ${change.path}`, blob, NODE_ROUTES.blob, change.blob);
  }
  // No object has the hash of the deletion marker.
  checkRefusal("blob that is missing", await call(NODE_ROUTES.blob, { component, blob: DELETED_BLOB }), "not-found");
}

async function checkReadToken(): Promise<void> {
  const route = NODE_ROUTES.readToken;
  const first = await call(route, { component });
  const why = misfit(first, route.response);
  if (why !== undefined) return fail("read token", why);
  const token = first.json as RepoToken;
  if (token.expires <= Date.now() / 1000) return fail("read token", "the token has expired");
  pass("read token");

  // The node keeps one read token per fork (KTD7), so a second request gets the same one.
  const second = await call(route, { component });
  const again = misfit(second, route.response) === undefined ? (second.json as RepoToken) : undefined;
  if (again?.token === token.token && again.expires === token.expires) pass("read token is kept");
  else fail("read token is kept", "a second request got another answer");

  // The route gives a read token for a fork only, so it takes neither a repo nor a scope.
  const asked = [
    ["read token with write scope", { component, scope: "write" }],
    ["read token for the team repo", { repo: "team" }],
  ] as const;
  for (const [check, query] of asked) {
    const answer = await call(route, query);
    if (answer.status < 400 || conforms(NODE_REFUSAL, answer.json)) fail(check, "the node did not refuse");
    else pass(`${check} is refused`);
  }
}

async function checkFetches(): Promise<void> {
  const route = NODE_ROUTES.fetches;
  // A node from before the route answers `not-found` for every call to its path. A node
  // that has the route refuses these two as bad requests.
  checkRefusal("fetch count with no component", await call(route), "bad-request");
  checkRefusal("fetch count with a second name", await call(route, { component, repo: "team" }), "bad-request");

  const answer = await call(route, { component });
  // A fork with no counted fetch has no count, which is not a count of zero (R45).
  if (answer.status >= 400) return checkRefusal("fetch count, with no fetch counted", answer, "not-found");
  const why = misfit(answer, route.response);
  if (why !== undefined) return fail("fetch count", why);
  const counted = answer.json as NodeFetches;
  if (counted.component !== component) return fail("fetch count", "the answer names another component");
  // The number is the node's own statement, and this script cannot check it.
  pass(`fetch count (${counted.fetches})`);
}

async function checkAdmin(): Promise<void> {
  // Each admin route with a body its contract allows. None of these reaches Artifacts on
  // a node that checks the key first.
  const calls: readonly (readonly [route: Route, body?: unknown])[] = [
    [NODE_ROUTES.createTeamRepo],
    [NODE_ROUTES.importCopy, { url: "https://git.invalid.example/none.git", branch: "main", commit: component }],
    [NODE_ROUTES.createFork, { component }],
    [NODE_ROUTES.repoToken, { repo: "copy", component, scope: "read" }],
  ];
  for (const [route, body] of calls) {
    checkRefusal(`${route.path} with no key`, await call(route, {}, { body }), "unauthorized");
    // A key made here and now, which is no node's key.
    const stranger = crypto.randomUUID();
    checkRefusal(`${route.path} with another key`, await call(route, {}, { body, key: stranger }), "unauthorized");
  }

  if (adminKey === undefined || adminKey === "") {
    console.log("skip  write token for the component copy: CAIRNFIELD_ADMIN_KEY is not set");
    return;
  }
  if (NODE_ROUTES.repoToken.key !== ADMIN_KEY_HEADER) return fail("admin key header", "the route names another header");
  const refused = await call(
    NODE_ROUTES.repoToken,
    {},
    { body: { repo: "copy", component, scope: "write" }, key: adminKey },
  );
  // No route returns a write token for a component copy (R8).
  checkRefusal("write token for the component copy", refused, "refused");
}

for (const check of [checkRecords, checkPatch, checkReadToken, checkFetches, checkAdmin]) {
  try {
    await check();
  } catch (error) {
    // A network failure or a timeout. Its message names the cause and holds no secret.
    fail(check.name, error instanceof Error ? error.name : "the call failed");
  }
}

console.log(failures === 0 ? "The node matches the contract." : `${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
