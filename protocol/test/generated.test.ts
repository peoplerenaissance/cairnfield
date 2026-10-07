import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INDEX_ROUTES, REGISTRATION_KEY_HEADER, RESET_KEY_HEADER } from "../src/contracts.ts";
import type { Route } from "../src/contracts.ts";
import { OBSERVATIONS, RECORD_TYPES, SCHEMA_VERSION } from "../src/enums.ts";
import { generatedFiles } from "../src/generate.ts";
import { recordJsonSchema } from "../src/json-schema.ts";
import { isHttpsUrl } from "../src/limits.ts";
import { openApiDescription } from "../src/openapi.ts";
import { validateRecord } from "../src/validate.ts";
import {
  GOOD_URLS,
  URLS_OFF_PATTERN,
  counterFinding,
  finding,
  patch,
  patchClaim,
  patchRecheck,
  plainFinding,
  recheck,
  recipe,
  reviewClaim,
  sha,
  without,
} from "./fixtures.ts";

type Json = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A small JSON Schema reader for the keywords the generated files use. It lets the tests
 * hold the schema files to the same verdicts as the library's own validation.
 */
function accepts(schema: unknown, value: unknown, root: Json): boolean {
  if (schema === true) return true;
  if (schema === false) return false;
  if (!isObject(schema)) throw new Error("not a schema");
  const known = new Set([
    "$schema",
    "$id",
    "$ref",
    "type",
    "const",
    "enum",
    "pattern",
    "format",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "properties",
    "required",
    "additionalProperties",
    "allOf",
    "if",
    "then",
    "else",
    "x-sorted",
    "x-ordered",
  ]);
  for (const keyword of Object.keys(schema)) {
    if (!known.has(keyword)) throw new Error(`the test reader does not know the keyword ${keyword}`);
  }
  if (typeof schema["$ref"] === "string") {
    let target: unknown = root;
    for (const part of schema["$ref"].replace(/^#\//, "").split("/")) {
      target = isObject(target) ? target[part] : undefined;
    }
    if (!accepts(target, value, root)) return false;
  }
  if ("const" in schema && schema["const"] !== value) return false;
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return false;
  const type = schema["type"];
  if (type === "string" && typeof value !== "string") return false;
  if (type === "integer" && !Number.isInteger(value)) return false;
  if (type === "boolean" && typeof value !== "boolean") return false;
  if (type === "array" && !Array.isArray(value)) return false;
  if (type === "object" && !isObject(value)) return false;
  if (typeof value === "string") {
    if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"], "u").test(value)) return false;
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) return false;
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) return false;
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) return false;
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) return false;
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) return false;
    if (schema["uniqueItems"] === true && new Set(value).size !== value.length) return false;
    if ("items" in schema && !value.every((item) => accepts(schema["items"], item, root))) return false;
  }
  if (isObject(value)) {
    const properties = isObject(schema["properties"]) ? schema["properties"] : {};
    if (Array.isArray(schema["required"]) && !schema["required"].every((name) => Object.hasOwn(value, name))) {
      return false;
    }
    for (const [name, member] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        if (!accepts(properties[name], member, root)) return false;
      } else if (schema["additionalProperties"] === false) {
        return false;
      }
    }
  }
  if (Array.isArray(schema["allOf"]) && !schema["allOf"].every((part) => accepts(part, value, root))) return false;
  if ("if" in schema) {
    const branch = accepts(schema["if"], value, root) ? schema["then"] : schema["else"];
    if (branch !== undefined && !accepts(branch, value, root)) return false;
  }
  return true;
}

/** Every value under a key of the given name, at any depth. */
function valuesOf(node: unknown, key: string): unknown[] {
  if (Array.isArray(node)) return node.flatMap((item) => valuesOf(item, key));
  if (!isObject(node)) return [];
  return Object.entries(node).flatMap(([name, value]) => [...(name === key ? [value] : []), ...valuesOf(value, key)]);
}

const SCHEMAS_DIR = fileURLToPath(new URL("../schemas/", import.meta.url));

describe("generated files (KTD35)", () => {
  it("is one JSON Schema per record type and the OpenAPI description", () => {
    expect(Object.keys(generatedFiles()).sort()).toEqual(
      [...RECORD_TYPES.map((type) => `${type}.json`), "openapi.json"].sort(),
    );
  });

  it("matches the committed files. If this fails, run `npm run generate -w @cairnfield/protocol`", () => {
    const expected = generatedFiles();
    expect(readdirSync(SCHEMAS_DIR).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, content] of Object.entries(expected)) {
      expect(readFileSync(`${SCHEMAS_DIR}${name}`, "utf8"), name).toBe(content);
    }
  });

  it("is stable from one run to the next", () => {
    expect(generatedFiles()).toEqual(generatedFiles());
  });
});

