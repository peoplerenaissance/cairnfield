// The OpenAPI description of the index routes, derived from the contract shapes
// (R34, KTD35). It describes data only. The two response labels are the only words in it.

import { INDEX_REFUSAL, INDEX_ROUTES, REGISTRATION_KEY_HEADER, RESET_KEY_HEADER } from "./contracts.ts";
import type { Route } from "./contracts.ts";
import { RECORD_TYPES, SCHEMA_VERSION } from "./enums.ts";
import type { RecordType } from "./enums.ts";
import type { ContractFields } from "./fields.ts";
import { JSON_SCHEMA_DIALECT, jsonSchemaOf } from "./json-schema.ts";
import type { JsonObject, JsonValue } from "./json-schema.ts";
import { RECORD_SHAPES } from "./schemas.ts";

const SCHEMAS = "#/components/schemas/";
const recordRef = (type: RecordType): string => `${SCHEMAS}${type}`;

const SECURITY_SCHEMES: { readonly [header: string]: string } = {
  [REGISTRATION_KEY_HEADER]: "registrationKey",
  [RESET_KEY_HEADER]: "resetKey",
};

function parameters(fields: ContractFields | undefined, where: "path" | "query"): JsonObject[] {
  return Object.entries(fields ?? {}).map(([name, field]) => ({
    name,
    in: where,
    required: where === "path" || field.optional !== true,
    schema: jsonSchemaOf(field, recordRef),
  }));
}

function operation(id: string, route: Route): JsonObject {
  const declared = [...parameters(route.params, "path"), ...parameters(route.query, "query")];
  const scheme = route.key === undefined ? undefined : SECURITY_SCHEMES[route.key];
  if (route.key !== undefined && scheme === undefined) throw new Error(`no security scheme for ${route.key}`);
  const content: JsonObject =
    "media" in route.response
      ? { [route.response.media]: {} }
      : { [route.media ?? "application/json"]: { schema: jsonSchemaOf(route.response, recordRef) } };
  return {
    operationId: id,
    ...(declared.length > 0 ? { parameters: declared } : {}),
    ...(scheme === undefined ? {} : { security: [{ [scheme]: [] }] }),
    ...(route.request === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { "application/json": { schema: jsonSchemaOf(route.request, recordRef) } },
          },
        }),
    responses: {
      "200": { description: "ok", content },
      default: {
        description: "refused",
        content: { "application/json": { schema: { $ref: `${SCHEMAS}refusal` } } },
      },
    },
  };
}

/** The OpenAPI 3.1 description of the index routes. */
export function openApiDescription(): JsonObject {
  const paths: { [path: string]: { [method: string]: JsonValue } } = {};
  for (const [id, route] of Object.entries<Route>(INDEX_ROUTES)) {
    const item = (paths[route.path] ??= {});
    item[route.method.toLowerCase()] = operation(id, route);
  }
  const schemas: { [name: string]: JsonValue } = {};
  for (const type of RECORD_TYPES) {
    schemas[type] = jsonSchemaOf(RECORD_SHAPES[type], recordRef);
  }
  schemas["refusal"] = jsonSchemaOf(INDEX_REFUSAL, recordRef);
  return {
    openapi: "3.1.0",
    info: { title: "Cairnfield index", version: SCHEMA_VERSION },
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    paths,
    components: {
      securitySchemes: {
        registrationKey: { type: "apiKey", in: "header", name: REGISTRATION_KEY_HEADER },
        resetKey: { type: "apiKey", in: "header", name: RESET_KEY_HEADER },
      },
      schemas,
    },
  };
}
