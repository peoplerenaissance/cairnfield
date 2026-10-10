// A team's lens (R23, KTD38): the patch level, the teams it names, the patch kinds it
// accepts and whether it publishes recipes. A lens is a local file and is never published.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PATCH_KINDS, conforms, field } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import { amongComponentFiles } from "./config.ts";
import type { Home } from "./config.ts";
import { EXIT, stop } from "./outcome.ts";

/** A lens names at most this many teams. The plan sets no bound, so this is a first value. */
const MAX_LENS_TEAMS = 100;

/**
 * Level 0 takes no patch, level 1 the team's own, and level 2 also those of named teams.
 * A team is named by its node's base URL in the one accepted spelling (KTD8). Only the
 * team's own work and the work of named teams counts for the team.
 */
const LENS = field.shape({
  patchLevel: field.int(0, 2),
  teams: field.listOf(field.nodeUrl(), MAX_LENS_TEAMS),
  patchKinds: field.listOf(field.oneOf(PATCH_KINDS), PATCH_KINDS.length),
  publishRecipes: field.boolean(),
});
export type Lens = Infer<typeof LENS>;

/** Why a lens file is refused. A code, never a sentence. */
const LENS_ERRORS = ["unknown-field", "unknown-value", "too-large", "level-3-not-built"] as const;
export type LensError = (typeof LENS_ERRORS)[number];

export type LensVerdict =
  | { readonly ok: true; readonly lens: Lens }
  | { readonly ok: false; readonly error: LensError; readonly field?: string };

function refuse(error: LensError, at?: string): LensVerdict {
  return at === undefined ? { ok: false, error } : { ok: false, error, field: at };
}

/** Reads the text of a lens file. Every field must be present, so none has a silent default. */
export function parseLens(source: string): LensVerdict {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return refuse("unknown-value");
  }
  // Level 3 also takes a patch that enough organizations stand behind (R41). It is not built.
  if (typeof value === "object" && value !== null && (value as { patchLevel?: unknown }).patchLevel === 3) {
    return refuse("level-3-not-built", "patchLevel");
  }
  const refusal = conforms(LENS, value);
  if (!refusal) return { ok: true, lens: value as Lens };
  const known = (LENS_ERRORS as readonly string[]).includes(refusal.reason);
  return refuse(known ? (refusal.reason as LensError) : "unknown-value", refusal.field);
}

/** Reads the lens file the config names. A command that needs a lens ends without one. */
export async function loadLens(home: Home): Promise<Lens> {
  if (home.config.lens === undefined) return stop(EXIT.usage, "no-lens");
  const file = resolve(home.root, home.config.lens);
  // A lens says whose work counts. One read from a checkout would be the component's own say.
  if (await amongComponentFiles(file)) return stop(EXIT.usage, "bad-lens", { reason: "in-checkout" });
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return stop(EXIT.usage, "no-lens");
  }
  const read = parseLens(text);
  if (!read.ok) return stop(EXIT.usage, "bad-lens", { reason: read.error });
  return read.lens;
}