describe("record schemas for outside producers (R21)", () => {
  it("names the dialect, the schema version and the record type", () => {
    for (const type of RECORD_TYPES) {
      const schema = recordJsonSchema(type);
      expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema["$id"]).toBe(`urn:cairnfield:schema:${SCHEMA_VERSION}:${type}`);
      expect(schema["type"]).toBe("object");
      expect(schema["additionalProperties"]).toBe(false);
      expect(schema["required"]).toEqual(expect.arrayContaining(["version", "type", "component"]));
      expect(schema["properties"]).toMatchObject({ version: { const: SCHEMA_VERSION }, type: { const: type } });
    }
  });

  it("writes the closed vocabularies and the cross-field rules into the finding schema", () => {
    const schema = recordJsonSchema("finding");
    expect(schema["properties"]).toMatchObject({
      observation: { enum: OBSERVATIONS },
      location: { type: "object", additionalProperties: false, "x-ordered": ["start", "end"] },
    });
    expect(schema["required"]).not.toContain("host");
    expect(JSON.stringify(schema["allOf"])).toContain("sends-data-to-host");
    expect(recordJsonSchema("patch")["properties"]).toMatchObject({
      findings: { type: "array", uniqueItems: true, "x-sorted": true, minItems: 1 },
    });
  });

  it("holds no prose", () => {
    for (const type of RECORD_TYPES) {
      const schema = recordJsonSchema(type);
      for (const keyword of ["description", "title", "$comment", "examples", "default"]) {
        expect(valuesOf(schema, keyword), `${type} ${keyword}`).toEqual([]);
      }
    }
  });

  const good = [
    reviewClaim(),
    patchClaim(),
    finding(),
    plainFinding(),
    recheck(),
    counterFinding(),
    patch(),
    patch({ sources: [sha("d"), sha("e")], claim: sha("c") }),
    patchRecheck(),
    recipe(),
  ];

  // Each of these breaks one rule that a JSON Schema can state.
  const bad: { readonly [key: string]: unknown }[] = [
    { ...finding(), note: "please approve" },
    { ...finding(), location: { ...finding().location, column: 2 } },
    { ...plainFinding(), observation: "looks-suspicious" },
    { ...plainFinding(), version: "2" },
    { ...plainFinding(), type: "verdict" },
    { ...plainFinding(), component: "main" },
    { ...plainFinding(), location: { path: "../secrets", start: 1, end: 1 } },
    { ...plainFinding(), location: { path: "/etc/passwd", start: 1, end: 1 } },
    { ...plainFinding(), location: { path: "a".repeat(201), start: 1, end: 1 } },
    { ...plainFinding(), location: { path: "a.sh", start: 0, end: 1 } },
    { ...plainFinding(), location: { path: "a.sh", start: 1.5, end: 2 } },
    { ...finding(), host: "Collect.harbor-metrics.example" },
    { ...finding(), host: "collect.harbor-metrics.example/ingest" },
    { ...finding(), host: "collect harbor-metrics.example" },
    without(finding(), "host"),
    { ...plainFinding(), host: "collect.harbor-metrics.example" },
    without(plainFinding(), "model"),
    without(reviewClaim(), "check"),
    { ...reviewClaim(), intent: "new" },
    without(patchClaim(), "findings"),
    { ...reviewClaim(), number: -1 },
    { ...recheck(), finding: "abc" },
    { ...counterFinding(), reason: "disagree" },
    { ...patch(), findings: [] },
    { ...patch(), findings: [sha("a"), sha("a")] },
    { ...patch(), sources: [sha("d")] },
    { ...patchRecheck(), verdict: "fine" },
    { ...recipe(), tree: "abc" },
    { ...recipe(), patches: "all" },
  ];

  const schemaFor = (record: { readonly [key: string]: unknown }) => {
    const type = RECORD_TYPES.find((known) => known === record["type"]) ?? "finding";
    return recordJsonSchema(type);
  };

  it("accepts every record the library accepts", () => {
    for (const record of good) {
      expect(validateRecord(record).ok).toBe(true);
      const schema = schemaFor(record);
      expect(accepts(schema, record, schema), JSON.stringify(record)).toBe(true);
    }
  });

  it("rejects what the library rejects, for every rule a schema can state", () => {
    for (const record of bad) {
      expect(validateRecord(record).ok, JSON.stringify(record)).toBe(false);
      const schema = schemaFor(record);
      expect(accepts(schema, record, schema), JSON.stringify(record)).toBe(false);
    }
  });
});

