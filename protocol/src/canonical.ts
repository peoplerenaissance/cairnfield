// Canonical JSON and the record ID (KTD1).
//
// Canonical JSON here means: object keys sorted by UTF-16 code unit, no whitespace,
// integers only, strings escaped as `JSON.stringify` escapes them, encoded as UTF-8.
// Arrays keep their order. Two records with the same fields then have the same bytes.

import { sha256Hex } from "./hash.ts";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError("canonical JSON holds integers only");
      }
      return String(value);
    case "object":
      return Array.isArray(value) ? canonicalArray(value) : canonicalObject(value);
    default:
      throw new TypeError(`canonical JSON cannot hold a ${typeof value}`);
  }
}

function canonicalArray(items: readonly unknown[]): string {
  const parts: string[] = [];
  // An index loop, so a hole in the array is refused and not skipped.
  for (let i = 0; i < items.length; i++) {
    parts.push(canonicalJson(items[i]));
  }
  return `[${parts.join(",")}]`;
}

function canonicalObject(value: object): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical JSON holds plain objects only");
  }
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const member: unknown = (value as { readonly [key: string]: unknown })[key];
    parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${parts.join(",")}}`;
}

/** A record's ID: the SHA-256 of its canonical JSON, in lower-case hexadecimal. */
export async function recordId(record: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(record)));
}
