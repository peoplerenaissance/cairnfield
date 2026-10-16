// What the index says of itself to a crawler or a tool, apart from its data (R34, R35).
// Each answer here is fixed in the code or derived from the protocol library, so an index
// serves it with no setting, and none tells an agent what to do.
//
// `/robots.txt` says that every crawler may read every path. Without it a zone in front
// of the index may serve a file of comments alone, which a crawler reads as no file. The
// API catalog (RFC 9727) is a link set from the index's own address to the OpenAPI
// description of its routes and to the JSON Schema of each record type. The description
// and the schemas are the files of `protocol/schemas/`, built from the library at the
// first request and kept for the life of the isolate.

import { INDEX_ROUTES, LINK_TYPES, OPENAPI_FILE, RECORD_TYPES, generatedFiles } from "@cairnfield/protocol";
import type { ApiCatalog, RecordType } from "@cairnfield/protocol";

export const ROBOTS_PATH = "/robots.txt";

/** The rules for a crawler: every path may be read, and a page may be searched and given to a model as input. */
export const ROBOTS = ["User-agent: *", "Allow: /", "", "Content-Signal: search=yes, ai-input=yes", ""].join("\n");

/** The path of a record type's schema, from the route's pattern. */
export const schemaPath = (type: RecordType): string => INDEX_ROUTES.schema.path.replace("{type}", type);

const SCHEMA_PATH = /^\/schemas\/([a-z-]+)\.json$/;

/** The record type whose schema a path names, or nothing. */
export function schemaTypeOf(path: string): RecordType | undefined {
  const named = SCHEMA_PATH.exec(path)?.[1];
  return RECORD_TYPES.find((type) => type === named && schemaPath(type) === path);
}

let files: { readonly [name: string]: string } | undefined;
const generated = (): { readonly [name: string]: string } => (files ??= generatedFiles());

/** The OpenAPI description of the index routes, as `protocol/schemas/openapi.json` holds it. */
export const description = (): string => generated()[OPENAPI_FILE] ?? "";

/** The JSON Schema of a record type, as `protocol/schemas/<type>.json` holds it. */
export const schema = (type: RecordType): string => generated()[`${type}.json`] ?? "";

/** The `link` header that names the catalog (RFC 9727). A page's answer carries it, and so does the catalog's own, to a `HEAD` as to a `GET`. */
export const CATALOG_LINK = `<${INDEX_ROUTES.catalog.path}>; rel="api-catalog"`;

/**
 * The API catalog of the index at `origin`, which is the address the request was made
 * to. Its first context is the catalog, whose one item is the index's API at its own
 * address. Its second is that API: its OpenAPI description, and the schema of each
 * record type.
 */
export function catalog(origin: string): ApiCatalog {
  const at = (path: string): string => new URL(path, origin).href;
  const [openapi, jsonSchema] = LINK_TYPES;
  return {
    linkset: [
      { anchor: at(INDEX_ROUTES.catalog.path), item: [{ href: at("/") }] },
      {
        anchor: at("/"),
        "service-desc": [{ href: at(INDEX_ROUTES.description.path), type: openapi }],
        describedby: RECORD_TYPES.map((type) => ({ href: at(schemaPath(type)), type: jsonSchema })),
      },
    ],
  };
}
