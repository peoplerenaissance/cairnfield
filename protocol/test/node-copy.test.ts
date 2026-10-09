// The team node keeps its own copy of the contract, because `node/` imports nothing
// from the workspace (KTD28). The workspace may read the node's copy, so these tests
// hold it to the library's rules without a deployed node.

import { describe, expect, it } from "vitest";
import * as node from "../../node/src/contract.ts";
import { ADMIN_KEY_HEADER, INDEX_ROUTES, NODE_ROUTES } from "../src/contracts.ts";
import { DELETED_BLOB, DELETED_MODE } from "../src/enums.ts";
import { isNodeUrl } from "../src/limits.ts";
import { GOOD_NODE_URLS, NODE_URLS_OFF_PATTERN, URLS_NOT_SERIALIZED, URLS_OFF_PATTERN } from "./fixtures.ts";

describe("the node's copy of the contract", () => {
  it("accepts a node base URL in the one accepted spelling", () => {
    for (const url of GOOD_NODE_URLS) expect(node.isNodeUrl(url), url).toBe(true);
  });

  it("refuses every other spelling of a node base URL, and no URL at all", () => {
    const refused = [...NODE_URLS_OFF_PATTERN, ...URLS_OFF_PATTERN, ...URLS_NOT_SERIALIZED];
    for (const [why, url] of refused) expect(node.isNodeUrl(url), why).toBe(false);
    for (const value of ["", undefined, null, 7]) expect(node.isNodeUrl(value), String(value)).toBe(false);
  });

  it("gives the library's verdict on every one of those spellings", () => {
    const spellings = [...GOOD_NODE_URLS, ...[...NODE_URLS_OFF_PATTERN, ...URLS_OFF_PATTERN, ...URLS_NOT_SERIALIZED].map(([, url]) => url)];
    for (const url of spellings) expect(node.isNodeUrl(url), url).toBe(isNodeUrl(url));
  });

  it("names the same routes, header, deletion marker and notice path", () => {
    const paths = Object.fromEntries(Object.entries(NODE_ROUTES).map(([id, route]) => [id, route.path]));
    expect(node.PATHS).toEqual(paths);
    expect(node.ADMIN_KEY_HEADER).toBe(ADMIN_KEY_HEADER);
    expect([node.DELETED_MODE, node.DELETED_BLOB]).toEqual([DELETED_MODE, DELETED_BLOB]);
    expect(node.NOTICE_PATH).toBe(INDEX_ROUTES.notice.path);
  });
});
