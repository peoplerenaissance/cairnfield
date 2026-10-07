// The seven record types of R1.
//
// Every record is one immutable JSON file (R1). Every field is a record kind (R2).
// Records point backward only (KTD3). A record declares only references: a patch's
// findings and sources, a re-check's target, a recipe's tree hash. Everything else
// about it is computed from content (KTD5). A record does not name its own node.

import {
  CHECK_KINDS,
  CLAIM_INTENTS,
  CLAIM_KINDS,
  COUNTER_FINDING_REASONS,
  CRITERIA,
  DESTINATION_OBSERVATIONS,
  MODELS,
  OBSERVATIONS,
  PATCH_RECHECK_VERDICTS,
  RECORD_TYPES,
} from "./enums.ts";
import type { RecordType } from "./enums.ts";
import { gitHash, hostname, int, object, oneOf, optional, path, setOf, sha256, version } from "./fields.ts";
import type { Infer, ObjectKind } from "./fields.ts";
import {
  MAX_CLAIM_NUMBER,
  MAX_LINE,
  MAX_PATCH_FINDINGS,
  MAX_PATCH_SOURCES,
  MAX_RECIPE_PATCHES,
} from "./limits.ts";

/** A file and a line range in it. Lines count from 1 and the range includes both ends. */
export const LOCATION = object(
  { path: path(), start: int(1, MAX_LINE), end: int(1, MAX_LINE) },
  [{ rule: "ordered", low: "start", high: "end" }],
);
export type Location = Infer<typeof LOCATION>;

// The fields every record carries: the schema version (KTD35), its type, and the
// component, which is a full commit hash (R8).
function common<T extends RecordType>(type: T) {
  return { version: version(), type: oneOf([type]), component: gitHash() };
}

/**
 * A claim says that work has started (R15). A review claim names the kind of check and
 * no file, so the blind pass stays blind. A patch claim names the findings it will fix.
 * `number` differs per run, so two runs give two claims (Appendix H).
 */
export const CLAIM = object(
  {
    ...common("claim"),
    kind: oneOf(CLAIM_KINDS),
    number: int(0, MAX_CLAIM_NUMBER),
    check: optional(oneOf(CHECK_KINDS)),
    findings: optional(setOf(sha256(), 1, MAX_PATCH_FINDINGS)),
    intent: optional(oneOf(CLAIM_INTENTS)),
  },
  [
    { rule: "present-when", field: "check", on: "kind", in: ["review"] },
    { rule: "present-when", field: "findings", on: "kind", in: ["patch"] },
    { rule: "present-when", field: "intent", on: "kind", in: ["patch"] },
  ],
);
export type Claim = Infer<typeof CLAIM>;

/**
 * A finding names a file, a line range, a criterion and an observation at one component
 * commit (R4). A destination finding also names the host. `contradicts` is the one second
 * location: the line this finding contradicts. `claim` closes the claim it cites (KTD3).
 * A finding carries no verdict and never names its patch.
 */
export const FINDING = object(
  {
    ...common("finding"),
    location: LOCATION,
    criterion: oneOf(CRITERIA),
    observation: oneOf(OBSERVATIONS),
    host: optional(hostname()),
    contradicts: optional(LOCATION),
    check: oneOf(CHECK_KINDS),
    model: oneOf(MODELS),
    claim: optional(sha256()),
  },
  [{ rule: "present-when", field: "host", on: "observation", in: DESTINATION_OBSERVATIONS }],
);
export type Finding = Infer<typeof FINDING>;

/** A re-check confirms the finding it names. A dispute is a counter-finding. */
export const RECHECK = object({
  ...common("re-check"),
  finding: sha256(),
  model: oneOf(MODELS),
});
export type Recheck = Infer<typeof RECHECK>;

/** A counter-finding disputes the finding it names, with a reason and at most one cited location. */
export const COUNTER_FINDING = object({
  ...common("counter-finding"),
  finding: sha256(),
  reason: oneOf(COUNTER_FINDING_REASONS),
  cites: optional(LOCATION),
  model: oneOf(MODELS),
});
export type CounterFinding = Infer<typeof COUNTER_FINDING>;

/**
 * A patch record announces one patch commit (R24). It names the commit by hash, the
 * findings it is tied to and, for a merged patch, its source patch IDs (KTD4).
 * It does not declare its patch ID, kind or size. Those are computed (KTD5).
 */
export const PATCH = object({
  ...common("patch"),
  commit: gitHash(),
  findings: setOf(sha256(), 1, MAX_PATCH_FINDINGS),
  sources: optional(setOf(sha256(), 2, MAX_PATCH_SOURCES)),
  claim: optional(sha256()),
  model: oneOf(MODELS),
});
export type Patch = Infer<typeof PATCH>;

/** A patch re-check targets a patch ID, because confirmations are counted per patch identity (R24). */
export const PATCH_RECHECK = object({
  ...common("patch-re-check"),
  patch: sha256(),
  verdict: oneOf(PATCH_RECHECK_VERDICTS),
  model: oneOf(MODELS),
});
export type PatchRecheck = Infer<typeof PATCH_RECHECK>;

/**
 * A recipe is the pinned commit, a set of patch IDs and the file-tree hash of the result (R25).
 * The tree hash is published, not checked (KTD5).
 */
export const RECIPE = object({
  ...common("recipe"),
  patches: setOf(sha256(), 1, MAX_RECIPE_PATCHES),
  tree: gitHash(),
});
export type Recipe = Infer<typeof RECIPE>;

export type AnyRecord = Claim | Finding | Recheck | CounterFinding | Patch | PatchRecheck | Recipe;

export const RECORD_SHAPES = {
  claim: CLAIM,
  finding: FINDING,
  "re-check": RECHECK,
  "counter-finding": COUNTER_FINDING,
  patch: PATCH,
  "patch-re-check": PATCH_RECHECK,
  recipe: RECIPE,
} as const satisfies { readonly [T in RecordType]: ObjectKind };

/** A record's path in a team repo: `records/<component-commit>/<type>/<id>.json` (KTD1). */
export const RECORD_PATH_PATTERN = `^records/([0-9a-f]{40})/(${RECORD_TYPES.join("|")})/([0-9a-f]{64})\\.json$`;
