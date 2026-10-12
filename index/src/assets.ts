// The two pages and the files they load (R14, KTD14), served from the Worker's static
// assets. `npm run build` writes them to `dist/page/`, and every request goes through the
// Worker, so each answer carries the headers set here.
//
// A page shows values that nodes published. Its policy lets it run scripts, apply styles
// and fetch from its own origin and from nowhere else, and it allows no script and no
// style written into the page. Nothing else is allowed: no image, no frame, no form.

import type { Env } from "./env.ts";
import { refusal } from "./respond.ts";

const POLICY = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");

/** The index's own page, which lists the index's components. */
export const ROOT = "/page/root.html";

/** The page of a component commit. One file serves every commit: its script reads the commit from the address. */
export const PAGE = "/page/page.html";

/** A script or a stylesheet of the pages, by the path a browser asks for. Neither page is served under the name of its file. */
export const PAGE_FILE = /^\/page\/[a-z]+\.(?:js|css)$/;

/** One file of the pages, or `not-found` when the build made no such file. `path` is `ROOT`, `PAGE` or a path that `PAGE_FILE` matches. */
export async function pageFile(env: Env, request: Request, path: string): Promise<Response> {
  const found = await env.ASSETS.fetch(new URL(path, request.url));
  if (found.status !== 200) return refusal("not-found");
  const headers = new Headers({ "content-security-policy": POLICY, "x-content-type-options": "nosniff" });
  // The assets binding names the media type of each file, and no browser is left to guess one.
  const type = found.headers.get("content-type");
  if (type !== null) headers.set("content-type", type);
  return new Response(found.body, { headers });
}
