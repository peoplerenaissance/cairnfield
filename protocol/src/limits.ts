// Limits of the protocol (KTD6). Every size and every name rule lives here.
// The patterns are also written into the JSON Schema files, so the two cannot differ.

/** A hostname has at most 253 characters. */
export const MAX_HOSTNAME_LENGTH = 253;
/** A patch holds at most 3 replacements. A replacement counts once, however many copies it rewrites. */
export const MAX_PATCH_REPLACEMENTS = 3;
/** A patch changes at most 60 lines: lines removed plus lines added. */
export const MAX_PATCH_LINES = 60;
/** A path has at most 200 characters. */
export const MAX_PATH_LENGTH = 200;
/** A record has at most 4 KB. */
export const MAX_RECORD_BYTES = 4096;
/** A node listing has at most 5,000 entries. */
export const MAX_LISTING_ENTRIES = 5000;
/** A node listing has at most 500 records per component. */
export const MAX_RECORDS_PER_COMPONENT = 500;
/** A served blob has at most 256 KB. */
export const MAX_BLOB_BYTES = 256 * 1024;
/** A fetch from another team's fork brings in at most 16 MB of objects. */
export const MAX_FETCH_BYTES = 16 * 1024 * 1024;

/** A repo or fork name has at most 100 characters. The plan sets no length, so this is a first value. */
export const MAX_REPO_NAME_LENGTH = 100;
export const MIN_NAMESPACE_NAME_LENGTH = 2;
export const MAX_NAMESPACE_NAME_LENGTH = 63;
/** A branch name has at most 200 characters. The plan sets no length, so this is a first value. */
export const MAX_BRANCH_NAME_LENGTH = 200;

/** Two organizations make a finding or a patch confirmed (R10, R24). */
export const CONFIRMED_AT = 2;

/** A line number is at most this. The plan sets no bound, so this is a first value. */
export const MAX_LINE = 1_000_000;
/** A claim's run number is at most this (Appendix H). */
export const MAX_CLAIM_NUMBER = 4_294_967_295;
/** A patch record cites at most this many findings. */
export const MAX_PATCH_FINDINGS = 8;
/** A merged patch lists at most this many sources. */
export const MAX_PATCH_SOURCES = 4;
/** A recipe lists at most this many patches. */
export const MAX_RECIPE_PATCHES = 32;

/** A commit, a tree and a blob: 40 lower-case hexadecimal characters, the only form the binding reads. */
export const GIT_HASH_PATTERN = "^[0-9a-f]{40}$";
/** A record ID and a patch ID: a SHA-256 in lower-case hexadecimal. */
export const SHA256_PATTERN = "^[0-9a-f]{64}$";
/** Starts with a lower-case letter or a digit, then lower-case letters, digits, dots, underscores or hyphens. */
export const NAME_PATTERN = "^[a-z0-9][a-z0-9._-]*$";
/** Letters, digits, dots, underscores, hyphens and slashes. Never starts with a hyphen. No empty part and no `..`. */
export const BRANCH_NAME_PATTERN = "^(?!-)(?!.*\\.\\.)[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$";

const PATH_PART = "(?!-)(?!\\.{1,2}(?:/|$))(?!\\.[Gg][Ii][Tt](?:/|$))[A-Za-z0-9._-]+";
/**
 * A relative path. Each part holds letters, digits, dots, underscores or hyphens. No part
 * starts with a hyphen, which a command reads as an option, and none is `.`, `..` or
 * `.git` in any letter case (KTD33).
 */
export const PATH_PATTERN = `^${PATH_PART}(?:/${PATH_PART})*$`;

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Labels of lower-case letters, digits and hyphens, joined by dots. No label starts or ends with a hyphen. */
export const HOSTNAME_PATTERN = `^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`;

/** A URL in a request or response has at most 2,048 characters. */
export const MAX_URL_LENGTH = 2048;
/** Lower-case `https://`, then no userinfo, no whitespace and no backslash. */
export const URL_PATTERN = "^https://(?![^/?#]*@)[^\\s\\\\]+$";
/** An opaque token: 1 to 512 printable ASCII characters with no space. */
export const MAX_TOKEN_LENGTH = 512;
export const TOKEN_PATTERN = `^[!-~]{1,${MAX_TOKEN_LENGTH}}$`;

