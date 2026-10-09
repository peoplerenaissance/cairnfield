// The one read token kept per fork (KTD7). A Durable Object named after the fork holds
// it. The object takes one call at a time, so of many requests that arrive together only
// the first mints a token and the others are given that one. That is what keeps the
// public route from minting without bound.

import { DurableObject } from "cloudflare:workers";
import type { Unavailable } from "./artifacts.ts";
import type { RepoToken } from "./contract.ts";

/** A kept token is not served in its last minutes, so a reader has time to use it. */
const KEPT_TOKEN_MARGIN = 5 * 60;
const KEPT = "token";

export class ReadTokens extends DurableObject {
  /**
   * The kept token, or the one `mint` makes when none is kept or the kept one is about
   * to expire. `mint` runs in the Worker that asks, which holds the Artifacts binding.
   * When `mint` gives a refusal, that is passed on and nothing is kept. When `mint`
   * throws, this call and every call waiting behind it fail with it, and the next call
   * starts afresh, so a failing Artifacts is asked once for the whole burst.
   */
  async tokenOr(mint: () => Promise<RepoToken | Unavailable>): Promise<RepoToken | Unavailable> {
    // No other call is taken until this one has looked, minted and stored.
    return this.ctx.blockConcurrencyWhile(async () => {
      const kept = await this.ctx.storage.get<RepoToken>(KEPT);
      if (kept && kept.expires - KEPT_TOKEN_MARGIN > Date.now() / 1000) return kept;
      const minted = await mint();
      if (typeof minted !== "string") await this.ctx.storage.put(KEPT, minted);
      return minted;
    });
  }

  /** Forgets the kept token. A fork that is made anew has none of the old fork's tokens. */
  async forget(): Promise<void> {
    await this.ctx.storage.delete(KEPT);
  }
}
