// The tools of a bundled agent (KTD16, R18): three that read one checkout, and one that
// gives the agent its target. There is no tool that writes, runs a command or reaches a
// network.
//
// A file tool reads only a path the checkout's listing holds, and only when the file's
// real path is that path, so nothing outside the checkout is read through a link. What a
// tool gives back is a component's text, which is hostile. It reaches the model as a tool
// result and in no other place.

import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { splitLines } from "@cairnfield/protocol";
import { checkoutDir } from "../checkout.ts";
import type { Listing } from "../checkout.ts";
import type { Home } from "../config.ts";

/** What an agent works on: the path, the lines and the observation of one finding of the team's own. */
export interface Target {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly observation: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: {
    readonly type: "object";
    readonly properties: { readonly [name: string]: { readonly type: string; readonly description: string } };
    readonly required: string[];
    readonly additionalProperties: false;
  };
}

/** What a tool gives back: text for the model, or the code of why it gave none. */
export interface ToolAnswer {
  readonly content: string;
  readonly isError: boolean;
}

export interface Toolbox {
  readonly definitions: readonly ToolDefinition[];
  call(name: string, input: unknown): Promise<ToolAnswer>;
}

// How much one tool call gives back. A component's author chose every size here.
const MAX_LISTED_FILES = 5000;
const MAX_READ_LINES = 400;
const MAX_SHOWN_LINE = 2000;
const MAX_MATCHES = 100;
const MAX_SEARCH_TEXT = 200;
/** A file past this size is not read by a tool. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** One search reads up to this much. */
const MAX_SEARCH_BYTES = 64 * 1024 * 1024;

function tool(name: string, description: string, properties: ToolDefinition["input_schema"]["properties"] = {}): ToolDefinition {
  return { name, description, input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } };
}

const DEFINITIONS = [
  tool("get_target", "Gives the finding to patch: the path of its file, its first and last line, and its observation."),
  tool("list_files", "Lists the path of every file of the component."),
  tool("read_file", `Reads a file of the component from one line on, up to ${MAX_READ_LINES} lines, with the number of each line.`, {
    path: { type: "string", description: "A path that list_files gave." },
    from: { type: "integer", description: "The first line to read. Lines count from 1." },
  }),
  tool("search_files", "Finds the lines of the component that hold a piece of text, as path:line:text. The text is matched as it is, with no pattern.", {
    text: { type: "string", description: "The text to find." },
  }),
];

const fine = (content: string): ToolAnswer => ({ content, isError: false });
const failed = (code: string): ToolAnswer => ({ content: code, isError: true });

const LINE_FEED = 10;

/** A line as text, without the line feed that ends it and up to a fixed length. */
function shown(line: Uint8Array): string {
  const body = line[line.length - 1] === LINE_FEED ? line.subarray(0, -1) : line;
  const text = new TextDecoder().decode(body);
  return text.length > MAX_SHOWN_LINE ? `${text.slice(0, MAX_SHOWN_LINE)}[cut]` : text;
}

/** The tools over one checkout, for an agent whose target is one finding. */
export function checkoutTools(home: Home, listing: Listing, target: Target): Toolbox {
  const root = checkoutDir(home, listing.component);
  const paths = listing.files.map(({ path }) => path);
  const known = new Set(paths);
  let realRoot: Promise<string> | undefined;

  /** Reads a file of the checkout, or gives the code of why it is not read. */
  async function read(path: string): Promise<Uint8Array | string> {
    if (!known.has(path)) return "not-in-checkout";
    realRoot ??= realpath(root);
    const parts = path.split("/");
    let real: string;
    try {
      real = await realpath(join(root, ...parts));
    } catch {
      return "not-found";
    }
    // A file of the checkout is no link and lies under no link, so its real path is its own.
    if (real !== join(await realRoot, ...parts)) return "outside-checkout";
    const { size } = await stat(real);
    if (size > MAX_FILE_BYTES) return "too-large";
    return new Uint8Array(await readFile(real));
  }

  async function readFrom(path: unknown, from: unknown): Promise<ToolAnswer> {
    if (typeof path !== "string" || typeof from !== "number" || !Number.isInteger(from) || from < 1) return failed("bad-input");
    const content = await read(path);
    if (typeof content === "string") return failed(content);
    const lines = splitLines(content);
    if (from > lines.length) return failed("lines-out-of-range");
    const to = Math.min(lines.length, from + MAX_READ_LINES - 1);
    const numbered = lines.slice(from - 1, to).map((line, at) => `${from + at}\t${shown(line)}`);
    return fine([`lines ${from}-${to} of ${lines.length}`, ...numbered].join("\n"));
  }

  async function search(text: unknown): Promise<ToolAnswer> {
    if (typeof text !== "string" || text === "" || text.length > MAX_SEARCH_TEXT || text.includes("\n")) return failed("bad-input");
    const matches: string[] = [];
    let scanned = 0;
    for (const path of paths) {
      const content = await read(path);
      if (typeof content === "string") continue;
      scanned += content.length;
      if (scanned > MAX_SEARCH_BYTES) return fine([...matches, "[cut]"].join("\n"));
      for (const [at, line] of splitLines(content).entries()) {
        const body = shown(line);
        if (!body.includes(text)) continue;
        if (matches.length === MAX_MATCHES) return fine([...matches, "[cut]"].join("\n"));
        matches.push(`${path}:${at + 1}:${body}`);
      }
    }
    return fine(matches.length === 0 ? "no-match" : matches.join("\n"));
  }

  return {
    definitions: DEFINITIONS,
    call: async (name, input) => {
      const given: { readonly [name: string]: unknown } = typeof input === "object" && input !== null ? { ...input } : {};
      switch (name) {
        case "get_target":
          return fine(JSON.stringify(target));
        case "list_files":
          return fine((paths.length > MAX_LISTED_FILES ? [...paths.slice(0, MAX_LISTED_FILES), "[cut]"] : paths).join("\n"));
        case "read_file":
          return readFrom(given["path"], given["from"]);
        case "search_files":
          return search(given["text"]);
        default:
          return failed("unknown-tool");
      }
    },
  };
}
