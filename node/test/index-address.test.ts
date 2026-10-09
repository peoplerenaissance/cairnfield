// The form of the index address a node is deployed with. The Workflow joins the notice
// route to it, so anything after the path, or a slash at the end, sends the notice to
// the wrong place. Every host here is invented.

import { describe, expect, it } from "vitest";
import { isIndexUrl } from "../src/contract.ts";

describe("an index address", () => {
  it("is an HTTPS origin, with a port or a path when the index has one", () => {
    const accepted = [
      "https://index.cairnfield.example",
      "https://index.cairnfield.example:8443",
      "https://cairnfield.example/index",
    ];
    for (const address of accepted) expect(isIndexUrl(address), address).toBe(true);
  });

  it("is refused in any other form", () => {
    const refused: readonly (readonly [why: string, value: unknown])[] = [
      ["a slash at the end", "https://index.cairnfield.example/"],
      ["a slash after a path", "https://cairnfield.example/index/"],
      ["another scheme", "http://index.cairnfield.example"],
      ["a query", "https://index.cairnfield.example?x=1"],
      ["an empty query after a path", "https://cairnfield.example/index?"],
      ["a fragment", "https://index.cairnfield.example#notices"],
      ["an empty fragment after a path", "https://cairnfield.example/index#"],
      ["credentials", "https://user:pw@index.cairnfield.example"],
      ["an upper-case host", "https://Index.Cairnfield.example"],
      ["a space", "https://index.cairnfield.example /"],
      ["no address", ""],
      ["no string", undefined],
    ];
    for (const [why, value] of refused) expect(isIndexUrl(value), why).toBe(false);
  });
});
