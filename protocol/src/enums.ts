// The closed vocabularies of the protocol (KTD2). A value outside a list is rejected.
// The lists start from Appendix J of the plan.

/** One schema version for the whole protocol (KTD35). Every record and every index response carries it. */
export const SCHEMA_VERSION = "1";

/** The record types of R1. The value is also the folder name in a record's path. */
export const RECORD_TYPES = [
  "claim",
  "finding",
  "re-check",
  "counter-finding",
  "patch",
  "patch-re-check",
  "recipe",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** The shared criteria of R5. The first three are in implication order. The fourth stands apart. */
export const CRITERIA = [
  "safe-to-read",
  "safe-to-run-sandboxed",
  "safe-to-run-with-access",
  "works-as-documented",
] as const;
export type Criterion = (typeof CRITERIA)[number];

/** Observations by family. A finding in the destination family names a host (R4). */
export const OBSERVATION_FAMILIES = {
  destination: ["sends-data-to-host", "fetches-instructions-from-host", "loads-resource-from-host"],
  reach: [
    "network-access-any-host",
    "environment-access-all-variables",
    "reads-outside-workspace",
    "writes-outside-workspace",
  ],
  execution: ["runs-shell-command", "runs-with-permissions-bypassed", "runs-install-script"],
  injection: ["hidden-instruction", "overrides-host-instructions"],
  credentials: ["requests-broad-credential-scope", "stores-credential-in-plain-text"],
  "supply-chain": ["installs-unpinned-dependency"],
  "works-as-documented": ["documented-control-not-read", "fails-on-documented-input"],
} as const;
export type ObservationFamily = keyof typeof OBSERVATION_FAMILIES;

export const DESTINATION_OBSERVATIONS = OBSERVATION_FAMILIES.destination;
export type DestinationObservation = (typeof DESTINATION_OBSERVATIONS)[number];

export const OBSERVATIONS = [
  ...OBSERVATION_FAMILIES.destination,
  ...OBSERVATION_FAMILIES.reach,
  ...OBSERVATION_FAMILIES.execution,
  ...OBSERVATION_FAMILIES.injection,
  ...OBSERVATION_FAMILIES.credentials,
  ...OBSERVATION_FAMILIES["supply-chain"],
  ...OBSERVATION_FAMILIES["works-as-documented"],
] as const;
export type Observation = (typeof OBSERVATIONS)[number];

export const COUNTER_FINDING_REASONS = [
  "documented-behavior",
  "not-present-at-lines",
  "not-reachable",
  "required-by-documented-feature",
] as const;
export type CounterFindingReason = (typeof COUNTER_FINDING_REASONS)[number];

export const PATCH_RECHECK_VERDICTS = ["resolves", "does-not-resolve", "does-more"] as const;
export type PatchRecheckVerdict = (typeof PATCH_RECHECK_VERDICTS)[number];

/** Why a record or a patch is rejected. Rejected work is stored with one of these and nothing else (KTD31). */
export const REJECTION_REASONS = [
  "unknown-field",
  "unknown-value",
  "too-large",
  "bad-path",
  "lines-out-of-range",
  "host-not-in-lines",
  "hash-mismatch",
  "unsupported-version",
  "unknown-component",
  "unresolved-reference",
  "patch-out-of-scope",
  "patch-too-large",
  "wrong-parent",
  "blob-mismatch",
  "bad-mode",
  "patch-incomplete",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const CHECK_KINDS = ["code", "instructions", "permissions"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const CLAIM_KINDS = ["review", "patch"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_INTENTS = ["new", "competing", "adopt"] as const;
export type ClaimIntent = (typeof CLAIM_INTENTS)[number];

/**
 * The model that produced a record. `other` is a model that is not listed.
 * `none` is a record written by a person or a script (R21).
 */
export const MODELS = ["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "other", "none"] as const;
export type Model = (typeof MODELS)[number];

/** A patch's kind, computed from its diff and never declared (KTD5). */
export const PATCH_KINDS = ["removes-only", "adds-or-changes"] as const;
export type PatchKind = (typeof PATCH_KINDS)[number];

/** The modes of a regular file, the only ones a patch may change (KTD6). */
export const FILE_MODES = ["100644", "100755"] as const;
export type FileMode = (typeof FILE_MODES)[number];

export function isFileMode(mode: string): mode is FileMode {
  return (FILE_MODES as readonly string[]).includes(mode);
}

/** Every mode a file listing can hold: regular file, executable, symbolic link, submodule entry. */
export const ENTRY_MODES = [...FILE_MODES, "120000", "160000"] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

/** The fixed marker for a deletion (KTD4): the mode and the hash that Git itself writes for a missing file. */
export const DELETED_MODE = "000000";
export const DELETED_BLOB = "0000000000000000000000000000000000000000";