function matches(pattern: string, maxLength: number): (value: unknown) => value is string {
  const expression = new RegExp(pattern);
  return (value: unknown): value is string =>
    typeof value === "string" && value.length <= maxLength && expression.test(value);
}

export const isGitHash = matches(GIT_HASH_PATTERN, 40);
/** A component is its full commit hash (R8). */
export const isCommit = isGitHash;
export const isSha256 = matches(SHA256_PATTERN, 64);
export const isRepoName = matches(NAME_PATTERN, MAX_REPO_NAME_LENGTH);
export const isBranchName = matches(BRANCH_NAME_PATTERN, MAX_BRANCH_NAME_LENGTH);
export const isPath = matches(PATH_PATTERN, MAX_PATH_LENGTH);
export const isHostname = matches(HOSTNAME_PATTERN, MAX_HOSTNAME_LENGTH);
export const isToken = matches(TOKEN_PATTERN, MAX_TOKEN_LENGTH);

const matchesUrlPattern = matches(URL_PATTERN, MAX_URL_LENGTH);

/**
 * An HTTPS URL with no credentials, in serialized form (KTD12). It is the rule for a Git
 * URL and for a link. An upper-case host or a default port is refused, and a bare origin
 * may leave out its last slash. A node's base URL has the stricter rule of `isNodeUrl`.
 */
export function isHttpsUrl(value: unknown): value is string {
  if (!matchesUrlPattern(value) || !URL.canParse(value)) return false;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return false;
  return parsed.href === value || parsed.href === `${value}/`;
}

const NODE_PATH_PART = "[a-z0-9][a-z0-9._-]*";
// A label that starts with `xn--` is Punycode. A URL parser refuses one it cannot decode,
// which a pattern cannot tell, so a node hostname holds none.
const NODE_HOST_LABEL = `(?!xn--)${HOST_LABEL}`;
// A last label that a URL parser reads as a number, which makes the host an address.
// The parser rewrites an address, so `127.1` and `0x7f.1` are two spellings of `127.0.0.1`.
const NUMBER_LABEL = "(?:[0-9]+|0x[0-9a-f]*)";
// 1 to 65535 with no zero in front, and never 443, which a URL parser drops.
const NODE_PORT =
  "(?!443(?:/|$))(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
/**
 * A node's base URL in its one accepted spelling (KTD8): lower-case `https://`, a
 * hostname of at most 253 characters that is not an address and holds no Punycode label,
 * a port, and a path for a node that lives under one.
 * Each path part starts with a lower-case letter or a digit and continues with lower-case
 * letters, digits, dots, underscores or hyphens. No credentials, query, fragment, percent
 * sign or last slash. The pattern states the whole rule, so a JSON Schema validator
 * admits no second spelling either.
 */
export const NODE_URL_PATTERN = `^https://(?=[a-z0-9.-]{1,${MAX_HOSTNAME_LENGTH}}(?:[:/]|$))(?:${NODE_HOST_LABEL}\\.)*(?!${NUMBER_LABEL}(?:[:/]|$))${NODE_HOST_LABEL}(?::${NODE_PORT})?(?:/${NODE_PATH_PART})*$`;

const matchesNodeUrlPattern = matches(NODE_URL_PATTERN, MAX_URL_LENGTH);

/**
 * A node's base URL, which is the node's identity (KTD8). Organizations are counted by
 * this string, so it has one spelling and every other one is refused, never rewritten.
 * The pattern states the whole rule, and a test holds it to this function's verdict. The
 * serialized form stays as a second check.
 */
export function isNodeUrl(value: unknown): value is string {
  if (!matchesNodeUrlPattern(value) || !URL.canParse(value)) return false;
  const { href } = new URL(value);
  return href === value || href === `${value}/`;
}

const isName = matches(NAME_PATTERN, MAX_NAMESPACE_NAME_LENGTH);

export function isNamespaceName(value: unknown): value is string {
  return isName(value) && value.length >= MIN_NAMESPACE_NAME_LENGTH;
}
