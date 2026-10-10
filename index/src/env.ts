// What the Worker is given: its bindings, four plain variables and two secrets.

import type { Store } from "./artifacts.ts";
import type { Message } from "./queue.ts";

export interface Env {
  /** The index's own Artifacts namespace, which holds its component copies (R9, KTD12). */
  readonly ARTIFACTS: Store;
  readonly DB: D1Database;
  /** The queue that carries push notices and the checks on a copy that is importing (KTD11). */
  readonly SYNC: Pick<Queue<Message>, "send" | "sendBatch">;
  /** The Git URLs this index may import, with a space between two (KTD30). */
  readonly GIT_URLS: string;
  /** How long a claim stays live after the index receives it, in seconds (KTD15). */
  readonly CLAIM_TTL_SECONDS: string;
  /** The most nodes and the most components that can be registered (KTD30). */
  readonly MAX_NODES: string;
  readonly MAX_COMPONENTS: string;
  /** Set by the developer as a secret. An index with none refuses every registration (KTD30). */
  readonly REGISTRATION_KEY?: string;
  /** Set by the developer as a secret. An index with none refuses every reset (KTD30). */
  readonly RESET_KEY?: string;
}

// `wrangler types` writes the bindings of the Wrangler config as `Cloudflare.Env`. They
// must fit the interface above, or this line fails the type check.
type Fits<Configured extends Env> = Configured;
export type ConfiguredEnv = Fits<Cloudflare.Env>;

/** A whole number from a variable. Any other value reads as `otherwise`. */
function count(value: string, otherwise: number): number {
  return /^[0-9]{1,9}$/.test(value) ? Number(value) : otherwise;
}

/** The Git URLs on the allow-list. A URL holds no white space, so white space parts two. */
export const allowedGitUrls = (env: Env): string[] => env.GIT_URLS.split(/\s+/).filter((url) => url !== "");
/** A cap that cannot be read refuses every registration. */
export const maxNodes = (env: Env): number => count(env.MAX_NODES, 0);
export const maxComponents = (env: Env): number => count(env.MAX_COMPONENTS, 0);
/** The default of KTD15 is 15 minutes. */
export const claimTtlMs = (env: Env): number => count(env.CLAIM_TTL_SECONDS, 15 * 60) * 1000;
