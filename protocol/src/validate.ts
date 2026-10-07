// Validation in two layers (R3). Layer 1 is structure and limits, and needs nothing but
// the record. Layer 2 checks a record against file content that the caller supplies.
// A rejection carries a reason from the closed list and never prose.

import { recordId } from "./canonical.ts";
import { SCHEMA_VERSION, isFileMode } from "./enums.ts";
import type { RecordType, RejectionReason } from "./enums.ts";
import type { ContractKind, NameKind, ObjectKind, Rule, SetKind, ShapeKind } from "./fields.ts";
import {
  MAX_RECORD_BYTES,
  isBranchName,
  isGitHash,
  isHostname,
  isHttpsUrl,
  isNamespaceName,
  isPath,
  isRepoName,
  isSha256,
  isToken,
} from "./limits.ts";
import { linesOf } from "./lines.ts";
import { RECORD_PATH_PATTERN, RECORD_SHAPES } from "./schemas.ts";
import type { AnyRecord, Location } from "./schemas.ts";

/**
 * Why a value was refused. `field` names a declared field, such as `location.start`.
 * It never holds text from the refused value, so an unknown field's name is not returned.
 */
export interface Rejection {
  readonly ok: false;
  readonly reason: RejectionReason;
  readonly field?: string;
}

export type RecordVerdict = { readonly ok: true; readonly record: AnyRecord } | Rejection;
export type RecordFileVerdict = { readonly ok: true; readonly record: AnyRecord; readonly id: string } | Rejection;

function reject(reason: RejectionReason, field = ""): Rejection {
  return field === "" ? { ok: false, reason } : { ok: false, reason, field };
}

type Members = { readonly [key: string]: unknown };

