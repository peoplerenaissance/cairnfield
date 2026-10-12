// The request and response shapes of the node contract and the index routes (KTD28), so
// each side can be built against the other's contract. The route paths are choices of
// this library; the plan names only `/.well-known/api-catalog`.
//
// `node/` cannot import this library (KTD28), so it carries its own copy of the node
// shapes, and the U4 contract check catches drift (Appendix H).

import {
  CRITERIA,
  DELETED_MODE,
  ENTRY_MODES,
  OBSERVATIONS,
  PATCH_KINDS,
  RECORD_TYPES,
  REJECTION_REASONS,
} from "./enums.ts";
import {
  boolean,
  embedded,
  gitHash,
  hostname,
  int,
  listOf,
  name,
  nodeUrl,
  oneOf,
  optional,
  path,
  recordFile,
  sha256,
  shape,
  text,
  token,
  url,
  version,
} from "./fields.ts";
import type { ContractFields, Infer, ObjectKind, ShapeKind } from "./fields.ts";
import {
  MAX_FETCH_COUNT,
  MAX_LINE,
  MAX_LISTING_ENTRIES,
  MAX_PATCH_LINES,
  MAX_PATCH_REPLACEMENTS,
} from "./limits.ts";
import { CLAIM, COUNTER_FINDING, FINDING, PATCH, PATCH_RECHECK, RECHECK, RECIPE } from "./schemas.ts";

// Keys travel in headers (KTD10, KTD30). Each key has its own header.
export const ADMIN_KEY_HEADER = "x-cairnfield-admin-key";
export const REGISTRATION_KEY_HEADER = "x-cairnfield-registration-key";
export const RESET_KEY_HEADER = "x-cairnfield-reset-key";

/** One HTTP route. */
export interface Route {
  readonly method: "GET" | "POST";
  /** A node path is relative to the node's base URL, because a simulated node lives under a path (KTD24). */
  readonly path: string;
  /** The parameters in the path, by name. */
  readonly params?: ContractFields;
  readonly query?: ContractFields;
  /** The header that carries the key this route needs. */
  readonly key?: string;
  readonly request?: ShapeKind;
  /** The shape of a JSON body, or only a media type for a body that is not JSON data of this library. */
  readonly response: ShapeKind | { readonly media: string };
  /** The media type of a JSON body when it is not `application/json`. */
  readonly media?: string;
}

// A count or a time has no bound of its own.
const count = () => int(0, Number.MAX_SAFE_INTEGER);

// First values for the list sizes of a response. The plan sets none.
const MAX_VIEW_ENTRIES = 50_000;
const MAX_CITED_LINE_LENGTH = 65_536;
/** A view is narrowed to at most this many teams. A first value. */
export const MAX_VIEW_TEAMS = 100;

/**
 * The branch of a team repo that holds its records. The node reads its head from this
 * branch and the command pushes to it, because neither relies on a default branch (KTD36).
 */
export const TEAM_BRANCH = "main";

// Node contract (KTD7): public routes. The node validates nothing.

/** The node's head commit with a listing of its record files (R7). */
export const NODE_LISTING = shape({
  head: gitHash(),
  records: listOf(shape({ path: recordFile(), blob: gitHash() }), MAX_LISTING_ENTRIES),
});
export type NodeListing = Infer<typeof NODE_LISTING>;

/**
 * A patch commit's parent and changed paths, with the mode and blob of each. A deleted
 * path carries the deletion marker. The index trusts the node for the parent and for the
 * completeness of this list, so assembly checks again (KTD7, KTD23).
 */
export const NODE_PATCH = shape({
  commit: gitHash(),
  parent: gitHash(),
  changes: listOf(
    shape({ path: path(), mode: oneOf([...ENTRY_MODES, DELETED_MODE]), blob: gitHash() }),
    MAX_LISTING_ENTRIES,
  ),
});
export type NodePatch = Infer<typeof NODE_PATCH>;

/** A repo token with its Git remote and its expiry in Unix seconds. The public route gives a read token for a fork only. */
export const REPO_TOKEN = shape({ remote: url(), token: token(), expires: count() });
export type RepoToken = Infer<typeof REPO_TOKEN>;

/**
 * How often the fork of a component was fetched over Git, as its node counted it (R45).
 * The node states the number and nothing checks it. A fork with no counted fetch has no
 * count, and its node answers `not-found`, so a count is never zero.
 */
export const NODE_FETCHES = shape({ component: gitHash(), fetches: int(1, MAX_FETCH_COUNT) });
export type NodeFetches = Infer<typeof NODE_FETCHES>;

export const NODE_ERRORS = ["bad-request", "unauthorized", "not-found", "not-ready", "refused"] as const;
export const NODE_REFUSAL = shape({ error: oneOf(NODE_ERRORS) });