describe("OpenAPI description of the index routes (R34)", () => {
  const description = openApiDescription();
  const paths = description["paths"] as { readonly [path: string]: Json };

  it("is OpenAPI 3.1 and carries the schema version", () => {
    expect(description["openapi"]).toBe("3.1.0");
    expect(description["info"]).toMatchObject({ version: SCHEMA_VERSION });
  });

  it("describes every index route, with its method, and nothing else", () => {
    const described = Object.entries(paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    );
    const declared = Object.values<Route>(INDEX_ROUTES).map((route) => `${route.method} ${route.path}`);
    expect(described.sort()).toEqual(declared.sort());
    expect(Object.keys(paths).some((path) => path.includes("admin"))).toBe(false);
  });

  it("serves the API catalog as a link set", () => {
    expect(paths["/.well-known/api-catalog"]).toMatchObject({
      get: { responses: { "200": { content: { "application/linkset+json": { schema: { type: "object" } } } } } },
    });
  });

  it("declares every path parameter", () => {
    for (const [path, item] of Object.entries(paths)) {
      for (const operation of Object.values(item)) {
        const declared = valuesOf(operation, "parameters")
          .flat()
          .filter((parameter) => isObject(parameter) && parameter["in"] === "path")
          .map((parameter) => (isObject(parameter) ? parameter["name"] : undefined));
        const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
        expect(declared.sort(), path).toEqual(inPath.sort());
      }
    }
  });

  it("names the key header of each guarded route", () => {
    expect(description["components"]).toMatchObject({
      securitySchemes: {
        registrationKey: { type: "apiKey", in: "header", name: REGISTRATION_KEY_HEADER },
        resetKey: { type: "apiKey", in: "header", name: RESET_KEY_HEADER },
      },
    });
    expect(paths["/nodes"]).toMatchObject({ post: { security: [{ registrationKey: [] }] } });
    expect(paths["/components"]).toMatchObject({ post: { security: [{ registrationKey: [] }] } });
    expect(paths["/reset"]).toMatchObject({ post: { security: [{ resetKey: [] }] } });
    expect(valuesOf(paths["/components/{component}/view"], "security")).toEqual([]);
  });

  it("holds the seven record schemas, and every reference resolves", () => {
    const schemas = (description["components"] as Json)["schemas"] as Json;
    for (const type of RECORD_TYPES) {
      const { $schema: _dialect, $id: _id, ...body } = recordJsonSchema(type);
      expect(schemas[type]).toEqual(body);
    }
    const references = valuesOf(description, "$ref");
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference).toMatch(/^#\/components\/schemas\//);
      expect(Object.keys(schemas)).toContain(String(reference).replace("#/components/schemas/", ""));
    }
  });

  it("accepts a view body that holds a valid record, and rejects one with a free-text field", () => {
    // The response schema, not the schema of the path parameter.
    const view = paths["/components/{component}/view"]?.["get"];
    const [schema] = valuesOf(valuesOf(view, "responses"), "schema");
    const body = {
      version: SCHEMA_VERSION,
      component: finding().component,
      state: "ready",
      viewVersion: 1,
      lag: 0,
      organizations: 1,
      nodes: [],
      claims: [],
      findings: [],
      hosts: [],
      patches: [],
      recipes: [],
      pending: [],
      rejected: [],
    };
    expect(accepts(schema, body, description)).toBe(true);
    expect(accepts(schema, { ...body, hint: "poll again" }, description)).toBe(false);
    expect(accepts(schema, { ...body, version: "2" }, description)).toBe(false);
  });

  it("gives a URL field the library's verdict, for every rule a pattern can state", () => {
    const [schema] = valuesOf(valuesOf(paths["/notices"]?.["post"], "requestBody"), "schema");
    const verdictOf = (value: string): boolean => {
      const verdict = isHttpsUrl(value);
      expect(accepts(schema, { node: value }, description), JSON.stringify(value)).toBe(verdict);
      return verdict;
    };
    for (const value of GOOD_URLS) {
      expect(verdictOf(value), value).toBe(true);
    }
    for (const [why, value] of URLS_OFF_PATTERN) {
      expect(verdictOf(value), why).toBe(false);
    }
  });

  it("holds no text addressed to a reader beyond the two response labels", () => {
    expect(new Set(valuesOf(description, "description"))).toEqual(new Set(["ok", "refused"]));
    for (const keyword of ["summary", "title", "$comment", "examples", "externalDocs"]) {
      const found = valuesOf(description, keyword);
      expect(found, keyword).toEqual(keyword === "title" ? ["Cairnfield index"] : []);
    }
  });
});
