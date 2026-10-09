// What the Worker is given: its bindings, two plain variables and one secret.

import type { Store } from "./artifacts.ts";
import type { ReadTokens } from "./read-tokens.ts";

export interface Env {
  /** The team's own Artifacts namespace (R6, KTD9). */
  readonly ARTIFACTS: Store;
  /** The one read token kept per fork, in an object named after the fork (KTD7). */
  readonly READ_TOKENS: DurableObjectNamespace<ReadTokens>;
  /** The node's own base URL, which is its identity (KTD8). */
  readonly NODE_URL: string;
  /** The index address, with no slash at its end. A node with none sends no notice (KTD40). */
  readonly INDEX_URL?: string;
  /** The admin key, set by the developer as a secret. A node with none refuses every admin call (KTD10). */
  readonly ADMIN_KEY?: string;
}

// `wrangler types` writes the bindings of the Wrangler config as `Cloudflare.Env`. They
// must fit the interface above, or this line fails the type check.
type Fits<Configured extends Env> = Configured;
export type ConfiguredEnv = Fits<Cloudflare.Env>;
