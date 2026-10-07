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
  MAX_URL_LENGTH,
  isHttpsUrl,
  isNodeUrl,
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
    case "node-url":
      return unless(isNodeUrl(value));
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
  if (rule.rule === "one-of-when") {
    const held = value[rule.field];
    const allowed = typeof held === "string" && rule.values.includes(held);
    return wanted && present && !allowed ? reject("unknown-value", join(at, rule.field)) : undefined;
  }
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

// The start of an explicit URL. A URL parser gives `http`, `https`, `ws`, `wss` and `ftp`
// an authority whatever slashes follow the colon, even none. Any other scheme has one
// only after two slashes.
const EXPLICIT_URL = /(?<![a-z0-9+.-])(?:(?<special>https?|wss?|ftp):[/\\]*|(?<other>[a-z][a-z0-9+.-]*):\/\/)/giu;
// Where the authority of a URL stops: at the path, the query or the fragment, or where
// the URL itself stops in the file that holds it, at white space, a quote, a backtick or
// an angle bracket. A backslash starts the path only for the five schemes above.
const SPECIAL_AUTHORITY_END = /[/\\?#\s"'`<>]/gu;
const AUTHORITY_END = /[/?#\s"'`<>]/gu;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/**
 * Gives the first place at or after `from` where the pattern matches, or the end of the
 * text. Each call must pass a `from` no smaller than the last, so all the calls together
 * read the text once. The cited lines come from a file that may be hostile.
 */
function finder(text: string, pattern: RegExp): (from: number) => number {
  const search = new RegExp(pattern);
  let found = -1;
  return (from) => {
    if (found < from) {
      search.lastIndex = from;
      found = search.exec(text)?.index ?? text.length;
    }
    return found;
  };
}

// Drops what prose puts after a URL that is not part of it: a full stop, a comma, a closing bracket.
function withoutTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0) {
    const last = text.charCodeAt(end - 1);
    const size = last >= 0xdc00 && last <= 0xdfff && end > 1 ? 2 : 1;
    if (LETTER_OR_DIGIT.test(text.slice(end - size, end))) break;
    end -= size;
  }
  return text.slice(0, end);
}

/** The hostname a URL parser reads from a scheme and an authority, or nothing when it reads none. */
function hostnameOf(scheme: string, authority: string): string | undefined {
  const url = `${scheme}://${withoutTrailingPunctuation(authority)}`;
  if (!URL.canParse(url)) return undefined;
  // A dot after the last label names the same host.
  return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
}

// In prose a name is part of a longer one when a letter, a digit, a hyphen or a dot comes
// before it, or when a letter, a digit, a hyphen or a further label comes after it.
const JOINS_BEFORE = /[\p{L}\p{N}.-]$/u;
const JOINS_AFTER = /^(?:[\p{L}\p{N}-]|\.[\p{L}\p{N}])/u;

/**
 * Whether the hostname appears in the cited bytes as a whole hostname (R2).
 *
 * An explicit URL goes to the platform URL parser, and the hostname the parser reads
 * must be the finding's. So `metrics.example` is not the host of
 * `https://metrics.example@evil.example/` or of `https://evil“metrics.example/`, and no
 * rule here has to say why. A name inside the authority of a URL counts in no other way.
 * An authority longer than a URL may be is not parsed, and no name inside it counts.
 *
 * All other text is prose, and so is the path of a URL. There the name counts unless it
 * is part of a longer name. Letter case is ignored. A port, a full stop that ends a
 * sentence and any other punctuation are allowed.
 *
 * Text with no scheme is prose even when a tool would read it as a URL, so
 * `curl metrics.example,x@evil.example` counts. The check shows that the name is in the
 * cited lines. It does not show where a shell or a program sends data.
 */
function hostAppears(host: string, cited: Uint8Array): boolean {
  const text = new TextDecoder().decode(cited);
  const endOfSpecial = finder(text, SPECIAL_AUTHORITY_END);
  const endOfOther = finder(text, AUTHORITY_END);
  const authorities: (readonly [start: number, end: number])[] = [];
  for (const match of text.matchAll(EXPLICIT_URL)) {
    const special = match.groups?.["special"];
    const from = match.index + match[0].length;
    const end = special === undefined ? endOfOther(from) : endOfSpecial(from);
    if (end - from <= MAX_URL_LENGTH) {
      const scheme = special ?? match.groups?.["other"] ?? "";
      if (hostnameOf(scheme, text.slice(from, end)) === host) return true;
    }
    authorities.push([match.index, end]);
  }
  // Lower-casing ASCII alone keeps every position where it was.
  const lowered = text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  let next = 0;
  let authorityEnd = 0;
  for (let at = lowered.indexOf(host); at >= 0; at = lowered.indexOf(host, at + 1)) {
    // The authorities are in order of their start, so one pass finds whether one holds `at`.
    for (let found = authorities[next]; found !== undefined && found[0] <= at; found = authorities[next]) {
      authorityEnd = Math.max(authorityEnd, found[1]);
      next += 1;
    }
    if (at < authorityEnd) continue;
    const after = at + host.length;
    if (JOINS_BEFORE.test(text.slice(Math.max(0, at - 2), at))) continue;
    if (JOINS_AFTER.test(text.slice(after, after + 3))) continue;
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
