import { describe, expect, it } from "vitest";
import {
  ADMIN_KEY_HEADER,
  ADMIN_TOKEN_REQUEST,
  API_CATALOG,
  CITED_LINES,
  COMPONENT_LIST,
  INDEX_REFUSAL,
  INDEX_ROUTES,
  NODE_FETCHES,
  NODE_LISTING,
  NODE_PATCH,
  NODE_ROUTES,
  NOTES_REF,
  NOTICE,
  PATCH_NOTE,
  PROJECTION,
  REGISTER_COMPONENT_REQUEST,
  REGISTER_NODE_REQUEST,
  REGISTRATION_KEY_HEADER,
  REPO_TOKEN,
  RESET_KEY_HEADER,
  VIEW,
} from "../src/contracts.ts";
import type { Projection, Route, View } from "../src/contracts.ts";
import { DELETED_BLOB, DELETED_MODE } from "../src/enums.ts";
import { gitHash, object, sha256, shape, text, url } from "../src/fields.ts";
import type { ContractKind } from "../src/fields.ts";
import { jsonSchemaOf } from "../src/json-schema.ts";
import { MAX_FETCH_COUNT, MAX_LISTING_ENTRIES } from "../src/limits.ts";
import { matchGroups } from "../src/match.ts";
import { RECORD_SHAPES } from "../src/schemas.ts";
import { conforms } from "../src/validate.ts";
import {
  COMPONENT,
  GOOD_NODE_URLS,
  GOOD_URLS,
  HOST,
  NODE_A,
  NODE_B,
  PATCH_COMMIT,
  NODE_URLS_OFF_PATTERN,
  URLS_NOT_SERIALIZED,
  URLS_OFF_PATTERN,
  finding,
  patch,
  recheck,
  reviewClaim,
  sha,
} from "./fixtures.ts";

const reasonOf = (kind: ContractKind, value: unknown): string => conforms(kind, value)?.reason ?? "ok";

/** Every kind in a shape, at any depth. A whole record counts as one kind and is not opened. */
function kindsIn(kind: ContractKind): ContractKind[] {
  if (kind.kind === "object") return [kind, ...Object.values(kind.fields).flatMap(kindsIn)];
  if (kind.kind === "list" || kind.kind === "set") return [kind, ...kindsIn(kind.items)];
  return [kind];
}

/** Every field name in a shape, at any depth. */
function fieldNamesIn(kind: ContractKind): string[] {
  if (kind.kind === "object") {
    return Object.entries(kind.fields).flatMap(([name, field]) => [name, ...fieldNamesIn(field)]);
  }
  if (kind.kind === "list" || kind.kind === "set") return fieldNamesIn(kind.items);
  return [];
}

const RECORD_KINDS = ["version", "enum", "sha256", "git-hash", "int", "path", "hostname", "set", "object"];

const routes = (table: { readonly [id: string]: Route }): Route[] => Object.values(table);
const jsonResponses = (table: { readonly [id: string]: Route }): ContractKind[] =>
  routes(table).flatMap((route) => ("media" in route.response ? [] : [route.response]));

describe("record kinds and contract kinds", () => {
  it("makes a contract kind in a record a type error", () => {
    // @ts-expect-error A URL is a contract kind. A record must never hold one.
    object({ link: url() });
    // @ts-expect-error Display text is a contract kind. A record must never hold free text.
    object({ note: text(100) });
    // A contract shape may hold both.
    expect(shape({ link: url(), id: sha256() }).kind).toBe("object");
  });

  it("holds only record kinds in every record type, at every depth", () => {
    for (const record of Object.values(RECORD_SHAPES)) {
      for (const kind of kindsIn(record)) {
        expect(RECORD_KINDS).toContain(kind.kind);
      }
    }
  });
});

