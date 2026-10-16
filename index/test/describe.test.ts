// What the index says of itself apart from its data (R34, R35): a `robots.txt` for a
// crawler, and the API catalog that points a tool to the description of the routes and
// to the schema of each record type. Each is fixed in the code or built from the
// library, so an index serves it with no setting.

import { API_CATALOG, INDEX_ROUTES, RECORD_TYPES, conforms, generatedFiles, openApiDescription, recordJsonSchema } from "@cairnfield/protocol";
import type { ApiCatalog } from "@cairnfield/protocol";
import { describe, expect, it } from "vitest";
import { pageLinks } from "../src/assets.ts";
import { INDEX, bench, freshIndexForEachTest } from "./bench.ts";

freshIndexForEachTest();

const notFound = { status: 404, body: { version: "1", error: "not-found" } };
const badRequest = { status: 400, body: { version: "1", error: "bad-request" } };

describe("robots.txt", () => {
  it("lets every crawler read every path, and says a page may be searched and given to a model as input", async () => {
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
    expect(lines.at(-1)).toBe("");
  });
});

describe("the API catalog (R34)", () => {
  it("is a link set from the index's own address to the OpenAPI description and to the schema of each record type", async () => {
    const on = bench();
    const response = await on.get(INDEX_ROUTES.catalog.path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/linkset+json");
    const body: unknown = await response.json();
    expect(conforms(API_CATALOG, body)).toBeUndefined();
    const { linkset } = body as ApiCatalog;
    expect(linkset).toHaveLength(1);
    const [set] = linkset;
    // The anchor is the address the request was made to: an index is told none of its own.
    expect(set?.anchor).toBe(`${INDEX}/`);
    expect(set?.["service-desc"]).toEqual([{ href: `${INDEX}/openapi.json`, type: "application/openapi+json" }]);
    expect(set?.describedby).toEqual(RECORD_TYPES.map((type) => ({ href: `${INDEX}/schemas/${type}.json`, type: "application/schema+json" })));
    // The catalog is the one JSON answer with no schema version: the link-set format allows no other member.
    expect(Object.keys(body as object)).toEqual(["linkset"]);
  });

  it("points only at answers the index serves, each under the media type the link names", async () => {
    const on = bench();
    const { linkset } = (await (await on.get(INDEX_ROUTES.catalog.path)).json()) as ApiCatalog;
    for (const link of linkset.flatMap((set) => [...set["service-desc"], ...set.describedby])) {
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
    for (const path of ["/schemas/other.json", "/schemas/finding.json/", "/schemas/finding", "/schemas/", "/schemas/Finding.json", "/.well-known/", "/.well-known/other", "/robots.txt/"]) {
      expect(await on.call("GET", path), path).toEqual(notFound);
    }
    for (const path of ["/robots.txt", INDEX_ROUTES.catalog.path, INDEX_ROUTES.description.path, "/schemas/finding.json"]) {
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