// Node contract (KTD10): admin routes. Each needs the admin key.

export const REPO_ROLES = ["team", "copy", "fork"] as const;
export const TOKEN_SCOPES = ["read", "write"] as const;

/** Imports a component copy by Git URL and branch, and pins a commit (KTD12). */
export const ADMIN_IMPORT_REQUEST = shape({ url: url(), branch: name("branch"), commit: gitHash() });
export const ADMIN_FORK_REQUEST = shape({ component: gitHash() });
/** A copy and a fork belong to a component. No write token is issued for a copy (R8). */
export const ADMIN_TOKEN_REQUEST = shape(
  { repo: oneOf(REPO_ROLES), component: optional(gitHash()), scope: oneOf(TOKEN_SCOPES) },
  [
    { rule: "present-when", field: "component", on: "repo", in: ["copy", "fork"] },
    { rule: "one-of-when", field: "scope", values: ["read"], on: "repo", in: ["copy"] },
  ],
);
/** A repo and whether it is ready. An import or a fork takes time (KTD36). */
export const ADMIN_REPO = shape({ repo: name("repo"), ready: boolean() });

export const NODE_ROUTES = {
  listing: { method: "GET", path: "records", response: NODE_LISTING },
  file: {
    method: "GET",
    path: "file",
    query: { commit: gitHash(), path: recordFile() },
    response: { media: "application/json" },
  },
  patch: { method: "GET", path: "patch", query: { component: gitHash(), commit: gitHash() }, response: NODE_PATCH },
  blob: {
    method: "GET",
    path: "blob",
    query: { component: gitHash(), blob: gitHash() },
    response: { media: "application/octet-stream" },
  },
  readToken: { method: "GET", path: "read-token", query: { component: gitHash() }, response: REPO_TOKEN },
  fetches: { method: "GET", path: "fetches", query: { component: gitHash() }, response: NODE_FETCHES },
  importCopy: {
    method: "POST",
    path: "admin/import",
    key: ADMIN_KEY_HEADER,
    request: ADMIN_IMPORT_REQUEST,
    response: ADMIN_REPO,
  },
  createTeamRepo: { method: "POST", path: "admin/team-repo", key: ADMIN_KEY_HEADER, response: ADMIN_REPO },
  createFork: {
    method: "POST",
    path: "admin/fork",
    key: ADMIN_KEY_HEADER,
    request: ADMIN_FORK_REQUEST,
    response: ADMIN_REPO,
  },
  repoToken: {
    method: "POST",
    path: "admin/token",
    key: ADMIN_KEY_HEADER,
    request: ADMIN_TOKEN_REQUEST,
    response: REPO_TOKEN,
  },
} as const satisfies { readonly [id: string]: Route };

// Index routes. Every JSON response carries the schema version (KTD35), and none
// carries text addressed to a reader (R34). The one route that serves component text
// is the cited-lines route, for display to a person only (R31).

export const COMPONENT_STATES = ["importing", "ready", "failed"] as const;
export const CLAIM_STATES = ["live", "closed", "expired"] as const;
/** The Artifacts error codes of a failed import (KTD12). */
export const IMPORT_ERRORS = [
  "INVALID_URL",
  "REMOTE_AUTH_REQUIRED",
  "NOT_FOUND",
  "UPSTREAM_UNAVAILABLE",
  "MEMORY_LIMIT",
] as const;
export const INDEX_ERRORS = [
  "bad-request",
  "unauthorized",
  "not-found",
  "not-allowed",
  "limit-reached",
  "already-registered",
] as const;

/** Why the index refused a request. A code, never a sentence. */
export const INDEX_REFUSAL = shape({ version: version(), error: oneOf(INDEX_ERRORS) });
export type IndexRefusal = Infer<typeof INDEX_REFUSAL>;

export const ACCEPTED = shape({ version: version() });

/** A node is registered by its base URL, which is its identity (KTD8). */
export const REGISTER_NODE_REQUEST = shape({ url: nodeUrl() });
/** The node's identity, as it was sent. The index stores no other spelling (KTD8). */
export const NODE_REGISTERED = shape({ version: version(), node: nodeUrl() });

