// The two Workflows that events in the node's namespace start. A push starts one, which
// tells the index that this node has something new (R7, KTD9). A fetch or a clone starts
// the other, which counts the fetches of each fork (R45, KTD43) and then tells the index
// the same. A notice is an unauthenticated hint that names the node and nothing else: the
// index pulls from the registered URL (KTD11).

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { forkOf } from "./artifacts.ts";
import { NOTICE_PATH, isGitHash, isIndexUrl, isNodeOrigin } from "./contract.ts";
import type { Notice } from "./contract.ts";
import type { Env } from "./env.ts";

/** Sends the index a notice that names this node. */
async function sendNotice(env: Env, step: WorkflowStep): Promise<void> {
  const { INDEX_URL: index, NODE_URL: node } = env;
  // A node with no index address sends no notice (KTD40).
  if (!index) return;
  // The notice route is joined to the index address, so one in another form would send
  // the notice to the wrong place. The instance ends in an error that says why.
  if (!isIndexUrl(index)) {
    throw new Error("INDEX_URL is not an HTTPS address with no slash at its end, so this node cannot send a notice");
  }
  // A notice names the node by its base URL in the one accepted spelling (KTD8), and
  // the index refuses any other. This Worker also answers at the root of its host, so
  // its address has no path. A node that was deployed without such an address cannot
  // send a notice, and the instance ends in an error that says why.
  if (!isNodeOrigin(node)) {
    throw new Error("NODE_URL is not this node's origin in the accepted spelling, so the node cannot name itself in a notice");
  }
  await step.do("send notice", async () => {
    // Plain `fetch` to the index's public URL (KTD28).
    const response = await fetch(`${index}${NOTICE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node } satisfies Notice),
    });
    // A busy or failing index may take the notice a moment later. The step fails, and
    // the Workflow runs a failed step again, a few times and further apart each time.
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`the index answered ${response.status}`);
    }
    // Any other answer is final. It is the step's result, which shows in the instance.
    return response.status;
  });
}

export class OnPush extends WorkflowEntrypoint<Env> {
  // A push to any repo of the namespace starts this, and each means the same thing, so
  // the event is not read.
  override async run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<void> {
    await sendNotice(this.env, step);
  }
}

// The two events Artifacts sends for a fetch of a repo over Git (KTD43). A fetch into a
// repo that already held a commit was seen to send the first, and a fetch into a repo
// that held nothing the second.
const FETCH_EVENTS: readonly unknown[] = ["cf.artifacts.repo.fetched", "cf.artifacts.repo.cloned"];

/** One fetch of a fork: the ID of its event and the component whose fork it is. */
interface Fetch {
  readonly event: string;
  readonly component: string;
}

/**
 * Reads an event as a fetch of a fork. It is one when its type is one of the two, it has
 * an ID, and its repo is the fork of a component. Any other event gives nothing: the
 * triggers fire for every repo of the namespace, the team repo and the copies too.
 */
function fetchOf(sent: unknown): Fetch | undefined {
  if (typeof sent !== "object" || sent === null) return undefined;
  if (!("type" in sent) || !FETCH_EVENTS.includes(sent.type)) return undefined;
  if (!("id" in sent) || typeof sent.id !== "string") return undefined;
  if (!("source" in sent) || typeof sent.source !== "object" || sent.source === null) return undefined;
  const { source } = sent;
  if (!("repoName" in source) || typeof source.repoName !== "string") return undefined;
  // A fork is named after its component, a commit hash of 40 characters (R8).
  const component = source.repoName.slice(-40);
  return isGitHash(component) && source.repoName === forkOf(component) ? { event: sent.id, component } : undefined;
}

export class OnFetch extends WorkflowEntrypoint<Env> {
  override async run(sent: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<void> {
    const fetched = fetchOf(sent.payload);
    if (!fetched) return;
    // An event names a fork by its repo's name alone. One that arrives after the fork was
    // deleted and made anew counts for the new fork: nothing in it tells the two apart (KTD43).
    const kept = this.env.READ_TOKENS.get(this.env.READ_TOKENS.idFromName(forkOf(fetched.component)));
    // The count is kept before the notice is sent, so a notice that fails loses no count.
    // The fork's object counts the event under its ID, so a step that runs again adds nothing.
    await step.do("count fetch", async () => {
      await kept.countFetch(fetched.event);
    });
    // The index reads a node only after a notice, and a fetch pushes nothing. So a
    // counted fetch sends the notice a push sends.
    await sendNotice(this.env, step);
  }
}
