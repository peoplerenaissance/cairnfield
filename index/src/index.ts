// The index Worker (R9 to R14): it registers nodes and components, takes push notices,
// reads the nodes over HTTP and serves one validated view per component commit, with a
// page that draws that view for a person. It also lists the components it holds, with a
// page of its own that draws the list.
//
// The index serves data and never instructions (R35). Every answer but the two pages and
// their files is JSON in a shape of the protocol, with the schema version, and a refusal
// is a code from a closed list. A page's script reads the view or the list and nothing
// else, and the words a page holds apart from that are written in the repo (KTD14).
// The index also says what it is to a crawler and to a tool: a `robots.txt`, and the API
// catalog that points to the description of its routes and the record schemas (R34).

import { INDEX_ROUTES, REGISTRATION_KEY_HEADER, RESET_KEY_HEADER, conforms, isCommit } from "@cairnfield/protocol";
import { PAGE, PAGE_FILE, ROOT, pageFile } from "./assets.ts";
import { registeredComponents } from "./components.ts";
import { ROBOTS, ROBOTS_PATH, catalog, description, schema, schemaTypeOf } from "./describe.ts";
import type { Env } from "./env.ts";
import { jsonOf, readUpTo } from "./fetch.ts";
import { consume, notice } from "./queue.ts";
import type { Message } from "./queue.ts";
import { carriesKey, registerComponent, registerNode, reset } from "./register.ts";
import { answer, refusal } from "./respond.ts";
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

/** The list of the index's components. It takes no query, so one of any kind is refused. */
async function list(env: Env, url: URL): Promise<Response> {
  if (url.searchParams.size > 0) return refusal("bad-request");
  return answer({ components: await registeredComponents(env) });
}

/** A fixed text under its media type: what the index says of itself (R34). */
const fixed = (body: string, type: string): Response => new Response(body, { headers: { "content-type": type, "x-content-type-options": "nosniff" } });

/** What the index says of itself at `url`, or nothing when no such answer stands there. None takes a query, so one of any kind is refused. */
function described(url: URL): Response | undefined {
  const path = url.pathname;
  const type = schemaTypeOf(path);
  const stands = type !== undefined || path === ROBOTS_PATH || path === INDEX_ROUTES.catalog.path || path === INDEX_ROUTES.description.path;
  if (!stands) return undefined;
  if (url.searchParams.size > 0) return refusal("bad-request");
  if (type !== undefined) return fixed(schema(type), INDEX_ROUTES.schema.response.media);
  if (path === ROBOTS_PATH) return fixed(ROBOTS, "text/plain; charset=utf-8");
  if (path === INDEX_ROUTES.catalog.path) return fixed(JSON.stringify(catalog(url.origin)), INDEX_ROUTES.catalog.media);
  return fixed(description(), INDEX_ROUTES.description.response.media);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET") {
      // The index's own page, at the index's own address. The query of the address is the page's to read, and it passes none on.
      if (path === "/") return pageFile(env, request, ROOT, INDEX_ROUTES.list.path);
      if (path === INDEX_ROUTES.list.path) return list(env, url);
      const viewed = VIEW_PATH.exec(path);
      if (viewed) return view(env, url, viewed[1] ?? "");
      // The page is the same for a commit nobody registered: it reads the view, and says what the view says.
      const paged = PAGE_PATH.exec(path);
      if (paged) return isCommit(paged[1]) ? pageFile(env, request, PAGE, `${path}/view`) : refusal("not-found");
      if (PAGE_FILE.test(path)) return pageFile(env, request, path);
      return described(url) ?? refusal("not-found");
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
