// JSON Schema, derived from the field kinds (KTD35). The record schemas are for outside
// producers (R21). They hold structure only and no prose, because the index serves them (R34).
//
// Two rules have no JSON Schema keyword, so they travel as annotations that a plain
// validator ignores: `x-sorted` on a set, and `x-ordered` on an object whose first named
// field must not be greater than its second. The 4 KB record limit is not in the schema.
// Nor is the rule that a URL is in serialized form, which a pattern cannot state.

import { SCHEMA_VERSION } from "./enums.ts";
import type { RecordType } from "./enums.ts";
import type { ContractKind, NameKind, ObjectKind, Rule, ShapeKind } from "./fields.ts";
import {
  BRANCH_NAME_PATTERN,
  GIT_HASH_PATTERN,
  HOSTNAME_PATTERN,
  MAX_BRANCH_NAME_LENGTH,
  MAX_HOSTNAME_LENGTH,
  MAX_NAMESPACE_NAME_LENGTH,
  MAX_PATH_LENGTH,
  MAX_REPO_NAME_LENGTH,
  NODE_URL_PATTERN,
  MAX_URL_LENGTH,
  MIN_NAMESPACE_NAME_LENGTH,
  NAME_PATTERN,
  PATH_PATTERN,
  SHA256_PATTERN,
  TOKEN_PATTERN,
  URL_PATTERN,
} from "./limits.ts";
import { RECORD_PATH_PATTERN, RECORD_SHAPES } from "./schemas.ts";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** The identifier of a record type's schema. It names the schema version, so a new version is a new schema. */
export function recordSchemaId(type: RecordType): string {
  return `urn:cairnfield:schema:${SCHEMA_VERSION}:${type}`;
}

function typeOf(shape: ObjectKind): RecordType {
  for (const [type, known] of Object.entries(RECORD_SHAPES)) {
    if (known === shape) return type as RecordType;
  }
  throw new Error("an embedded record must be one of the record shapes");
}

function nameSchema(of: NameKind["of"]): JsonObject {
  if (of === "branch") return { type: "string", pattern: BRANCH_NAME_PATTERN, maxLength: MAX_BRANCH_NAME_LENGTH };
  if (of === "repo") return { type: "string", pattern: NAME_PATTERN, maxLength: MAX_REPO_NAME_LENGTH };
  return {
    type: "string",
    pattern: NAME_PATTERN,
    minLength: MIN_NAMESPACE_NAME_LENGTH,
    maxLength: MAX_NAMESPACE_NAME_LENGTH,
  };
}

function objectSchema(kind: ObjectKind | ShapeKind, refOf: (type: RecordType) => string): JsonObject {
  const properties: { [name: string]: JsonValue } = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(kind.fields)) {
    properties[name] = jsonSchemaOf(field, refOf);
    if (field.optional !== true) required.push(name);
  }
  const conditions: JsonObject[] = [];
  const ordered: Extract<Rule, { rule: "ordered" }>[] = [];
  for (const rule of kind.rules) {
    if (rule.rule === "ordered") {
      ordered.push(rule);
    } else if (rule.rule === "one-of-when") {
      conditions.push({
        if: { properties: { [rule.on]: { enum: rule.in } }, required: [rule.on] },
        then: { properties: { [rule.field]: { enum: rule.values } } },
      });
    } else {
      // Required when the `on` field holds one of the values, and refused otherwise.
      conditions.push({
        if: { properties: { [rule.on]: { enum: rule.in } }, required: [rule.on] },
        then: { required: [rule.field] },
        else: { properties: { [rule.field]: false } },
      });
    }
  }
  const [order, ...more] = ordered;
  if (more.length > 0) throw new Error("an object holds at most one ordered rule");
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
    ...(conditions.length > 0 ? { allOf: conditions } : {}),
    ...(order === undefined ? {} : { "x-ordered": [order.low, order.high] }),
  };
}

/**
 * The JSON Schema of a field kind. `refOf` says where the schema of a whole record lives,
 * for a contract shape that embeds one.
 */
export function jsonSchemaOf(kind: ContractKind, refOf: (type: RecordType) => string = recordSchemaId): JsonObject {
  switch (kind.kind) {
    case "version":
      return { const: SCHEMA_VERSION };
    case "enum": {
      const [only, ...rest] = kind.values;
      return only !== undefined && rest.length === 0 ? { const: only } : { enum: kind.values };
    }
    case "sha256":
      return { type: "string", pattern: SHA256_PATTERN };
    case "git-hash":
      return { type: "string", pattern: GIT_HASH_PATTERN };
    case "int":
      return { type: "integer", minimum: kind.min, maximum: kind.max };
    case "path":
      return { type: "string", pattern: PATH_PATTERN, maxLength: MAX_PATH_LENGTH };
    case "hostname":
      return { type: "string", pattern: HOSTNAME_PATTERN, maxLength: MAX_HOSTNAME_LENGTH };
    case "set":
      return {
        type: "array",
        items: jsonSchemaOf(kind.items, refOf),
        minItems: kind.min,
        maxItems: kind.max,
        uniqueItems: true,
        "x-sorted": true,
      };
    case "object":
      return objectSchema(kind, refOf);
    case "url":
      return { type: "string", format: "uri", pattern: URL_PATTERN, maxLength: MAX_URL_LENGTH };
    case "node-url":
      return { type: "string", format: "uri", pattern: NODE_URL_PATTERN, maxLength: MAX_URL_LENGTH };
    case "token":
      return { type: "string", pattern: TOKEN_PATTERN };
    case "text":
      return { type: "string", maxLength: kind.max };
    case "boolean":
      return { type: "boolean" };
    case "name":
      return nameSchema(kind.of);
    case "record-path":
      return { type: "string", pattern: RECORD_PATH_PATTERN };
    case "record":
      return { $ref: refOf(typeOf(kind.shape)) };
    case "list":
      return { type: "array", items: jsonSchemaOf(kind.items, refOf), maxItems: kind.max };
  }
}

/** The JSON Schema file of one record type. */
export function recordJsonSchema(type: RecordType): JsonObject {
  return { $schema: JSON_SCHEMA_DIALECT, $id: recordSchemaId(type), ...jsonSchemaOf(RECORD_SHAPES[type]) };
}