function isPlainObject(value: unknown): value is Members {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isName(of: NameKind["of"], value: unknown): boolean {
  if (of === "repo") return isRepoName(value);
  if (of === "namespace") return isNamespaceName(value);
  return isBranchName(value);
}

function join(at: string, name: string): string {
  return at === "" ? name : `${at}.${name}`;
}

// The one checker behind records and contract bodies. `at` is the declared field path so far.
function check(kind: ContractKind, value: unknown, at: string): Rejection | undefined {
  const unless = (accepted: boolean, reason: RejectionReason = "unknown-value"): Rejection | undefined =>
    accepted ? undefined : reject(reason, at);

  switch (kind.kind) {
    case "version":
      return unless(value === SCHEMA_VERSION, "unsupported-version");
    case "enum":
      return unless(typeof value === "string" && kind.values.includes(value));
    case "sha256":
      return unless(isSha256(value));
    case "git-hash":
      return unless(isGitHash(value));
    case "int":
      return unless(typeof value === "number" && Number.isInteger(value) && value >= kind.min && value <= kind.max);
    case "path":
      return unless(isPath(value), "bad-path");
    case "hostname":
      return unless(isHostname(value));
    case "set":
      return checkSet(kind, value, at);
    case "object":
      return checkObject(kind, value, at);
    case "url":
      return unless(isHttpsUrl(value));
    case "token":
      return unless(isToken(value));
    case "text":
      if (typeof value !== "string") return reject("unknown-value", at);
      return unless(value.length <= kind.max, "too-large");
    case "boolean":
      return unless(typeof value === "boolean");
    case "name":
      return unless(isName(kind.of, value));
    case "record-path":
      return unless(parseRecordPath(value) !== undefined, "bad-path");
    case "record": {
      const verdict = validateRecord(value);
      if (!verdict.ok) return reject(verdict.reason, at);
      return unless(RECORD_SHAPES[verdict.record.type] === kind.shape);
    }
    case "list": {
      if (!Array.isArray(value)) return reject("unknown-value", at);
      if (value.length > kind.max) return reject("too-large", at);
      for (const item of value as readonly unknown[]) {
        const failure = check(kind.items, item, at);
        if (failure) return failure;
      }
      return undefined;
    }
    default: {
      // A kind this checker does not know is refused, never accepted.
      const unknown: never = kind;
      void unknown;
      return reject("unknown-value", at);
    }
  }
}

function checkSet(kind: SetKind, value: unknown, at: string): Rejection | undefined {
  if (!Array.isArray(value)) return reject("unknown-value", at);
  const items = value as readonly unknown[];
  if (items.length > kind.max) return reject("too-large", at);
  if (items.length < kind.min) return reject("unknown-value", at);
  let previous: string | undefined;
  for (const item of items) {
    const failure = check(kind.items, item, at);
    if (failure) return failure;
    // Each item kind is a string kind, so the comparison is on strings.
    const current = item as string;
    if (previous !== undefined && current <= previous) return reject("unknown-value", at);
    previous = current;
  }
  return undefined;
}

function checkObject(kind: ObjectKind | ShapeKind, value: unknown, at: string): Rejection | undefined {
  if (!isPlainObject(value)) return reject("unknown-value", at);
  // The version comes before the other fields, so a body of a later version is not read as an unknown field.
  for (const [name, field] of Object.entries(kind.fields)) {
    if (field.kind !== "version") continue;
    const failure = check(field, value[name], join(at, name));
    if (failure) return failure;
  }
  for (const key of Object.keys(value)) {
    // The key is text from the value, so only the object that holds it is named.
    if (!Object.hasOwn(kind.fields, key)) return reject("unknown-field", at);
  }
  for (const [name, field] of Object.entries(kind.fields)) {
    if (!Object.hasOwn(value, name)) {
      if (field.optional !== true) return reject("unknown-value", join(at, name));
      continue;
    }
    const failure = check(field, value[name], join(at, name));
    if (failure) return failure;
  }
  for (const rule of kind.rules) {
    const failure = checkRule(rule, value, at);
    if (failure) return failure;
  }
  return undefined;
}

function checkRule(rule: Rule, value: Members, at: string): Rejection | undefined {
  if (rule.rule === "ordered") {
    const low = value[rule.low];
    const high = value[rule.high];
    if (typeof low === "number" && typeof high === "number" && low > high) {
      return reject("lines-out-of-range", at);
    }
    return undefined;
  }
  const on = value[rule.on];
  const wanted = typeof on === "string" && rule.in.includes(on);
  const present = Object.hasOwn(value, rule.field);
  if (wanted && !present) return reject("unknown-value", join(at, rule.field));
  if (!wanted && present) return reject("unknown-field", join(at, rule.field));
  return undefined;
}

/** Checks a request or response body against a contract shape. */
export function conforms(kind: ContractKind, value: unknown): Rejection | undefined {
  return check(kind, value, "");
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Layer 1: structure and limits (R2, KTD6). Size is checked first, then the schema
 * version, then the fields of the record's type.
 */
export function validateRecord(value: unknown): RecordVerdict {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return reject("unknown-value");
  }
  if (typeof json !== "string") return reject("unknown-value");
  if (json.length > MAX_RECORD_BYTES || byteLength(json) > MAX_RECORD_BYTES) return reject("too-large");
  if (!isPlainObject(value)) return reject("unknown-value");
  // The version comes before the type, so a record type of a later version is not read as an unknown value.
  if (value["version"] !== SCHEMA_VERSION) return reject("unsupported-version", "version");
  const type = value["type"];
  if (typeof type !== "string" || !Object.hasOwn(RECORD_SHAPES, type)) return reject("unknown-value", "type");
  const failure = check(RECORD_SHAPES[type as RecordType], value, "");
  if (failure) return failure;
  return { ok: true, record: value as unknown as AnyRecord };
}

const JSON_WHITESPACE = /[ \t\n\r]/g;

/**
 * Layer 1 for a record as text or bytes. The text must hold the record and nothing else:
 * a repeated key, an escape or an exponent is refused, because a repeated key could
 * hide free text behind a valid value. Whitespace and key order are free.
 */
export function validateRecordText(source: string | Uint8Array): RecordVerdict {
  if (source.length > MAX_RECORD_BYTES) return reject("too-large");
  let text: string;
  if (typeof source === "string") {
    if (byteLength(source) > MAX_RECORD_BYTES) return reject("too-large");
    text = source;
  } else {
    try {
      // A byte order mark is kept, so JSON parsing refuses it as it does in a string.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
    } catch {
      return reject("unknown-value");
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return reject("unknown-value");
  }
  const verdict = validateRecord(value);
  if (!verdict.ok) return verdict;
  // A valid record holds no whitespace and needs no escape, so this comparison is exact.
  if (JSON.stringify(value) !== text.replace(JSON_WHITESPACE, "")) return reject("unknown-field");
  return verdict;
}

const RECORD_PATH = new RegExp(RECORD_PATH_PATTERN);

/** The path of a record file in a team repo (KTD1). */
export function recordPath(record: Pick<AnyRecord, "component" | "type">, id: string): string {
  return `records/${record.component}/${record.type}/${id}.json`;
}

/** Reads a record path. Returns nothing for any other shape, so no text from a bad path travels on (KTD31). */
export function parseRecordPath(
  path: unknown,
): { readonly component: string; readonly type: RecordType; readonly id: string } | undefined {
  if (typeof path !== "string") return undefined;
  const match = RECORD_PATH.exec(path);
  if (!match) return undefined;
  const [, component, type, id] = match;
  if (component === undefined || type === undefined || id === undefined) return undefined;
  return { component, type: type as RecordType, id };
}

/**
 * Layer 1 for a record file (KTD1): the path's shape, the content, and then that the file
 * name is the hash of the content and the folders match the record's component and type.
 */
export async function validateRecordFile(path: string, content: Uint8Array): Promise<RecordFileVerdict> {
  const at = parseRecordPath(path);
  if (!at) return reject("bad-path");
  const verdict = validateRecordText(content);
  if (!verdict.ok) return verdict;
  const { record } = verdict;
  const id = await recordId(record);
  if (id !== at.id || record.component !== at.component || record.type !== at.type) {
    return reject("hash-mismatch");
  }
  return { ok: true, record, id };
}

/** One file of the pinned copy, as layer 2 needs it. */
export interface CitedFile {
  readonly mode: string;
  readonly content: Uint8Array;
}

/** The files a record cites, by path. A path that is missing here is not in the pinned copy. */
export type CitedFiles = ReadonlyMap<string, CitedFile>;

function locationsOf(record: AnyRecord): (readonly [field: string, location: Location])[] {
  if (record.type === "finding") {
    const first = ["location", record.location] as const;
    return record.contradicts ? [first, ["contradicts", record.contradicts]] : [first];
  }
  if (record.type === "counter-finding" && record.cites) return [["cites", record.cites]];
  return [];
}

/** The paths the caller must supply to `validateAgainstFiles` for this record. */
export function citedPaths(record: AnyRecord): string[] {
  return [...new Set(locationsOf(record).map(([, location]) => location.path))];
}

const PERCENT = 37;
const HYPHEN = 45;
const DOT = 46;
const COLON = 58;
const AT = 64;
const UNDERSCORE = 95;

function lower(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

/**
 * Whether a URL parser reads the byte as part of a hostname: a letter, a digit, a hyphen,
 * an underscore, a percent sign, or any byte outside ASCII.
 */
function isHostnameByte(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  const b = lower(byte);
  if ((b >= 97 && b <= 122) || (b >= 48 && b <= 57)) return true;
  return byte === HYPHEN || byte === UNDERSCORE || byte === PERCENT || byte >= 0x80;
}

/**
 * Whether the hostname appears in the cited bytes as a whole hostname. Letter case in the
 * file is ignored. A match inside a longer hostname does not count, so `metrics.example`
 * is not found in `collect.metrics.example` or in `metrics.example_.evil.example`. A match
 * before `@` or before `:password@` does not count either, because it is userinfo. A
 * port and a full stop that ends a sentence are allowed.
 */
// The bytes that end the authority part of a URL, or the URL itself: white space, a
// quote, a hash, a slash, an angle bracket, a question mark or a backtick.
const AUTHORITY_END = new Set([34, 35, 39, 47, 60, 62, 63, 96]);

/**
 * Whether the bytes from `from` reach an at sign before the authority ends. A hostname
 * in front of `:password@` is userinfo, and the real host comes after the at sign.
 */
function reachesAtSign(cited: Uint8Array, from: number): boolean {
  for (let i = from; i < cited.length; i++) {
    const byte = cited[i] ?? 0;
    if (byte === AT) return true;
    if (byte <= 0x20 || AUTHORITY_END.has(byte)) return false;
  }
  return false;
}

function hostAppears(host: string, cited: Uint8Array): boolean {
  const wanted = new TextEncoder().encode(host);
  search: for (let at = 0; at + wanted.length <= cited.length; at++) {
    for (let i = 0; i < wanted.length; i++) {
      if (lower(cited[at + i] ?? 0) !== wanted[i]) continue search;
    }
    const before = at > 0 ? cited[at - 1] : undefined;
    if (before === DOT || isHostnameByte(before)) continue;
    const after = cited[at + wanted.length];
    if (after === AT || isHostnameByte(after)) continue;
    if (after === DOT && isHostnameByte(cited[at + wanted.length + 1])) continue;
    if (after === COLON && reachesAtSign(cited, at + wanted.length + 1)) continue;
    return true;
  }
  return false;
}

/**
 * Layer 2: checks a record that passed layer 1 against the pinned copy. A cited path must
 * be a regular file in the copy, a line range must be within its file, and a finding's
 * hostname must appear in the lines the finding cites (R2, R9).
 */
export function validateAgainstFiles(record: AnyRecord, files: CitedFiles): RecordVerdict {
  for (const [field, location] of locationsOf(record)) {
    const file = files.get(location.path);
    if (!file || !isFileMode(file.mode)) return reject("bad-path", field);
    const cited = linesOf(file.content, location.start, location.end);
    if (!cited) return reject("lines-out-of-range", field);
    if (record.type === "finding" && field === "location" && record.host !== undefined) {
      if (!hostAppears(record.host, cited)) return reject("host-not-in-lines", "host");
    }
  }
  return { ok: true, record };
}
