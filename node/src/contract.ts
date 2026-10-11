// The node's own copy of the node contract (KTD7, KTD10). `node/` imports nothing from
// the workspace (KTD28), so the paths, names, shapes and error codes of
// `protocol/src/contracts.ts` are written out again here. The contract check script in
// `scripts/` holds a deployed node to the protocol's own shapes, which is what catches a
// difference between the two copies (Appendix H).

/** The header that carries the admin key (KTD10). */
export const ADMIN_KEY_HEADER = "x-cairnfield-admin-key";

/** The route paths, relative to the node's base URL. */
export const PATHS = {
  listing: "records",
  file: "file",
  patch: "patch",
  blob: "blob",
  readToken: "read-token",
  importCopy: "admin/import",
  createTeamRepo: "admin/team-repo",
  createFork: "admin/fork",
  repoToken: "admin/token",
} as const;

const NODE_ERRORS = ["bad-request", "unauthorized", "not-found", "not-ready", "refused"] as const;
export type NodeError = (typeof NODE_ERRORS)[number];

// The contract names the codes and no status, so the statuses are a choice made here.
const STATUS: { readonly [E in NodeError]: number } = {
  "bad-request": 400,
  unauthorized: 401,
  refused: 403,
  "not-found": 404,
  "not-ready": 409,
};

/** Why the node refused a request. A code, never a sentence. */
export function refusal(error: NodeError): Response {
  return Response.json({ error }, { status: STATUS[error] });
}

// The patterns and limits of the protocol library (KTD6), for the values a request
// carries. A value from outside is hostile until it has passed one of these (KTD33).

const GIT_HASH = /^[0-9a-f]{40}$/;
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_BRANCH_NAME_LENGTH = 200;
const HTTPS_URL = /^https:\/\/(?![^/?#]*@)[^\s\\]+$/;
const MAX_URL_LENGTH = 2048;

/** A commit, a tree or a blob: 40 lower-case hexadecimal characters. */
export function isGitHash(value: unknown): value is string {
  return typeof value === "string" && GIT_HASH.test(value);
}

function isBranchName(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_BRANCH_NAME_LENGTH && BRANCH_NAME.test(value);
}

/** An HTTPS URL with no credentials, in serialized form. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || !HTTPS_URL.test(value)) return false;
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return false;
  return parsed.href === value || parsed.href === `${value}/`;
}

type Members = { readonly [name: string]: unknown };

/** A JSON object that holds no name outside `names`, or nothing for any other value. */
function objectOf(value: unknown, names: readonly string[]): Members | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.keys(value).every((name) => names.includes(name)) ? (value as Members) : undefined;
}

/**
 * The query of a request when it holds exactly these names, each once. The contract
 * gives no route an optional name, so any other query is refused.
 */
function queryOf<const N extends string>(url: URL, names: readonly N[]): { readonly [K in N]: string } | undefined {
  const query: { [name: string]: string } = {};
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value === null) return undefined;
    query[name] = value;
  }
  return url.searchParams.size === names.length ? (query as { readonly [K in N]: string }) : undefined;
}

// The public queries (KTD7). Each reader gives nothing for a query the contract does not allow.

const RECORD_TYPES = ["claim", "finding", "re-check", "counter-finding", "patch", "patch-re-check", "recipe"];
/** The path of a record file in the team repo (KTD1). */
const RECORD_PATH = new RegExp(`^records/[0-9a-f]{40}/(?:${RECORD_TYPES.join("|")})/[0-9a-f]{64}\\.json$`);
/** The folder of the team repo that holds the records. */
export const RECORDS_FOLDER = "records";

export function listingQuery(url: URL): object | undefined {
  return queryOf(url, []);
}

export function fileQuery(url: URL): { readonly commit: string; readonly path: string } | undefined {
  const query = queryOf(url, ["commit", "path"]);
  return query && isGitHash(query.commit) && RECORD_PATH.test(query.path) ? query : undefined;
}

export function patchQuery(url: URL): { readonly component: string; readonly commit: string } | undefined {
  const query = queryOf(url, ["component", "commit"]);
  return query && isGitHash(query.component) && isGitHash(query.commit) ? query : undefined;
}

export function blobQuery(url: URL): { readonly component: string; readonly blob: string } | undefined {
  const query = queryOf(url, ["component", "blob"]);
  return query && isGitHash(query.component) && isGitHash(query.blob) ? query : undefined;
}

export function readTokenQuery(url: URL): { readonly component: string } | undefined {
  const query = queryOf(url, ["component"]);
  return query && isGitHash(query.component) ? query : undefined;
}

// The admin requests (KTD10). Each reader gives nothing for a body the contract does not allow.

/** Imports a component copy by Git URL and branch, and pins a commit. */
export interface ImportRequest {
  readonly url: string;
  readonly branch: string;
  readonly commit: string;
}

