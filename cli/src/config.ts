// The command's config file and its keys.
//
// The config file names the team's node, and an index when the team shares through one
// (KTD40). It holds no secret. Keys come from the environment (KTD10, KTD30). The
// command keeps its own files in `.cairnfield/` beside the config file.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { conforms, field, isIndexUrl, isToken } from "@cairnfield/protocol";
import type { Infer } from "@cairnfield/protocol";
import type { Io } from "./io.ts";
import { EXIT, stop } from "./outcome.ts";

const CONFIG_FILE = "cairnfield.json";
/** The key of the team's node, for its admin routes. */
export const ADMIN_KEY = "CAIRNFIELD_ADMIN_KEY";
/** The key an index asks for when a node or a component is registered. */
export const REGISTRATION_KEY = "CAIRNFIELD_REGISTRATION_KEY";

const STATE_FOLDER = ".cairnfield";
const CHECKOUTS_FOLDER = "checkouts";

const MAX_FILE_PATH_LENGTH = 4096;

const CONFIG = field.shape({
  /** The base URL of the team's node, which is the team's identity (KTD8). */
  node: field.nodeUrl(),
  /** The address of an index. A team working alone names none (R38). */
  index: field.optional(field.url()),
  /** The team's lens file (R23), as a path from the config file's folder. */
  lens: field.optional(field.text(MAX_FILE_PATH_LENGTH)),
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
}

/** Reads the config file: the one named on the command line, or `cairnfield.json` in the working folder. */
export async function loadHome(io: Io, named: string | undefined): Promise<Home> {
  const file = resolve(io.cwd, named ?? CONFIG_FILE);
  // A checkout holds a component's own files, under their own names. A config file found
  // there is the component's, and it could name a node of its author's choosing.
  if (file.includes(`${sep}${STATE_FOLDER}${sep}${CHECKOUTS_FOLDER}${sep}`)) return stop(EXIT.usage, "bad-config");
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
  const { index } = config as Config;
  // A route is joined to the index address, so it ends with no slash.
  if (index !== undefined && !isIndexUrl(index)) return stop(EXIT.usage, "bad-config");
  const root = dirname(file);
  const state = join(root, STATE_FOLDER);
  return { config: config as Config, root, outbox: join(state, "outbox"), checkouts: join(state, CHECKOUTS_FOLDER) };
}

/** Reads a key from the environment. It travels in a header, so it must be able to. */
export function keyFrom(io: Io, name: string): string {
  const key = io.env[name];
  return isToken(key) ? key : stop(EXIT.usage, "no-key", { key: name });
}