/** A component is registered with its Git URL, branch and commit (KTD12). */
export const REGISTER_COMPONENT_REQUEST = shape({ url: url(), branch: name("branch"), commit: gitHash() });
export const COMPONENT_STATUS = shape({
  version: version(),
  component: gitHash(),
  state: oneOf(COMPONENT_STATES),
  importError: optional(oneOf(IMPORT_ERRORS)),
});
/** Lookup by Git URL (R13): the registered commits of one repo. */
export const COMPONENT_LOOKUP = shape({
  version: version(),
  components: listOf(
    shape({ component: gitHash(), branch: name("branch"), state: oneOf(COMPONENT_STATES) }),
    MAX_VIEW_ENTRIES,
  ),
});
/** Every component an index holds, in the order they were first registered, each with its Git URL and branch (KTD12). */
export const COMPONENT_LIST = shape({
  version: version(),
  components: listOf(
    shape({ component: gitHash(), url: url(), branch: name("branch"), state: oneOf(COMPONENT_STATES) }),
    MAX_VIEW_ENTRIES,
  ),
});

/** A notice is an unauthenticated hint that names one node. The index always pulls from the registered URL (KTD11). */
export const NOTICE = shape({ node: nodeUrl() });

// A valid record in the view, with its node, repo, commit and path (U7). The node and
// the ID are the fields that the match rule reads.
function published<S extends ObjectKind>(record: S) {
  return {
    node: nodeUrl(),
    repo: name("repo"),
    commit: gitHash(),
    path: recordFile(),
    id: sha256(),
    record: embedded(record),
  };
}

const HUNK = shape({
  oldStart: int(1, MAX_LINE + 1),
  removed: int(0, MAX_PATCH_LINES),
  newStart: int(1, MAX_LINE + 1),
  added: int(0, MAX_PATCH_LINES),
});

/** Findings that match (R10), with their confirmations and the disputes beside them. */
const VIEW_FINDINGS = shape({
  blob: gitHash(),
  observation: oneOf(OBSERVATIONS),
  host: optional(hostname()),
  paths: listOf(path(), MAX_VIEW_ENTRIES),
  findings: listOf(shape(published(FINDING)), MAX_VIEW_ENTRIES),
  rechecks: listOf(shape(published(RECHECK)), MAX_VIEW_ENTRIES),
  counterFindings: listOf(shape(published(COUNTER_FINDING)), MAX_VIEW_ENTRIES),
  /** The organizations that saw the same thing, and whether there are two of them. */
  nodes: listOf(nodeUrl(), MAX_VIEW_ENTRIES),
  confirmed: boolean(),
  /** The organizations that say the content breaks each criterion, counted apart (R10). */
  criteria: listOf(
    shape({ criterion: oneOf(CRITERIA), nodes: listOf(nodeUrl(), MAX_VIEW_ENTRIES), confirmed: boolean() }),
    CRITERIA.length,
  ),
});

/** One patch identity (R24): identical patches collapse into one entry that lists its organizations (R16). */
const VIEW_PATCH = shape({
  patchId: sha256(),
  kind: oneOf(PATCH_KINDS),
  size: int(0, MAX_PATCH_LINES),
  changes: listOf(
    shape({ blob: gitHash(), hunks: listOf(HUNK, MAX_PATCH_LINES) }),
    MAX_PATCH_REPLACEMENTS,
  ),
  paths: listOf(path(), MAX_VIEW_ENTRIES),
  records: listOf(shape(published(PATCH)), MAX_VIEW_ENTRIES),
  rechecks: listOf(shape(published(PATCH_RECHECK)), MAX_VIEW_ENTRIES),
  nodes: listOf(nodeUrl(), MAX_VIEW_ENTRIES),
  confirmed: boolean(),
});

/**
 * The view of one component commit: everything the page shows except component text (R13).
 * `gitUrl` is the Git URL the component was registered with (KTD12). `lag` is the index
 * lag in milliseconds (Appendix H). `organizations` counts registered nodes (KTD8).
 * Rejected work is four values only (KTD31).
 */
export const VIEW = shape({
  version: version(),
  component: gitHash(),
  gitUrl: url(),
  state: oneOf(COMPONENT_STATES),
  viewVersion: count(),
  lag: count(),
  organizations: count(),
  nodes: listOf(
    shape({ node: nodeUrl(), processed: optional(gitHash()), simulated: boolean(), historyRewritten: boolean() }),
    MAX_VIEW_ENTRIES,
  ),
  claims: listOf(shape({ ...published(CLAIM), state: oneOf(CLAIM_STATES) }), MAX_VIEW_ENTRIES),
  findings: listOf(VIEW_FINDINGS, MAX_VIEW_ENTRIES),
  /** Destination findings by host, one row per host (R33). */
  hosts: listOf(shape({ host: hostname(), count: count() }), MAX_VIEW_ENTRIES),
  /** Patches whose changed lines overlap or adjoin sit in one group (R16). */
  patches: listOf(shape({ patches: listOf(VIEW_PATCH, MAX_VIEW_ENTRIES) }), MAX_VIEW_ENTRIES),
  /** Each distinct file tree and the organizations that published it. The tree hash is published, not checked (KTD5). */
  recipes: listOf(
    shape({
      tree: gitHash(),
      records: listOf(shape(published(RECIPE)), MAX_VIEW_ENTRIES),
      nodes: listOf(nodeUrl(), MAX_VIEW_ENTRIES),
    }),
    MAX_VIEW_ENTRIES,
  ),
  pending: listOf(shape({ node: nodeUrl(), hash: sha256(), type: oneOf(RECORD_TYPES) }), MAX_VIEW_ENTRIES),
  rejected: listOf(
    shape({ node: nodeUrl(), hash: sha256(), type: oneOf(RECORD_TYPES), reason: oneOf(REJECTION_REASONS) }),
    MAX_VIEW_ENTRIES,
  ),
});
export type View = Infer<typeof VIEW>;

