// The live agent loop: the one place that calls a model, and the one file that names a
// provider (KTD18). It calls the Claude API directly, with tools of the command's own
// (KTD16).
//
// The system turn is the agent's prompt, and the first user turn is a fixed line. What a
// tool read reaches the model in a tool result and nowhere else. The key travels in the
// request's own header: it is in no prompt and no tool result, and the agent has no tool
// that could read it (R18).
//
// An answer that fails the caller's check is asked for once more, with the check's code
// and nothing else. A refusal is never asked again (KTD19). Each run has a turn limit, a
// token limit and a deadline (KTD21).

import Anthropic from "@anthropic-ai/sdk";
import type { Io } from "../io.ts";
import { EXIT, stop } from "../outcome.ts";
import type { Toolbox } from "./tools.ts";

/** The name of the model key in the environment. */
export const MODEL_KEY = "ANTHROPIC_API_KEY";

const API = "https://api.anthropic.com";
const START = "Write the patch for your target.";

/** How many requests one run may make. */
const MAX_TURNS = 40;
/** The most tokens of one answer. */
const MAX_ANSWER_TOKENS = 16_000;
/** The most tokens of one run: what every request sent and every answer held. */
const MAX_RUN_TOKENS = 1_000_000;
/** The models that take no effort setting. Every other model runs at one fixed effort. */
const NO_EFFORT: ReadonlySet<string> = new Set(["claude-haiku-4-5-20251001"]);
const RUN_DEADLINE_MS = 10 * 60_000;
const REQUEST_DEADLINE_MS = 3 * 60_000;

/** An answer the caller accepts, or the code of what is wrong with it. The code is the caller's own. */
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export interface AgentRun<T> {
  /** The model key. */
  readonly key: string;
  readonly model: string;
  /** The agent's prompt. It holds nothing from a checkout. */
  readonly system: string;
  readonly tools: Toolbox;
  /** The form of the agent's answer, as a JSON Schema. */
  readonly answer: { readonly [key: string]: unknown };
  /** Checks an answer. It is given nothing when the answer was no JSON. */
  readonly check: (answer: unknown) => Promise<Checked<T>>;
}

/** The category of a refusal as a code, whatever the service sent. */
function category(details: Anthropic.Message["stop_details"]): string {
  const given = details?.category;
  return typeof given === "string" && /^[a-z_]{1,40}$/.test(given) ? given : "unnamed";
}

/**
 * Runs an agent until it gives an answer. Returns the answer that passed the check, or the
 * code of the second one that failed it. A refusal, a limit or a failing service ends the
 * command.
 */
export async function runAgent<T>(io: Io, run: AgentRun<T>): Promise<Checked<T>> {
  // The key, the address, the transport and the log level are all named here. The SDK
  // would otherwise read an address, a second credential and a log level from the
  // process's own environment, and its log goes to standard output. It also adds headers
  // it finds there, so the key's header is set once more, which no such header replaces.
  const client = new Anthropic({
    apiKey: run.key,
    authToken: null,
    baseURL: API,
    defaultHeaders: { "x-api-key": run.key },
    fetch: io.fetch,
    // A redirect would carry the key's header to another address.
    fetchOptions: { redirect: "error" },
    logLevel: "off",
    // One turn is one request. The SDK would otherwise try a failed request twice more,
    // which the turn limit and the deadline would not count.
    maxRetries: 0,
  });
  const tools = run.tools.definitions.map((tool) => ({ ...tool, strict: true }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: START }];
  const deadline = io.now() + RUN_DEADLINE_MS;
  let tokens = 0;
  let retried = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (io.now() >= deadline) return stop(EXIT.agent, "agent-limit", { limit: "deadline" });
    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model: run.model,
          max_tokens: MAX_ANSWER_TOKENS,
          system: run.system,
          tools,
          messages,
          output_config: {
            ...(NO_EFFORT.has(run.model) ? {} : { effort: "medium" as const }),
            format: { type: "json_schema", schema: run.answer },
          },
        },
        // A request ends at its own deadline or at the run's, whichever comes first.
        { timeout: Math.min(REQUEST_DEADLINE_MS, deadline - io.now()) },
      );
    } catch (error) {
      if (!(error instanceof Anthropic.APIError)) throw error;
      if (error instanceof Anthropic.APIConnectionTimeoutError) return stop(EXIT.agent, "agent-limit", { limit: "deadline" });
      // The status says enough. The error's text may quote the request.
      return stop(EXIT.agent, "agent-failed", typeof error.status === "number" ? { status: error.status } : {});
    }
    tokens += response.usage.input_tokens + response.usage.output_tokens;

    // Read before the content, which a refusal leaves empty or cut short.
    if (response.stop_reason === "refusal") {
      io.warn(`agent-refused ${category(response.stop_details)}\n`);
      return stop(EXIT.agent, "agent-refused");
    }
    if (response.stop_reason === "max_tokens") return stop(EXIT.agent, "agent-limit", { limit: "max-tokens" });
    if (tokens > MAX_RUN_TOKENS) return stop(EXIT.agent, "agent-limit", { limit: "tokens" });
    // The model's turn goes back as it came, with every block it holds.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const { content, isError } = await run.tools.call(block.name, block.input);
        results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    if (response.stop_reason !== "end_turn") return stop(EXIT.agent, "agent-failed");

    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = undefined;
    }
    const checked = await run.check(answer);
    if (checked.ok) return checked;
    io.warn(`answer-refused ${checked.reason}\n`);
    if (retried) return checked;
    retried = true;
    messages.push({ role: "user", content: `refused: ${checked.reason}` });
  }
  return stop(EXIT.agent, "agent-limit", { limit: "turns" });
}
