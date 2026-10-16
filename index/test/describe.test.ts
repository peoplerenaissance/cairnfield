// What the index says of itself apart from its data (R34, R35): a `robots.txt` and a
// sitemap for a crawler, and the API catalog that points a tool to the description of the routes and
// to the schema of each record type. Each is fixed in the code or built from the
// library, so an index serves it with no setting.

import { API_CATALOG, INDEX_ROUTES, RECORD_TYPES, conforms, generatedFiles, openApiDescription, recordJsonSchema } from "@cairnfield/protocol";
import type { ApiCatalog } from "@cairnfield/protocol";
import { describe, expect, it } from "vitest";
import { pageLinks } from "../src/assets.ts";
import { INDEX, bench, freshIndexForEachTest, threeComponents } from "./bench.ts";

freshIndexForEachTest();

const notFound = { status: 404, body: { version: "1", error: "not-found" } };
const badRequest = { status: 400, body: { version: "1", error: "bad-request" } };

describe("robots.txt", () => {
  it("lets every crawler read every path, says a page may be searched and given to a model as input, and names the sitemap", async () => {
    const on = bench();
    const response = await on.get("/robots.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const lines = (await response.text()).split("\n");
    // A file with no `User-agent` line is read as no file. The first group names every crawler and allows every path.
    expect(lines.slice(0, 2)).toEqual(["User-agent: *", "Allow: /"]);
    expect(lines).toContain("Content-Signal: search=yes, ai-input=yes");
    expect(lines.some((line) => /^Disallow/.test(line))).toBe(false);
    // The sitemap is named by a whole address, as the format asks, under the address the request was made to.
    expect(lines).toContain(`Sitemap: ${INDEX}/sitemap.xml`);
    expect(lines.at(-1)).toBe("");
  });
});

describe("sitemap.xml", () => {
  it("lists the index's own page and the page of each registered component, in registration order", async () => {
    const on = bench();
    const empty = await on.get("/sitemap.xml");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(empty.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await empty.text()).toBe(
      ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', `  <url><loc>${INDEX}/</loc></url>`, "</urlset>", ""].join("\n"),
    );

    const { on: three, components } = await threeComponents();
    const commits = components.map(({ component }) => component);
    const text = await (await three.get("/sitemap.xml")).text();
    expect([...text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1])).toEqual([`${INDEX}/`, ...commits.map((commit) => `${INDEX}/components/${commit}`)]);
    // Each address in it is a page the index serves.
    for (const address of [...text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1] ?? "")) {
      expect((await three.get(new URL(address).pathname)).headers.get("content-type"), address).toBe("text/html; charset=utf-8");
    }
  });
});

describe("the API catalog (R34)", () => {
  it("is a link set whose one item is the index's API, with the OpenAPI description and the schema of each record type", async () => {
    const on = bench();
    const response = await on.get(INDEX_ROUTES.catalog.path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/linkset+json");
    expect(response.headers.get("link")).toBe('</.well-known/api-catalog>; rel="api-catalog"');
    const body: unknown = await response.json();
    expect(conforms(API_CATALOG, body)).toBeUndefined();
    // Every address is under the one the request was made to: an index is told none of its own.
    expect((body as ApiCatalog).linkset).toEqual([
      { anchor: `${INDEX}/.well-known/api-catalog`, item: [{ href: `${INDEX}/` }] },
      {
        anchor: `${INDEX}/`,
        "service-desc": [{ href: `${INDEX}/openapi.json`, type: "application/openapi+json" }],
        describedby: RECORD_TYPES.map((type) => ({ href: `${INDEX}/schemas/${type}.json`, type: "application/schema+json" })),
      },
    ]);
    // The catalog is the one JSON answer with no schema version: the link-set format allows no other member.
    expect(Object.keys(body as object)).toEqual(["linkset"]);
  });

  it("answers a HEAD as it answers the GET, with the headers and no body", async () => {
    const on = bench();
    for (const path of [INDEX_ROUTES.catalog.path, "/robots.txt", "/sitemap.xml", "/openapi.json", "/", `/components/${"9a".repeat(20)}`, "/view"]) {
      const head = await on.head(path);
      const got = await on.get(path);
      expect(head.status, path).toBe(got.status);
      expect([...head.headers].sort(), path).toEqual([...got.headers].sort());
      expect(await head.text(), path).toBe("");
    }
    expect((await on.head(INDEX_ROUTES.catalog.path)).headers.get("link")).toBe('</.well-known/api-catalog>; rel="api-catalog"');
    expect((await on.head("/schemas/other.json")).status).toBe(404);
    expect((await on.head("/nodes")).status).toBe(404);
  });

  it("points only at answers the index serves, each under the media type the link names", async () => {
    const on = bench();
    const { linkset } = (await (await on.get(INDEX_ROUTES.catalog.path)).json()) as ApiCatalog;
    for (const link of linkset.flatMap((set) => [...(set["service-desc"] ?? []), ...(set.describedby ?? [])])) {
      const url = new URL(link.href);
      expect(url.origin).toBe(INDEX);
      const response = await on.get(url.pathname);
      expect(response.status, link.href).toBe(200);
      expect(response.headers.get("content-type"), link.href).toBe(link.type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("serves the OpenAPI description and the schemas as the files of protocol/schemas/, byte for byte", async () => {
    const on = bench();
    const files = generatedFiles();
    expect(await (await on.get(INDEX_ROUTES.description.path)).text()).toBe(files["openapi.json"]);
    expect(JSON.parse(await (await on.get("/openapi.json")).text())).toEqual(openApiDescription());
    for (const type of RECORD_TYPES) {
      const text = await (await on.get(`/schemas/${type}.json`)).text();
      expect(text).toBe(files[`${type}.json`]);
      expect(JSON.parse(text)).toEqual(recordJsonSchema(type));
    }
  });

  it("serves no schema under another name, and refuses a query on any of these", async () => {
    const on = bench();
    for (const path of ["/schemas/other.json", "/schemas/finding.json/", "/schemas/finding", "/schemas/", "/schemas/Finding.json", "/.well-known/", "/.well-known/other", "/robots.txt/", "/sitemap.xml/", "/sitemap"]) {
      expect(await on.call("GET", path), path).toEqual(notFound);
    }
    for (const path of ["/robots.txt", "/sitemap.xml", INDEX_ROUTES.catalog.path, INDEX_ROUTES.description.path, "/schemas/finding.json"]) {
      expect(await on.call("GET", `${path}?x=1`), path).toEqual(badRequest);
      // None answers a POST.
      expect(await on.call("POST", path), path).toEqual(notFound);
    }
  });
});

describe("the link header of a page", () => {
  it("names the data endpoint the page's script draws from, and the catalog", async () => {
    const on = bench();
    const commit = "9a".repeat(20);
    expect((await on.get("/")).headers.get("link")).toBe(pageLinks("/view"));
    expect((await on.get(`/components/${commit}`)).headers.get("link")).toBe(pageLinks(`/components/${commit}/view`));
    expect(pageLinks("/view")).toBe('</view>; rel="alternate"; type="application/json", </.well-known/api-catalog>; rel="api-catalog"');
    // A file of the pages and a data answer carry none.
    expect((await on.get("/page/styles.css")).headers.get("link")).toBeNull();
    expect((await on.get("/view")).headers.get("link")).toBeNull();
  });
});