/**
 * The projection for the early rejection check (R13): each criterion that a group of
 * matching findings is confirmed against (R10), with the group's host and the count of
 * organizations behind that criterion. No file and no line.
 */
export const PROJECTION = shape({
  version: version(),
  component: gitHash(),
  state: oneOf(COMPONENT_STATES),
  viewVersion: count(),
  confirmed: listOf(
    shape({ criterion: oneOf(CRITERIA), host: optional(hostname()), organizations: count() }),
    MAX_VIEW_ENTRIES,
  ),
});
export type Projection = Infer<typeof PROJECTION>;

/**
 * The cited lines of one valid finding, read from the index's own copy (R31, KTD14).
 * This is the only response that holds component text. It is for display to a person,
 * and the command never gives it to an agent.
 */
export const CITED_LINES = shape({
  version: version(),
  finding: sha256(),
  path: path(),
  start: int(1, MAX_LINE),
  end: int(1, MAX_LINE),
  lines: listOf(text(MAX_CITED_LINE_LENGTH), MAX_LINE),
});
export type CitedLines = Infer<typeof CITED_LINES>;

export const LINK_TYPES = ["application/openapi+json", "application/schema+json"] as const;
const LINK = shape({ href: url(), type: oneOf(LINK_TYPES) });
const MAX_LINKS = 32;

/**
 * The API catalog (R34): a link set that points to the OpenAPI description and to the
 * record schemas. The link-set format allows no other member beside `linkset`, so this
 * one body carries no schema version.
 */
export const API_CATALOG = shape({
  linkset: listOf(
    shape({ anchor: url(), "service-desc": listOf(LINK, MAX_LINKS), describedby: listOf(LINK, MAX_LINKS) }),
    MAX_LINKS,
  ),
});
export type ApiCatalog = Infer<typeof API_CATALOG>;

export const INDEX_ROUTES = {
  catalog: {
    method: "GET",
    path: "/.well-known/api-catalog",
    response: API_CATALOG,
    media: "application/linkset+json",
  },
  description: { method: "GET", path: "/openapi.json", response: { media: "application/openapi+json" } },
  schema: {
    method: "GET",
    path: "/schemas/{type}.json",
    params: { type: oneOf(RECORD_TYPES) },
    response: { media: "application/schema+json" },
  },
  registerNode: {
    method: "POST",
    path: "/nodes",
    key: REGISTRATION_KEY_HEADER,
    request: REGISTER_NODE_REQUEST,
    response: NODE_REGISTERED,
  },
  registerComponent: {
    method: "POST",
    path: "/components",
    key: REGISTRATION_KEY_HEADER,
    request: REGISTER_COMPONENT_REQUEST,
    response: COMPONENT_STATUS,
  },
  lookup: { method: "GET", path: "/components", query: { url: url() }, response: COMPONENT_LOOKUP },
  // The list takes no query. `lookup` holds the `GET` of `/components`, so the list has a path of its own.
  list: { method: "GET", path: "/view", response: COMPONENT_LIST },
  notice: { method: "POST", path: "/notices", request: NOTICE, response: ACCEPTED },
  // `teams` narrows the view to the nodes it lists (KTD38). It is given once for each node.
  view: {
    method: "GET",
    path: "/components/{component}/view",
    params: { component: gitHash() },
    query: { teams: optional(listOf(nodeUrl(), MAX_VIEW_TEAMS)) },
    response: VIEW,
  },
  criteria: {
    method: "GET",
    path: "/components/{component}/criteria",
    params: { component: gitHash() },
    response: PROJECTION,
  },
  lines: {
    method: "GET",
    path: "/components/{component}/findings/{finding}/lines",
    params: { component: gitHash(), finding: sha256() },
    response: CITED_LINES,
  },
  reset: { method: "POST", path: "/reset", key: RESET_KEY_HEADER, response: ACCEPTED },
} as const satisfies { readonly [id: string]: Route };
