// The index Worker (R9 to R14): it registers nodes and components, takes push notices,
// reads the nodes over HTTP and serves one validated view per component commit, with a
// page that draws that view for a person.
//
// The index serves data and never instructions (R35). Every answer but the page and its
// files is JSON in a shape of the protocol, with the schema version, and a refusal is a
// code from a closed list. The page reads the view and nothing else (KTD14).

import { INDEX_ROUTES, REGISTRATION_KEY_HEADER, RESET_KEY_HEADER, conforms, isCommit } from "@cairnfield/protocol";
import { PAGE, PAGE_FILE, pageFile } from "./assets.ts";
import type { Env } from "./env.ts";
import { jsonOf, readUpTo } from "./fetch.ts";
import { consume, notice } from "./queue.ts";
import type { Message } from "./queue.ts";
import { carriesKey, registerComponent, registerNode, reset } from "./register.ts";
import { refusal } from "./respond.ts";
import { viewOf } from "./view.ts";

/** A request body is read up to this size. Each one is a URL or two and a few short values. */
const MAX_REQUEST_BYTES = 8 * 1024;

const VIEW_PATH = /^\/components\/([^/]+)\/view$/;
/** The page of a component commit. It reads the view of that commit, so the two share the start of their path. */
const PAGE_PATH = /^\/components\/([^/]+)$/;

/** The JSON body of a request, or nothing for a body that is too long or is not JSON. */
async function bodyOf(request: Request): Promise<unknown> {
  const bytes = await readUpTo(request.body, MAX_REQUEST_BYTES);
  return bytes.length > MAX_REQUEST_BYTES ? undefined : jsonOf(bytes);
}

/** The nodes a `teams` query lists (KTD38), nothing when there is no query, and `false` for any other query. */
function teamsOf(url: URL): string[] | undefined | false {
  if (url.searchParams.size === 0) return undefined;
  const teams = url.searchParams.getAll("teams");
  if (teams.length !== url.searchParams.size || conforms(INDEX_ROUTES.view.query.teams, teams)) return false;
  return teams;
}

async function view(env: Env, url: URL, component: string): Promise<Response> {
  // A commit in another form names no component the index could hold.
  if (!isCommit(component)) return refusal("not-found");
  const teams = teamsOf(url);
  if (teams === false) return refusal("bad-request");
  const built = await viewOf(env, component, teams, Date.now());
  return built ? Response.json(built) : refusal("not-found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET") {
      const viewed = VIEW_PATH.exec(path);
      if (viewed) return view(env, url, viewed[1] ?? "");
      // The page is the same for a commit nobody registered: it reads the view, and says what the view says.
      const paged = PAGE_PATH.exec(path);
      if (paged) return isCommit(paged[1]) ? pageFile(env, request, PAGE) : refusal("not-found");
      return PAGE_FILE.test(path) ? pageFile(env, request, path) : refusal("not-found");
    }
    if (request.method !== "POST") return refusal("not-found");
    if (path === INDEX_ROUTES.notice.path) return notice(env, await bodyOf(request), Date.now());
    if (path === INDEX_ROUTES.registerNode.path || path === INDEX_ROUTES.registerComponent.path) {
      if (!(await carriesKey(request, REGISTRATION_KEY_HEADER, env.REGISTRATION_KEY))) return refusal("unauthorized");
      const body = await bodyOf(request);
      return path === INDEX_ROUTES.registerNode.path ? registerNode(env, body, Date.now()) : registerComponent(env, body, Date.now());
    }
    if (path === INDEX_ROUTES.reset.path) {
      if (!(await carriesKey(request, RESET_KEY_HEADER, env.RESET_KEY))) return refusal("unauthorized");
      return reset(env, Date.now());
    }
    return refusal("not-found");
  },

  async queue(batch: MessageBatch<Message>, env: Env): Promise<void> {
    await consume(batch, env);
  },
} satisfies ExportedHandler<Env, Message>;
