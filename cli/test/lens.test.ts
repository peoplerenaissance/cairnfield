import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLens } from "../src/lens.ts";

const lensFile = (name: string): string =>
  readFileSync(new URL(`../../fixtures/lenses/${name}.json`, import.meta.url), "utf8");

// The saved lens names Team B by a stand-in. The demo puts the deployed node's URL in its place.
const TEAM_B = "https://node.team-b.example";
const BOTH_KINDS = ["removes-only", "adds-or-changes"];

const lens = (overrides: { readonly [field: string]: unknown } = {}): string =>
  JSON.stringify({ patchLevel: 1, teams: [], patchKinds: BOTH_KINDS, publishRecipes: true, ...overrides });

describe("the demo's lens files (R23)", () => {
  it("has Team A alone at level 1, naming no team", () => {
    expect(parseLens(lensFile("team-a-alone"))).toEqual({
      ok: true,
      lens: { patchLevel: 1, teams: [], patchKinds: BOTH_KINDS, publishRecipes: true },
    });
  });

  it("has Team A at level 2, naming Team B's node", () => {
    expect(parseLens(lensFile("team-a-names-b"))).toEqual({
      ok: true,
      lens: { patchLevel: 2, teams: [TEAM_B], patchKinds: BOTH_KINDS, publishRecipes: true },
    });
  });

  it("has Team B at level 1, naming no team", () => {
    expect(parseLens(lensFile("team-b"))).toEqual({
      ok: true,
      lens: { patchLevel: 1, teams: [], patchKinds: BOTH_KINDS, publishRecipes: true },
    });
  });
});

describe("a lens file", () => {
  it("is refused when it names a node URL in a spelling KTD8 refuses", () => {
    const spellings = [
      `${TEAM_B}/`,
      "https://Node.Team-B.example",
      "http://node.team-b.example",
      "https://node.team-b.example:443",
      "https://node.team-b.example?x",
    ];
    for (const url of spellings) {
      expect(parseLens(lens({ patchLevel: 2, teams: [url] })), url).toEqual({
        ok: false,
        error: "unknown-value",
        field: "teams",
      });
    }
  });

  it("is refused at patch level 3 with the code for a level that is not built", () => {
    expect(parseLens(lens({ patchLevel: 3 }))).toEqual({
      ok: false,
      error: "level-3-not-built",
      field: "patchLevel",
    });
  });

  it("is accepted at each built level and with either patch kind alone", () => {
    for (const patchLevel of [0, 1, 2]) {
      expect(parseLens(lens({ patchLevel })), `level ${patchLevel}`).toMatchObject({ ok: true });
    }
    expect(parseLens(lens({ patchKinds: ["removes-only"], publishRecipes: false }))).toEqual({
      ok: true,
      lens: { patchLevel: 1, teams: [], patchKinds: ["removes-only"], publishRecipes: false },
    });
  });

  it("is refused when a field holds a value outside its list", () => {
    const refused = (field: string) => ({ ok: false, error: "unknown-value", field });
    expect(parseLens(lens({ patchLevel: 4 }))).toEqual(refused("patchLevel"));
    expect(parseLens(lens({ patchLevel: "1" }))).toEqual(refused("patchLevel"));
    expect(parseLens(lens({ patchKinds: ["rewrites-all"] }))).toEqual(refused("patchKinds"));
    expect(parseLens(lens({ publishRecipes: "yes" }))).toEqual(refused("publishRecipes"));
  });

  it("is refused when a field is missing, so no field has a silent default", () => {
    expect(parseLens(JSON.stringify({ patchLevel: 1, teams: [], patchKinds: BOTH_KINDS }))).toEqual({
      ok: false,
      error: "unknown-value",
      field: "publishRecipes",
    });
  });

  it("is refused when it holds a field the lens does not have", () => {
    expect(parseLens(lens({ confirmations: 2 }))).toEqual({ ok: false, error: "unknown-field" });
  });

  it("is refused when it is not a JSON object", () => {
    expect(parseLens("patchLevel: 1")).toEqual({ ok: false, error: "unknown-value" });
    expect(parseLens("[]")).toEqual({ ok: false, error: "unknown-value" });
  });
});
