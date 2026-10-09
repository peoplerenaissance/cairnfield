// `validate`: checks every file of the outbox and publishes nothing. It reads the
// outbox and the checkouts only, so it needs no key and makes no call. An outside agent
// runs this command and none after it (R21).

import type { Home } from "../config.ts";
import { checkOutbox } from "../outbox.ts";
import type { OutboxCheck } from "../outbox.ts";
import { EXIT, done } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";

/** What `validate` prints, and what `publish` prints when it refuses to push. */
export function verdict(check: OutboxCheck): Outcome {
  return done(
    { records: check.records.length, rejected: check.rejected },
    check.rejected.length === 0 ? EXIT.ok : EXIT.invalid,
  );
}

export async function validate(home: Home): Promise<Outcome> {
  return verdict(await checkOutbox(home));
}