describe("node contract (KTD7, KTD10)", () => {
  const path = `records/${COMPONENT}/finding/${sha("a")}.json`;
  const listing = { head: PATCH_COMMIT, records: [{ path, blob: "ab".repeat(20) }] };

  it("accepts a head commit with a listing of record files", () => {
    expect(reasonOf(NODE_LISTING, listing)).toBe("ok");
    expect(reasonOf(NODE_LISTING, { head: PATCH_COMMIT, records: [] })).toBe("ok");
  });

  it("refuses a listing entry whose path is not a record path", () => {
    const prose = { path: "records/please read this file first.json", blob: "ab".repeat(20) };
    expect(reasonOf(NODE_LISTING, { ...listing, records: [prose] })).toBe("bad-path");
  });

  it("refuses an extra field, a bad head and a listing of 5,001 entries", () => {
    expect(reasonOf(NODE_LISTING, { ...listing, hint: "sync again soon" })).toBe("unknown-field");
    expect(reasonOf(NODE_LISTING, { ...listing, head: "main" })).toBe("unknown-value");
    const entries = Array.from({ length: MAX_LISTING_ENTRIES + 1 }, () => listing.records[0]);
    expect(reasonOf(NODE_LISTING, { ...listing, records: entries })).toBe("too-large");
    expect(reasonOf(NODE_LISTING, { ...listing, records: entries.slice(1) })).toBe("ok");
  });

  it("accepts a patch commit's parent and changed paths, with the deletion marker", () => {
    const body = {
      commit: PATCH_COMMIT,
      parent: COMPONENT,
      changes: [
        { path: "skills/summarize/SKILL.md", mode: "100644", blob: "ab".repeat(20) },
        { path: "scripts/old.sh", mode: DELETED_MODE, blob: DELETED_BLOB },
        { path: "link", mode: "120000", blob: "cd".repeat(20) },
      ],
    };
    expect(reasonOf(NODE_PATCH, body)).toBe("ok");
    const odd = { ...body, changes: [{ path: "a.md", mode: "100664", blob: "ab".repeat(20) }] };
    expect(reasonOf(NODE_PATCH, odd)).toBe("unknown-value");
    const outside = { ...body, changes: [{ path: "../a.md", mode: "100644", blob: "ab".repeat(20) }] };
    expect(reasonOf(NODE_PATCH, outside)).toBe("bad-path");
  });

  it("accepts a repo token only with an HTTPS remote that holds no credentials", () => {
    const body = {
      remote: "https://0123456789abcdef0123456789abcdef.artifacts.example/git/team-a/fork-1.git",
      token: "art_v2_0000?expires=1790000000",
      expires: 1790000000,
    };
    expect(reasonOf(REPO_TOKEN, body)).toBe("ok");
    expect(reasonOf(REPO_TOKEN, { ...body, remote: body.remote.replace("https:", "http:") })).toBe("unknown-value");
    expect(reasonOf(REPO_TOKEN, { ...body, remote: body.remote.replace("//", "//user:pw@") })).toBe("unknown-value");
    expect(reasonOf(REPO_TOKEN, { ...body, remote: "ext::sh -c id" })).toBe("unknown-value");
    expect(reasonOf(REPO_TOKEN, { ...body, token: "two words" })).toBe("unknown-value");
    expect(reasonOf(REPO_TOKEN, { ...body, token: "" })).toBe("unknown-value");
  });

  describe("a fork's fetch count (R45)", () => {
    const counted = { component: COMPONENT, fetches: 3 };

    it("has a public route of its own, which takes a component", () => {
      expect(NODE_ROUTES.fetches).toEqual({
        method: "GET",
        path: "fetches",
        query: { component: gitHash() },
        response: NODE_FETCHES,
      });
    });

    it("names its component and is a whole number from 1 to the limit", () => {
      expect(reasonOf(NODE_FETCHES, counted)).toBe("ok");
      expect(reasonOf(NODE_FETCHES, { ...counted, fetches: 1 })).toBe("ok");
      expect(reasonOf(NODE_FETCHES, { ...counted, fetches: MAX_FETCH_COUNT })).toBe("ok");
      expect(reasonOf(NODE_FETCHES, { ...counted, fetches: MAX_FETCH_COUNT + 1 })).toBe("unknown-value");
      expect(reasonOf(NODE_FETCHES, { ...counted, fetches: 2.5 })).toBe("unknown-value");
      expect(reasonOf(NODE_FETCHES, { ...counted, fetches: "3" })).toBe("unknown-value");
      expect(reasonOf(NODE_FETCHES, { ...counted, component: "main" })).toBe("unknown-value");
      expect(reasonOf(NODE_FETCHES, { fetches: 3 })).toBe("unknown-value");
      expect(reasonOf(NODE_FETCHES, { component: COMPONENT })).toBe("unknown-value");
    });

    it("is never zero, because a fork with no counted fetch has no count", () => {
      expect(reasonOf(NODE_FETCHES, { ...counted, fetches: 0 })).toBe("unknown-value");
    });

    it("is refused with a member the contract does not name", () => {
      expect(reasonOf(NODE_FETCHES, { ...counted, readers: [NODE_B] })).toBe("unknown-field");
      expect(reasonOf(NODE_FETCHES, { ...counted, note: "fetched by many teams" })).toBe("unknown-field");
    });
  });

  it("sends the admin key in a header on every admin route and on no public route", () => {
    for (const [id, route] of Object.entries<Route>(NODE_ROUTES)) {
      expect(route.key, id).toBe(route.path.startsWith("admin/") ? ADMIN_KEY_HEADER : undefined);
    }
    expect(routes(NODE_ROUTES).some((route) => route.key === ADMIN_KEY_HEADER)).toBe(true);
  });

  it("asks for a repo token by role and scope", () => {
    expect(reasonOf(ADMIN_TOKEN_REQUEST, { repo: "fork", component: COMPONENT, scope: "write" })).toBe("ok");
    expect(reasonOf(ADMIN_TOKEN_REQUEST, { repo: "team", scope: "write" })).toBe("ok");
    expect(reasonOf(ADMIN_TOKEN_REQUEST, { repo: "fork", scope: "write" })).toBe("unknown-value");
    expect(reasonOf(ADMIN_TOKEN_REQUEST, { repo: "team", component: COMPONENT, scope: "write" })).toBe(
      "unknown-field",
    );
    expect(reasonOf(ADMIN_TOKEN_REQUEST, { repo: "fork", component: COMPONENT, scope: "admin" })).toBe(
      "unknown-value",
    );
  });

  it("asks for no write token for a component copy (R8)", () => {
    expect(reasonOf(ADMIN_TOKEN_REQUEST, { repo: "copy", component: COMPONENT, scope: "read" })).toBe("ok");
    expect(reasonOf(ADMIN_TOKEN_REQUEST, { repo: "copy", component: COMPONENT, scope: "write" })).toBe(
      "unknown-value",
    );
    const schema = jsonSchemaOf(ADMIN_TOKEN_REQUEST);
    expect(JSON.stringify(schema["allOf"])).toContain(
      JSON.stringify({
        if: { properties: { repo: { enum: ["copy"] } }, required: ["repo"] },
        then: { properties: { scope: { enum: ["read"] } } },
      }),
    );
  });
});

