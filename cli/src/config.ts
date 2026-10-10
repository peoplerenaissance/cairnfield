// The command's config file and its keys.
//
// The config file names the team's node, and an index when the team shares through one
// (KTD40). It holds no secret. Keys come from the environment (KTD10, KTD30). The
// command keeps its own files in `.cairnfield/` beside the config file.

import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { MODELS, conforms, field, isIndexUrl, isToken } from "@cairnfield/protocol";
import type { Infer, Model } from "@cairnfield/protocol";
import type { Io } from "./io.ts";
import { EXIT, stop } from "./outcome.ts";

const CONFIG_FILE = "cairnfield.json";
/** The key of the team's node, for its admin routes. */
export const ADMIN_KEY = "CAIRNFIELD_ADMIN_KEY";
/** The key an index asks for when a node or a component is registered. */
export const REGISTRATION_KEY = "CAIRNFIELD_REGISTRATION_KEY";

const STATE_FOLDER = ".cairnfield";
const CHECKOUTS_FOLDER = "checkouts";
const COPIES_FOLDER = "copies";

const MAX_FILE_PATH_LENGTH = 4096;

/** The models a bundled agent can run on: the protocol's list without its two values for a model it does not name. */
const AGENT_MODELS = MODELS.filter((model) => model !== "other" && model !== "none");
/** The model a bundled agent runs on when the config names none (KTD21). */
export const DEFAULT_MODEL: Model = "claude-sonnet-5-5";

const CONFIG = field.shape({
  /** The base URL of the team's node, which is the team's identity (KTD8). */
  node: field.nodeUrl(),
  /** The address of an index. A team working alone names none (R38). */
  index: field.optional(field.url()),
  /** The team's lens file (R23), as a path from the config file's folder. */
  lens: field.optional(field.text(MAX_FILE_PATH_LENGTH)),
  /**
   * A label for the team that stays the same wherever its node is deployed. Recordings
   * are kept under it, so a reader's own deployment finds the same ones (KTD18).
   */
  team: field.optional(field.name("repo")),
  /** The folder that holds recordings, as a path from the config file's folder. */
  recordings: field.optional(field.text(MAX_FILE_PATH_LENGTH)),
  /** The model the bundled agents run on (KTD21). */
  model: field.optional(field.oneOf(AGENT_MODELS)),
});
export type Config = Infer<typeof CONFIG>;

/** The config and the folders the command works in. */
export interface Home {
  readonly config: Config;
  /** The folder that holds the config file. */
  readonly root: string;
  /** Where record files wait to be published (KTD20). */
  readonly outbox: string;
  /** Where the checkout of each pinned commit is kept (KTD16). */
  readonly checkouts: string;
  /** Where the copy the team built of each pinned commit is kept (KTD22). */
  readonly copies: string;
  /** Where the patch agent's saved edits are kept (KTD18). */
  readonly recordings: string;
}

/**
 * Whether a file lies in a checkout or in a built copy, by its real path, so a link into
 * one counts too. Both hold a component's own files under their own names, and none of
 * them is the operator's.
 */
export async function inCheckout(file: string): Promise<boolean> {
  let real = file;
  try {
    real = await realpath(file);
  } catch {
    // A file that is not there has no other path.
  }
  return [CHECKOUTS_FOLDER, COPIES_FOLDER].some((folder) => real.includes(`${sep}${STATE_FOLDER}${sep}${folder}${sep}`));
}

/** Reads the config file: the one named on the command line, or `cairnfield.json` in the working folder. */
export async function loadHome(io: Io, named: string | undefined): Promise<Home> {
  const file = resolve(io.cwd, named ?? CONFIG_FILE);
  // A config file found in a checkout is the component's, and it could name a node of its
  // author's choosing.
  if (await inCheckout(file)) return stop(EXIT.usage, "bad-config");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return stop(EXIT.usage, "no-config");
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return stop(EXIT.usage, "bad-config");
  }
  if (conforms(CONFIG, config)) return stop(EXIT.usage, "bad-config");
  const { index, recordings } = config as Config;
  // A route is joined to the index address, so it ends with no slash.
  if (index !== undefined && !isIndexUrl(index)) return stop(EXIT.usage, "bad-config");
  const root = dirname(file);
  const state = join(root, STATE_FOLDER);
  return {
    config: config as Config,
    root,
    outbox: join(state, "outbox"),
    checkouts: join(state, CHECKOUTS_FOLDER),
    copies: join(state, COPIES_FOLDER),
    recordings: resolve(root, recordings ?? join(STATE_FOLDER, "recordings")),
  };
}

/** Reads a key from the environment. It travels in a header, so it must be able to. */
export function keyFrom(io: Io, name: string): string {
  const key = io.env[name];
  return isToken(key) ? key : stop(EXIT.usage, "no-key", { key: name });
}
