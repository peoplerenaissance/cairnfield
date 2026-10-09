// The live agent loop (KTD16, KTD19, KTD21), against a fake model behind `fetch`. No test
// here reaches a model.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agents/live.ts";
import type { Toolbox } from "../../src/agents/tools.ts";
import { EXIT, done, outcomeOf } from "../../src/outcome.ts";
import type { Outcome } from "../../src/outcome.ts";
import { MODEL_KEY, REFUSAL, answers, bench, calls } from "../support.ts";
import type { Bench } from "../support.ts";

const SYSTEM = "You write a patch.";
const FILE_TEXT = "curl https://collect.fellbeck-metrics.example";
const FILE_PATH = "scripts/send.sh";
const ANSWER = { type: "object", properties: { fine: { type: "boolean" } }, required: ["fine"], additionalProperties: false };

const TOOLS: Toolbox = {
  definitions: [
    {
      name: "read_file",
      description: "Reads a file.",
      input_schema: { type: "object", properties: { path: { type: "string", description: "A path." } }, required: ["path"], additionalProperties: false },
    },
  ],
  call: async (name) => (name === "read_file" ? { content: `${FILE_PATH}\n${FILE_TEXT}`, isError: false } : { content: "unknown-tool", isError: true }),
};

let on: Bench;
beforeEach(() => {
  on = bench();
});
afterEach(() => {
  on.dispose();
});

/** Runs the agent. An answer is accepted when it says so. */
function agent(): Promise<Outcome> {
  return outcomeOf(async () =>
    done({
      result: await runAgent(on.io, {
        key: MODEL_KEY,
        model: "claude-sonnet-5-5",
        system: SYSTEM,
        tools: TOOLS,
        answer: ANSWER,
        check: async (answer) =>
          (answer as { readonly fine?: unknown } | undefined)?.fine === true ? { ok: true, value: "accepted" } : { ok: false, reason: "not-fine" },
      }),
    }),
  );
}

interface Sent {
  readonly system: unknown;
  readonly tools: readonly { readonly strict?: boolean }[];
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
  readonly output_config: unknown;
}
const sent = (at: number): Sent => on.model.requests[at]?.body as Sent;

describe("the live agent", () => {
  it("runs the tools the model calls, and gives the answer that passes the check", async () => {
    on.model.answers.push(calls(["read_file", { path: FILE_PATH }]), answers({ fine: true }));

    expect(await agent()).toEqual({ code: EXIT.ok, output: { result: { ok: true, value: "accepted" } } });

    expect(on.model.requests).toHaveLength(2);
    expect(sent(0).tools.every((tool) => tool.strict === true)).toBe(true);
    expect(sent(0).output_config).toMatchObject({ format: { type: "json_schema", schema: ANSWER } });
    // The second request holds the model's own turn and the tool's result.
    expect(sent(1).messages.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
    expect(sent(1).messages[2]?.content).toMatchObject([{ type: "tool_result", content: `${FILE_PATH}\n${FILE_TEXT}` }]);
  });

  it("puts what a tool read in a tool result, and nowhere else", async () => {
    on.model.answers.push(calls(["read_file", { path: FILE_PATH }]), answers({ fine: false }), answers({ fine: true }));
    await agent();

    for (const { body } of on.model.requests) {
      const { system, messages } = body as Sent;
      const outside = messages.flatMap<unknown>(({ role, content }) =>
        role !== "user" ? [] : typeof content === "string" ? [content] : (content as { readonly type: string }[]).filter((block) => block.type !== "tool_result"),
      );
      const turns = JSON.stringify([system, outside]);
      expect(turns).not.toContain(FILE_TEXT);
      expect(turns).not.toContain(FILE_PATH);
    }
    expect(JSON.stringify(sent(2).messages)).toContain(FILE_TEXT);
  });

  it("asks once more when the answer fails the check, with the code and nothing else", async () => {
    on.model.answers.push(answers({ fine: false }), answers({ fine: true }));

    expect(await agent()).toMatchObject({ code: EXIT.ok, output: { result: { ok: true } } });

    expect(on.model.requests).toHaveLength(2);
    expect(sent(1).messages.at(-1)).toEqual({ role: "user", content: "refused: not-fine" });
    expect(on.warnings).toEqual(["answer-refused not-fine\n"]);
  });

  it("gives up after a second answer that fails the check", async () => {
    on.model.answers.push(answers({ fine: false }), answers("not JSON at all"), answers({ fine: true }));

    expect(await agent()).toEqual({ code: EXIT.ok, output: { result: { ok: false, reason: "not-fine" } } });
    expect(on.model.requests).toHaveLength(2);
  });

  it("never asks again after a refusal, and logs it", async () => {
    on.model.answers.push(REFUSAL, answers({ fine: true }));

    expect(await agent()).toEqual({ code: EXIT.agent, output: { error: "agent-refused" } });

    expect(on.model.requests).toHaveLength(1);
    expect(on.warnings.join("")).toContain("agent-refused cyber");
  });

  it("stops at its turn limit", async () => {
    for (let turn = 0; turn < 100; turn++) on.model.answers.push(calls(["read_file", { path: FILE_PATH }]));

    expect(await agent()).toEqual({ code: EXIT.agent, output: { error: "agent-limit", limit: "turns" } });
    expect(on.model.requests.length).toBeLessThan(100);
  });

  it("stops when an answer is cut off at the token limit", async () => {
    on.model.answers.push({ stop: "max_tokens", content: [{ type: "text", text: '{"fine": tr' }] }, answers({ fine: true }));

    expect(await agent()).toEqual({ code: EXIT.agent, output: { error: "agent-limit", limit: "max-tokens" } });
    expect(on.model.requests).toHaveLength(1);
  });

  it("names the status when the model's service refuses the request", async () => {
    expect(await agent()).toEqual({ code: EXIT.agent, output: { error: "agent-failed", status: 400 } });
  });

  it("sends the key in its header, and in no body", async () => {
    on.model.answers.push(calls(["read_file", { path: FILE_PATH }]), answers({ fine: true }));
    await agent();

    for (const { headers, body, url } of on.model.requests) {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(headers.get("x-api-key")).toBe(MODEL_KEY);
      expect(headers.get("authorization")).toBeNull();
      expect(JSON.stringify(body)).not.toContain(MODEL_KEY);
    }
  });
});
