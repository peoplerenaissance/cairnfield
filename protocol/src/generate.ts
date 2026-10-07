// The files under `protocol/schemas/`, as text. `scripts/generate-schemas.ts` writes
// them, and a test fails when the committed files differ from this (KTD35).

import { RECORD_TYPES } from "./enums.ts";
import { recordJsonSchema } from "./json-schema.ts";
import type { JsonObject } from "./json-schema.ts";
import { openApiDescription } from "./openapi.ts";

export const OPENAPI_FILE = "openapi.json";

function print(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Each generated file by name: one JSON Schema per record type, and the OpenAPI description. */
export function generatedFiles(): { readonly [name: string]: string } {
  const files: { [name: string]: string } = {};
  for (const type of RECORD_TYPES) {
    files[`${type}.json`] = print(recordJsonSchema(type));
  }
  files[OPENAPI_FILE] = print(openApiDescription());
  return files;
}
