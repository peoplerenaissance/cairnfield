// What the node keeps per fork, in a Durable Object named after the fork: the one read
// token (KTD7) and the count of the fork's fetches (KTD43). The object takes one call at a
// time, so of many requests that arrive together only the first mints a token and the
// others are given that one. That is what keeps the public route from minting without bound.

import { DurableObject } from "cloudflare:workers";
import type { Unavailable } from "./artifacts.ts";
import { MAX_FETCH_COUNT } from "./contract.ts";
import type { RepoToken } from "./contract.ts";

/** A kept token is not served in its last minutes, so a reader has time to use it. */
const KEPT_TOKEN_MARGIN = 5 * 60;
const KEPT = "token";

/** How often the fork was fetched, with the IDs of the events that were counted last. */
interface Counted {
  readonly fetches: number;
  readonly events: readonly string[];
}
const COUNTED = "fetches";
/** The object remembers the IDs of this many events, the last it counted. */
const REMEMBERED_EVENTS = 100;

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

  /**
   * Counts one fetch of the fork, for the event with this ID (KTD43). An event whose ID
   * is among the last the object counted is not counted again, so an event that arrives
   * twice, or a Workflow step that runs twice, adds one. The count stops at the limit of
   * the contract.
   */
  async countFetch(event: string): Promise<void> {
    // The object takes no other call while it waits for its own storage, so two events
    // that arrive together are counted one after the other.
    const { fetches, events } = (await this.ctx.storage.get<Counted>(COUNTED)) ?? { fetches: 0, events: [] };
    if (events.includes(event)) return;
    await this.ctx.storage.put(COUNTED, {
      fetches: Math.min(fetches + 1, MAX_FETCH_COUNT),
      events: [...events, event].slice(-REMEMBERED_EVENTS),
    } satisfies Counted);
  }

  /** How often the fork was fetched, or nothing when no fetch was counted. A read writes nothing. */
  async fetchCount(): Promise<number | undefined> {
    return (await this.ctx.storage.get<Counted>(COUNTED))?.fetches;
  }

  /**
   * Forgets the kept token and the count. A fork that is made anew has none of the old
   * fork's tokens, and nobody has fetched it.
   */
  async forget(): Promise<void> {
    await this.ctx.storage.delete([KEPT, COUNTED]);
  }
}