export function importRequest(body: unknown): ImportRequest | undefined {
  const { url, branch, commit } = objectOf(body, ["url", "branch", "commit"]) ?? {};
  return isHttpsUrl(url) && isBranchName(branch) && isGitHash(commit) ? { url, branch, commit } : undefined;
}

export interface ForkRequest {
  readonly component: string;
}

export function forkRequest(body: unknown): ForkRequest | undefined {
  const { component } = objectOf(body, ["component"]) ?? {};
  return isGitHash(component) ? { component } : undefined;
}

export type TokenScope = "read" | "write";

/** A copy and a fork belong to a component, and the team repo to none. */
export type TokenRequest =
  | { readonly repo: "team"; readonly scope: TokenScope }
  | { readonly repo: "copy" | "fork"; readonly component: string; readonly scope: TokenScope };

/**
 * Reads a token request. The contract allows no write scope for a copy. That request is
 * read here all the same, so that the route can answer it with a refusal of its own (R8).
 */
export function tokenRequest(body: unknown): TokenRequest | undefined {
  const fields = objectOf(body, ["repo", "component", "scope"]);
  if (!fields) return undefined;
  const { repo, component, scope } = fields;
  if (scope !== "read" && scope !== "write") return undefined;
  if (repo === "team") return "component" in fields ? undefined : { repo, scope };
  return (repo === "copy" || repo === "fork") && isGitHash(component) ? { repo, component, scope } : undefined;
}

// The responses.

/** The node's head commit with a listing of its record files (R7). */
export interface NodeListing {
  readonly head: string;
  readonly records: readonly { readonly path: string; readonly blob: string }[];
}

/** The fixed marker for a deletion (KTD4): the mode and the hash that Git itself writes for a missing file. */
export const DELETED_MODE = "000000";
export const DELETED_BLOB = "0000000000000000000000000000000000000000";

/** A file with its Git mode and the hash of its content. As a change of a patch commit, a deleted path carries the deletion marker. */
export interface FileEntry {
  readonly path: string;
  readonly mode: string;
  readonly blob: string;
}

/** A patch commit's parent and changed paths. The index trusts the node for both, so assembly checks again (KTD7, KTD23). */
export interface NodePatch {
  readonly commit: string;
  readonly parent: string;
  readonly changes: readonly FileEntry[];
}

/** A repo and whether it is ready. An import or a fork takes time (KTD36). */
export interface AdminRepo {
  readonly repo: string;
  readonly ready: boolean;
}

/** A repo token with its Git remote and its expiry in Unix seconds. */
export interface RepoToken {
  readonly remote: string;
  readonly token: string;
  readonly expires: number;
}

/**
 * The branch of the team repo that records are pushed to. It is set when the repo is
 * created, and the command pushes to the same one (KTD36).
 */
export const TEAM_BRANCH = "main";

// The one index route the node calls: the notice (KTD11). The path joins the index address.

export const NOTICE_PATH = "/notices";

/**
 * The index address a node is deployed with. A route such as the notice path is joined
 * to it, so it is an HTTPS URL with no credentials, no query, no fragment and no slash
 * at its end.
 */
export function isIndexUrl(value: unknown): value is string {
  return isHttpsUrl(value) && !/[?#]/.test(value) && !value.endsWith("/");
}

const MAX_HOSTNAME_LENGTH = 253;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// A label that starts with `xn--` is Punycode, which a node hostname never holds.
const NODE_HOST_LABEL = `(?!xn--)${HOST_LABEL}`;
// A last label that a URL parser reads as a number, which makes the host an address.
const NUMBER_LABEL = "(?:[0-9]+|0x[0-9a-f]*)";
// 1 to 65535 with no zero in front, and never 443, which a URL parser drops.
const NODE_PORT =
  "(?!443(?:/|$))(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const NODE_PATH_PART = "[a-z0-9][a-z0-9._-]*";
const NODE_URL = new RegExp(
  `^https://(?=[a-z0-9.-]{1,${MAX_HOSTNAME_LENGTH}}(?:[:/]|$))(?:${NODE_HOST_LABEL}\\.)*(?!${NUMBER_LABEL}(?:[:/]|$))${NODE_HOST_LABEL}(?::${NODE_PORT})?(?:/${NODE_PATH_PART})*$`,
);

/**
 * A node's base URL in its one accepted spelling (KTD8): lower-case `https://`, a
 * hostname that is a name and never an address, a port only when it is not 443, a path
 * for a node that lives under one, and no slash at the end. The index refuses a notice
 * that names a node in any other spelling.
 */
export function isNodeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || !NODE_URL.test(value)) return false;
  if (!URL.canParse(value)) return false;
  const { href } = new URL(value);
  return href === value || href === `${value}/`;
}

/**
 * A base URL this Worker can have: the one accepted spelling (KTD8) with no path, because
 * the Worker answers at the root of its host.
 */
export function isNodeOrigin(value: unknown): value is string {
  return isNodeUrl(value) && new URL(value).pathname === "/";
}

/** A notice names one node by its base URL. */
export interface Notice {
  readonly node: string;
}
