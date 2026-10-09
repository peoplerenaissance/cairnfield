// `claim`: writes a claim record and publishes it. A claim says that work has started
// (R15). A review claim names the kind of check and no file. A patch claim names the
// findings it will fix.
//
// Two runs would write the same claim, and so the same ID, so each run draws a number
// (Appendix H). A replay passes the number its recording holds and gets the same record.

import { MAX_CLAIM_NUMBER, SCHEMA_VERSION, validateRecord } from "@cairnfield/protocol";
import { readListing } from "../checkout.ts";
import type { Home } from "../config.ts";
import type { Io } from "../io.ts";
import { addRecord } from "../outbox.ts";
import { EXIT, done, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { publish } from "./publish.ts";

export interface ClaimRequest {
  readonly component: string;
  readonly kind: string | undefined;
  readonly check: string | undefined;
  /** Finding IDs, with commas between them. */
  readonly findings: string | undefined;
  readonly intent: string | undefined;
  readonly number: string | undefined;
}

const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/;

export async function claim(io: Io, home: Home, request: ClaimRequest): Promise<Outcome> {
  if (request.number !== undefined && !WHOLE_NUMBER.test(request.number)) return stop(EXIT.usage, "usage");
  const number = request.number === undefined ? io.random(MAX_CLAIM_NUMBER + 1) : Number(request.number);
  // The protocol's own check decides whether these fields make a claim.
  const written = validateRecord({
    version: SCHEMA_VERSION,
    type: "claim",
    component: request.component,
    kind: request.kind,
    number,
    ...(request.check === undefined ? {} : { check: request.check }),
    // A record holds its findings in order, so two runs that name the same ones agree.
    ...(request.findings === undefined ? {} : { findings: [...new Set(request.findings.split(","))].sort() }),
    ...(request.intent === undefined ? {} : { intent: request.intent }),
  });
  if (!written.ok) return stop(EXIT.usage, "usage");
  // A record of a component that is not pinned here would not pass `validate`.
  if (!(await readListing(home, request.component))) {
    return stop(EXIT.invalid, "unknown-component", { component: request.component });
  }
  const id = await addRecord(home, written.record);
  const { code, output } = await publish(io, home);
  return done({ claim: id, number, ...output }, code);
}