describe("index contract (R13, R34, KTD11, KTD12, KTD30)", () => {
  const source = (node: string, type: string, id: string) => ({
    node,
    repo: "records",
    commit: PATCH_COMMIT,
    path: `records/${COMPONENT}/${type}/${id}.json`,
    id,
  });

  const view: View = {
    version: "1",
    component: COMPONENT,
    gitUrl: "https://git.fellbeck-tools.example/demo-plugin.git",
    state: "ready",
    viewVersion: 12,
    lag: 0,
    organizations: 2,
    nodes: [
      { node: NODE_A, processed: PATCH_COMMIT, simulated: false, historyRewritten: false },
      { node: NODE_B, simulated: true, historyRewritten: false },
    ],
    claims: [{ ...source(NODE_A, "claim", sha("c")), record: reviewClaim(), state: "closed" }],
    findings: [
      {
        blob: "ab".repeat(20),
        observation: "sends-data-to-host",
        host: HOST,
        paths: ["skills/summarize/SKILL.md"],
        findings: [{ ...source(NODE_A, "finding", sha("a")), record: finding() }],
        rechecks: [{ ...source(NODE_B, "re-check", sha("b")), record: recheck() }],
        counterFindings: [],
        nodes: [NODE_A, NODE_B],
        confirmed: true,
        criteria: [{ criterion: "safe-to-run-with-access", nodes: [NODE_A, NODE_B], confirmed: true }],
      },
    ],
    hosts: [{ host: HOST, count: 1 }],
    patches: [
      {
        patches: [
          {
            patchId: sha("d"),
            kind: "removes-only",
            size: 1,
            changes: [{ blob: "ab".repeat(20), hunks: [{ oldStart: 3, removed: 1, newStart: 3, added: 0 }] }],
            paths: ["skills/summarize/SKILL.md"],
            records: [{ ...source(NODE_A, "patch", sha("e")), record: patch() }],
            rechecks: [],
            nodes: [NODE_A],
            confirmed: false,
          },
        ],
      },
    ],
    recipes: [],
    pending: [{ node: NODE_B, hash: sha("f"), type: "patch" }],
    rejected: [{ node: NODE_B, hash: sha("9"), type: "patch", reason: "patch-out-of-scope" }],
  };

  it("accepts a view", () => {
    expect(conforms(VIEW, view)).toBeUndefined();
  });

  describe("what a node declared, in its entry of a view (KTD42)", () => {
    const [first, second] = view.nodes;
    const declaring = (declared: unknown) => ({ ...view, nodes: [{ ...first, declared }, second] });

    it("takes a node's count of fetches under `declared`, from 1 to the limit, and an entry with nothing declared", () => {
      expect(reasonOf(VIEW, declaring({ fetches: 3 }))).toBe("ok");
      expect(reasonOf(VIEW, declaring({ fetches: 1 }))).toBe("ok");
      expect(reasonOf(VIEW, declaring({ fetches: MAX_FETCH_COUNT }))).toBe("ok");
      expect(first).not.toHaveProperty("declared");
      expect(reasonOf(VIEW, view)).toBe("ok");
    });

    it("refuses a count of zero, a count over the limit, a fraction and a count held as text", () => {
      expect(reasonOf(VIEW, declaring({ fetches: 0 }))).toBe("unknown-value");
      expect(reasonOf(VIEW, declaring({ fetches: MAX_FETCH_COUNT + 1 }))).toBe("unknown-value");
      expect(reasonOf(VIEW, declaring({ fetches: 2.5 }))).toBe("unknown-value");
      expect(reasonOf(VIEW, declaring({ fetches: "3" }))).toBe("unknown-value");
    });

    it("refuses `declared` with no count, with another member, and a count that stands outside it", () => {
      expect(reasonOf(VIEW, declaring({}))).toBe("unknown-value");
      expect(reasonOf(VIEW, declaring({ fetches: 3, readers: [NODE_B] }))).toBe("unknown-field");
      expect(reasonOf(VIEW, declaring({ fetches: 3, note: "fetched by many teams" }))).toBe("unknown-field");
      // A count beside the computed members would read as one of them.
      expect(reasonOf(VIEW, { ...view, nodes: [{ ...first, fetches: 3 }, second] })).toBe("unknown-field");
    });
  });

  it("gives view entries the shape the match rule reads", () => {
    const groups = matchGroups(view.findings.flatMap((group) => [...group.findings, ...group.rechecks]), [
      { path: "skills/summarize/SKILL.md", mode: "100644", blob: "ab".repeat(20) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.nodes).toEqual([NODE_A, NODE_B]);
    expect(groups[0]?.criteria).toEqual(view.findings[0]?.criteria);
  });

  it("refuses a view whose findings carry no count per criterion (R10)", () => {
    const { criteria: _criteria, ...group } = view.findings[0] ?? {};
    expect(reasonOf(VIEW, { ...view, findings: [group] })).toBe("unknown-value");
  });

  it("refuses a view in which a record listed as valid fails validation", () => {
    const group = view.findings[0];
    const bad = { ...group, findings: [{ ...source(NODE_A, "finding", sha("a")), record: { ...finding(), note: "x" } }] };
    expect(reasonOf(VIEW, { ...view, findings: [bad] })).toBe("unknown-field");
    const wrongType = { ...group, findings: [{ ...source(NODE_A, "finding", sha("a")), record: recheck() }] };
    expect(reasonOf(VIEW, { ...view, findings: [wrongType] })).toBe("unknown-value");
  });

  it("serves rejected work as four values only (KTD31)", () => {
    const rejected = [{ ...view.rejected[0], path: "records/read me first.json" }];
    expect(reasonOf(VIEW, { ...view, rejected })).toBe("unknown-field");
    expect(Object.keys(VIEW.fields.rejected.items.fields)).toEqual(["node", "hash", "type", "reason"]);
  });

  it("refuses a response with another schema version", () => {
    expect(reasonOf(VIEW, { ...view, version: "2" })).toBe("unsupported-version");
    expect(reasonOf(INDEX_REFUSAL, { error: "unauthorized" })).toBe("unsupported-version");
    expect(reasonOf(INDEX_REFUSAL, { version: "1", error: "unauthorized" })).toBe("ok");
    expect(reasonOf(INDEX_REFUSAL, { version: "1", error: "try again later" })).toBe("unknown-value");
  });

  it("carries the schema version in every JSON response except the link set", () => {
    for (const response of jsonResponses(INDEX_ROUTES)) {
      if (response === API_CATALOG) continue;
      expect(response.kind === "object" && response.fields["version"]?.kind).toBe("version");
    }
    expect(INDEX_REFUSAL.fields.version.kind).toBe("version");
  });

  it("holds only criteria, hosts and counts in the projection, with no path and no line", () => {
    const projection: Projection = {
      version: "1",
      component: COMPONENT,
      state: "ready",
      viewVersion: 12,
      confirmed: [
        { criterion: "safe-to-run-with-access", host: HOST, organizations: 2 },
        { criterion: "safe-to-read", organizations: 3 },
      ],
    };
    expect(conforms(PROJECTION, projection)).toBeUndefined();
    const kinds = kindsIn(PROJECTION).map((kind) => kind.kind);
    expect(kinds).not.toContain("path");
    expect(kinds).not.toContain("record");
    expect(kinds).not.toContain("record-path");
    expect(kinds).not.toContain("text");
    const names = fieldNamesIn(PROJECTION);
    for (const name of ["path", "paths", "start", "end", "location", "blob", "observation"]) {
      expect(names).not.toContain(name);
    }
    expect(reasonOf(PROJECTION, { ...projection, confirmed: [{ criterion: "safe-to-read", path: "a.md" }] })).toBe(
      "unknown-field",
    );
  });

  it("holds free text only in the cited-lines route (R31)", () => {
    for (const response of jsonResponses(INDEX_ROUTES)) {
      const hasText = kindsIn(response).some((kind) => kind.kind === "text");
      expect(hasText).toBe(response === CITED_LINES);
    }
    expect(jsonResponses(INDEX_ROUTES)).toContain(CITED_LINES);
    const body = { version: "1", finding: sha("a"), path: "a.md", start: 3, end: 4, lines: ["one", "two"] };
    expect(reasonOf(CITED_LINES, body)).toBe("ok");
    expect(reasonOf(CITED_LINES, { ...body, lines: ["x".repeat(70_000)] })).toBe("too-large");
    expect(reasonOf(CITED_LINES, { ...body, lines: [7] })).toBe("unknown-value");
  });

  it("serves the API catalog at /.well-known/api-catalog as a link set", () => {
    expect(INDEX_ROUTES.catalog.path).toBe("/.well-known/api-catalog");
    expect(INDEX_ROUTES.catalog.response).toBe(API_CATALOG);
    // The catalog names the API as an item, and the API names its description and the schemas (RFC 9727).
    const body = {
      linkset: [
        { anchor: "https://index.cairnfield.example/.well-known/api-catalog", item: [{ href: "https://index.cairnfield.example/" }] },
        {
          anchor: "https://index.cairnfield.example/",
          "service-desc": [{ href: "https://index.cairnfield.example/openapi.json", type: "application/openapi+json" }],
          describedby: [
            { href: "https://index.cairnfield.example/schemas/finding.json", type: "application/schema+json" },
          ],
        },
      ],
    };
    expect(reasonOf(API_CATALOG, body)).toBe("ok");
    expect(reasonOf(API_CATALOG, { ...body, next: "read the docs" })).toBe("unknown-field");
    expect(reasonOf(API_CATALOG, { linkset: [{ anchor: "https://index.cairnfield.example/", item: [{ href: "ftp://x" }] }] })).toBe("unknown-value");
  });

  it("registers a component by Git URL, branch and commit", () => {
    const body = { url: "https://git.fellbeck-tools.example/demo-plugin.git", branch: "main", commit: COMPONENT };
    expect(reasonOf(REGISTER_COMPONENT_REQUEST, body)).toBe("ok");
    expect(reasonOf(REGISTER_COMPONENT_REQUEST, { ...body, branch: "--upload-pack=x" })).toBe("unknown-value");
    expect(reasonOf(REGISTER_COMPONENT_REQUEST, { ...body, url: "https://user:pw@git.fellbeck-tools.example/x.git" })).toBe(
      "unknown-value",
    );
    expect(reasonOf(REGISTER_COMPONENT_REQUEST, { ...body, commit: "HEAD" })).toBe("unknown-value");
  });

  it("lists the registered components at a path of its own, with no query", () => {
    expect(INDEX_ROUTES.list).toEqual({ method: "GET", path: "/view", response: COMPONENT_LIST });
    const listed = {
      component: COMPONENT,
      url: "https://git.fellbeck-tools.example/demo-plugin.git",
      branch: "main",
      state: "ready",
    };
    const list = (...components: unknown[]) => ({ version: "1", components });
    expect(reasonOf(COMPONENT_LIST, list())).toBe("ok");
    expect(reasonOf(COMPONENT_LIST, list(listed, { ...listed, component: PATCH_COMMIT, state: "failed" }))).toBe("ok");
    expect(reasonOf(COMPONENT_LIST, list({ ...listed, state: "clean" }))).toBe("unknown-value");
    expect(reasonOf(COMPONENT_LIST, list({ ...listed, note: "start with this one" }))).toBe("unknown-field");
    expect(reasonOf(COMPONENT_LIST, { components: [listed] })).toBe("unsupported-version");
  });

  it("takes a notice that names one node and nothing else", () => {
    expect(reasonOf(NOTICE, { node: NODE_A })).toBe("ok");
    expect(reasonOf(NOTICE, { node: NODE_A, fetch: "https://elsewhere.example" })).toBe("unknown-field");
    expect(reasonOf(NOTICE, { node: "http://node.team-a.example" })).toBe("unknown-value");
  });

  const component = (url: string) => ({ url, branch: "main", commit: COMPONENT });

  it("accepts a URL field that holds one HTTPS URL in serialized form", () => {
    for (const value of GOOD_URLS) {
      expect(reasonOf(REGISTER_COMPONENT_REQUEST, component(value)), value).toBe("ok");
    }
  });

  it.each([...URLS_OFF_PATTERN, ...URLS_NOT_SERIALIZED])("refuses a URL field that holds %s", (_why, value) => {
    expect(reasonOf(REGISTER_COMPONENT_REQUEST, component(value))).toBe("unknown-value");
  });

  it("names a node by its base URL in the one accepted spelling (KTD8)", () => {
    for (const value of GOOD_NODE_URLS) {
      expect(reasonOf(REGISTER_NODE_REQUEST, { url: value }), value).toBe("ok");
      expect(reasonOf(NOTICE, { node: value }), value).toBe("ok");
    }
  });

  it.each(NODE_URLS_OFF_PATTERN)(
    "refuses a node named with %s",
    (_why, value) => {
      expect(reasonOf(REGISTER_NODE_REQUEST, { url: value })).toBe("unknown-value");
      expect(reasonOf(NOTICE, { node: value })).toBe("unknown-value");
    },
  );

  it("uses the node URL kind wherever an index body names a node", () => {
    const fieldsIn = (kind: ContractKind): [string, ContractKind][] => {
      if (kind.kind === "object") {
        return Object.entries(kind.fields).flatMap(([name, field]) => [[name, field], ...fieldsIn(field)]);
      }
      return kind.kind === "list" || kind.kind === "set" ? fieldsIn(kind.items) : [];
    };
    const bodies = routes(INDEX_ROUTES).flatMap((route) => [
      ...(route.request ? [route.request] : []),
      ...("media" in route.response ? [] : [route.response]),
    ]);
    const named = bodies.flatMap(fieldsIn).filter(([name]) => name === "node" || name === "nodes");
    expect(named.length).toBeGreaterThan(8);
    for (const [name, kind] of named) {
      const held = kind.kind === "list" ? kind.items : kind;
      // The view's own list of nodes holds one object per node, and that object names the node.
      expect(held.kind === "node-url" || (name === "nodes" && held.kind === "object"), name).toBe(true);
    }
    expect(REGISTER_NODE_REQUEST.fields.url.kind).toBe("node-url");
  });

  it("guards registration and reset with separate keys, and leaves reading open", () => {
    expect(INDEX_ROUTES.registerNode.key).toBe(REGISTRATION_KEY_HEADER);
    expect(INDEX_ROUTES.registerComponent.key).toBe(REGISTRATION_KEY_HEADER);
    expect(INDEX_ROUTES.reset.key).toBe(RESET_KEY_HEADER);
    expect(RESET_KEY_HEADER).not.toBe(REGISTRATION_KEY_HEADER);
    for (const route of routes(INDEX_ROUTES)) {
      if (route.method === "GET") expect(route.key).toBeUndefined();
    }
    const notice: Route = INDEX_ROUTES.notice;
    expect(notice.key).toBeUndefined();
  });
});

describe("the note on a patch commit (R46, KTD44)", () => {
  const note = { version: "1", commit: PATCH_COMMIT, findings: [sha("a")], model: "claude-sonnet-5-5", recording: sha("b") };

  it("is kept at one ref of a fork, which a reader fetches by this name", () => {
    expect(NOTES_REF).toBe("refs/notes/cairnfield");
  });

  it("names the commit, its findings, the model and the recording, and the prompt when the recording names one", () => {
    expect(reasonOf(PATCH_NOTE, note)).toBe("ok");
    expect(reasonOf(PATCH_NOTE, { ...note, prompt: sha("c") })).toBe("ok");
    expect(reasonOf(PATCH_NOTE, { ...note, model: "none" })).toBe("ok");
    expect(reasonOf(PATCH_NOTE, { ...note, findings: [sha("a"), sha("d")] })).toBe("ok");
    for (const field of ["commit", "findings", "model", "recording"]) {
      const { [field]: _taken, ...rest } = note as { readonly [field: string]: unknown };
      expect(reasonOf(PATCH_NOTE, rest), field).toBe("unknown-value");
    }
    const { version: _none, ...unversioned } = note;
    expect(reasonOf(PATCH_NOTE, unversioned)).toBe("unsupported-version");
  });

  it("refuses a field of its own, such as a count of tool calls, and a value that is no hash and no listed model", () => {
    expect(reasonOf(PATCH_NOTE, { ...note, toolCalls: 12 })).toBe("unknown-field");
    expect(reasonOf(PATCH_NOTE, { ...note, model: "a model of our own" })).toBe("unknown-value");
    expect(reasonOf(PATCH_NOTE, { ...note, prompt: "Read this file first." })).toBe("unknown-value");
    expect(reasonOf(PATCH_NOTE, { ...note, recording: PATCH_COMMIT })).toBe("unknown-value");
    expect(reasonOf(PATCH_NOTE, { ...note, commit: "main" })).toBe("unknown-value");
    // The findings are a set, as a patch record's are: sorted, with at least one.
    expect(reasonOf(PATCH_NOTE, { ...note, findings: [sha("d"), sha("a")] })).toBe("unknown-value");
    expect(reasonOf(PATCH_NOTE, { ...note, findings: [] })).toBe("unknown-value");
  });

  it("holds only record kinds, so no field of it can hold free text", () => {
    for (const kind of kindsIn(PATCH_NOTE)) expect(RECORD_KINDS).toContain(kind.kind);
    expect(fieldNamesIn(PATCH_NOTE).sort()).toEqual(["commit", "findings", "model", "prompt", "recording", "version"]);
  });
});

describe("route tables", () => {
  it("declares each path parameter exactly once", () => {
    for (const table of [NODE_ROUTES, INDEX_ROUTES]) {
      for (const [id, route] of Object.entries<Route>(table)) {
        const inPath = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
        expect(inPath.sort(), id).toEqual(Object.keys(route.params ?? {}).sort());
      }
    }
  });

  it("gives a body only to POST routes", () => {
    for (const table of [NODE_ROUTES, INDEX_ROUTES]) {
      for (const [id, route] of Object.entries<Route>(table)) {
        if (route.method === "GET") expect(route.request, id).toBeUndefined();
      }
    }
  });
});
