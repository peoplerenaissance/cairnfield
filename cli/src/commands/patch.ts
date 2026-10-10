// `patch`: writes a patch for one finding of the team's own (R24).
//
// The command publishes a patch claim (R15), gets edits, and turns them into a commit on
// the pinned commit that it checks and pushes to the team's fork. Then it publishes the
// patch record. The edits come from the bundled agent, or from a recording with
// `--replay` (KTD18). Both take the same path from there on, so a replay repeats every
// record ID and the commit hash of the live run.
//
// The agent reads one checkout and is given one target. It is given nothing from another
// team, and it pushes nothing: the command does (R18, R19).

import { readFile } from "node:fs/promises";
import { SCHEMA_VERSION, isSha256, recordPath } from "@cairnfield/protocol";
import type { Finding, Model, Patch } from "@cairnfield/protocol";
import { MODEL_KEY, runAgent } from "../agents/live.ts";
import { readRecording, recordingFile, saveRecording } from "../agents/replay.ts";
import { checkoutTools } from "../agents/tools.ts";
import { readListing } from "../checkout.ts";
import type { Listing } from "../checkout.ts";
import { DEFAULT_MODEL, keyFrom, shownPath } from "../config.ts";
import type { Home } from "../config.ts";
import { fetchCommit, withScratch } from "../git.ts";
import type { Io } from "../io.ts";
import { addRecord, checkOutbox } from "../outbox.ts";
import { EXIT, done, outcomeOf, stop } from "../outcome.ts";
import type { Outcome } from "../outcome.ts";
import { commitPatch, pushPatch } from "../patch/commit.ts";
import { ANSWER_SCHEMA, draftPatch } from "../patch/edits.ts";
import type { Drafted } from "../patch/edits.ts";
import { adminKey, nodeFailed, nodeListing, readRecord, writableFork } from "../services.ts";
import { claim } from "./claim.ts";
import { publish } from "./publish.ts";
import { verdict } from "./validate.ts";

export interface PatchRequest {
  readonly component: string;
  /** The ID of the finding to patch. */
  readonly finding: string | undefined;
  /** Takes the edits from the finding's recording, and calls no model. */
  readonly replay: boolean;
}

const PROMPT = new URL("../agents/prompts/patch.md", import.meta.url);

/**
 * Runs the patch agent on one finding of a checkout. Returns the edits that passed the
 * patch checks as a draft, or the code of what stopped it: `no-edits` when the agent gave
 * none, or the code of the second answer that failed the checks.
 */
export async function writeEdits(
  io: Io,
  home: Home,
  listing: Listing,
  finding: Finding,
  model: { readonly key: string; readonly name: string },
): Promise<Drafted> {
  const { path, start, end } = finding.location;
  const written = await runAgent(io, {
    key: model.key,
    model: model.name,
    system: await readFile(PROMPT, "utf8"),
    tools: checkoutTools(home, listing, { path, start, end, observation: finding.observation }),
    answer: ANSWER_SCHEMA,
    check: async (answer) => {
      const drafted = await draftPatch(home, listing, finding, answer);
      // An answer with no edit is the agent's own verdict that no patch fits. It is final, and is not asked for again.
      return drafted.ok || drafted.reason === "no-edits" ? { ok: true, value: drafted } : drafted;
    },
  });
  return written.ok ? written.value : written;
}

export async function patch(io: Io, home: Home, request: PatchRequest): Promise<Outcome> {
  const { component, finding: id } = request;
  if (!isSha256(id)) return stop(EXIT.usage, "usage");
  const { team } = home.config;
  if (team === undefined) return stop(EXIT.usage, "no-team");
  const listing = await readListing(home, component);
  if (!listing) return stop(EXIT.invalid, "unknown-component", { component });

  // The finding is read from the outbox, which mirrors the team repo, and is validated as any record there is.
  const unknown = (): never => stop(EXIT.invalid, "unknown-finding", { finding: id });
  const path = recordPath({ component, type: "finding" }, id);
  const waiting = await checkOutbox(home, path);
  if (waiting.rejected.length > 0) return verdict(waiting);
  const finding = waiting.records[0]?.record;
  if (finding?.type !== "finding") return unknown();

  const file = recordingFile(home, team, component, id);
  const recording = shownPath(home, file);
  const recorded = request.replay ? await readRecording(file, component, id) : undefined;
  if (request.replay && !recorded) return stop(EXIT.failed, "no-recording", { recording });
  // Both keys are read before anything is published, so a run that lacks one leaves no claim behind.
  const key = adminKey(io);
  // Where the edits come from: a recording, or the model that the model key opens.
  const from = recorded ? { recorded } : { key: keyFrom(io, MODEL_KEY), name: home.config.model ?? DEFAULT_MODEL };

  // The team's own repo must hold the finding: the patch record cites it, and a patch is
  // written for no finding but the team's own. The node validates nothing, so the file it
  // lists is read and held to the check the outbox's file passed. A record file's name is
  // the hash of its content (KTD1), so a valid file at this path is this record.
  const held = await nodeListing(io, home.config.node);
  if (!held.ok) return held.error === "refused" && held.reason === "not-found" ? unknown() : nodeFailed(held);
  if (!held.body.records.some((record) => record.path === path)) return unknown();
  if (!(await readRecord(io, home.config.node, held.body.head, path))?.ok) return unknown();

  // A replay publishes the claim with the number its recording holds (Appendix H).
  const claimed = await claim(io, home, {
    component,
    kind: "patch",
    check: undefined,
    findings: id,
    intent: "new",
    number: recorded && String(recorded.claim),
  });
  // A claim whose notice to the index failed is published all the same. The run goes on,
  // and the patch record's publish sends the notice again.
  if (claimed.code !== EXIT.ok && claimed.output["notice"] !== "failed") return claimed;
  const made = { claim: String(claimed.output["claim"]), number: Number(claimed.output["number"]) };

  // When a later step stops, the output still names the claim that was published.
  const { code, output } = await outcomeOf(async () => {
    const model: Model = from.recorded ? from.recorded.model : from.name;
    const drafted = from.recorded
      ? await draftPatch(home, listing, finding, { edits: from.recorded.edits })
      : await writeEdits(io, home, listing, finding, from);
    // Fail closed: edits that were refused publish nothing (KTD19).
    if (!drafted.ok) return stop(EXIT.invalid, "edits-refused", { reason: drafted.reason });
    // Saved before the push, so a run that stops after this can be finished with `--replay`.
    if (!from.recorded) {
      await saveRecording(file, { version: SCHEMA_VERSION, component, finding: id, claim: made.number, model, edits: [...drafted.edits] });
    }

    const access = await writableFork(io, home, key, component);
    const { patchId, kind, size, paths } = drafted.facts;
    const commit = await withScratch(io, async (scratch) => {
      await fetchCommit(scratch, access, component);
      const built = await commitPatch(scratch, component, drafted);
      await pushPatch(scratch, access, component, patchId, built);
      return built;
    });

    // The fork holds the commit before the record that announces it is published.
    const record: Patch = { version: SCHEMA_VERSION, type: "patch", component, commit, findings: [id], claim: made.claim, model };
    const announced = await addRecord(home, record);
    const published = await outcomeOf(() => publish(io, home, recordPath(record, announced)));
    return done({ patch: announced, commit, patchId, kind, size, paths, recording, ...published.output }, published.code);
  });
  return done({ ...made, ...output }, code);
}
