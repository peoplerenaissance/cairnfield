// The Workflow that a push to the node's namespace starts (R7, KTD9). It tells the index
// that this node has something new. A notice is an unauthenticated hint that names the
// node and nothing else: the index pulls from the registered URL (KTD11).

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NOTICE_PATH } from "./contract.ts";
import type { Notice } from "./contract.ts";
import type { Env } from "./env.ts";

export class OnPush extends WorkflowEntrypoint<Env> {
  // A push to any repo of the namespace starts this, and each means the same thing, so
  // the event is not read.
  override async run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<void> {
    const { INDEX_URL: index, NODE_URL: node } = this.env;
    // A node with no index address sends no notice (KTD40).
    if (!index) return;
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
}
