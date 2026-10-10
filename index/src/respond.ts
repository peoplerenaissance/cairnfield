// What the index answers. Every JSON body carries the schema version (R35, KTD35), and a
// refusal is a code from the protocol's closed list, never a sentence.

import { SCHEMA_VERSION } from "@cairnfield/protocol";
import type { IndexRefusal } from "@cairnfield/protocol";

export type IndexError = IndexRefusal["error"];

// The contract names the codes and no status, so the statuses are a choice made here.
const STATUS: { readonly [E in IndexError]: number } = {
  "bad-request": 400,
  unauthorized: 401,
  "not-allowed": 403,
  "limit-reached": 403,
  "not-found": 404,
  "already-registered": 409,
};

export function refusal(error: IndexError): Response {
  return Response.json({ version: SCHEMA_VERSION, error } satisfies IndexRefusal, { status: STATUS[error] });
}

export function answer(body: object): Response {
  return Response.json({ version: SCHEMA_VERSION, ...body });
}
