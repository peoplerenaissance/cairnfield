import { describe, expect, it } from "vitest";
import { countsAgainstLens } from "../src/criteria.ts";
import type { Criterion } from "../src/enums.ts";
import type { FileListing } from "../src/files.ts";
import {
  citedBlob,
  findingsMatch,
  isConfirmed,
  matchGroups,
  patchConfirmations,
  rangesOverlap,
} from "../src/match.ts";
import type { MatchGroup, Sourced } from "../src/match.ts";
import type { AnyRecord, Finding } from "../src/schemas.ts";
import {
  HOST,
  NODE_A,
  NODE_B,
  NODE_C,
  counterFinding,
  finding,
  patchRecheck,
  plainFinding,
  recheck,
  sha,
} from "./fixtures.ts";

const BLOB_EXPORT = "aa".repeat(20);
const BLOB_README = "bb".repeat(20);
const BLOB_OTHER = "cc".repeat(20);

// `scripts/export.sh` and `vendor/export.sh` are byte-identical. `scripts/sync.sh` is not.
const LISTING: FileListing = [
  { path: "scripts/export.sh", mode: "100755", blob: BLOB_EXPORT },
  { path: "vendor/export.sh", mode: "100755", blob: BLOB_EXPORT },
  { path: "scripts/sync.sh", mode: "100755", blob: BLOB_OTHER },
  { path: "README.md", mode: "100644", blob: BLOB_README },
];

const at = (path: string, start: number, end: number, overrides: Partial<Finding> = {}): Finding =>
  plainFinding({ location: { path, start, end }, ...overrides });

let next = 0;
/** Annotates a record with the node it came from. Each call gives a new ID unless one is passed. */
function from<R extends AnyRecord>(node: string, record: R, id?: string): Sourced<R> {
  next += 1;
  return { node, id: id ?? next.toString(16).padStart(64, "0"), record };
}

describe("line ranges", () => {
  it("overlap when they share a line", () => {
    expect(rangesOverlap({ start: 10, end: 20 }, { start: 18, end: 25 })).toBe(true);
    expect(rangesOverlap({ start: 18, end: 25 }, { start: 10, end: 20 })).toBe(true);
    expect(rangesOverlap({ start: 10, end: 20 }, { start: 20, end: 25 })).toBe(true);
    expect(rangesOverlap({ start: 10, end: 20 }, { start: 12, end: 13 })).toBe(true);
    expect(rangesOverlap({ start: 10, end: 20 }, { start: 21, end: 25 })).toBe(false);
  });
});

describe("cited content", () => {
  it("is the blob hash of the finding's file in the listing", () => {
    expect(citedBlob(at("scripts/export.sh", 1, 2), LISTING)).toBe(BLOB_EXPORT);
    expect(citedBlob(at("vendor/export.sh", 1, 2), LISTING)).toBe(BLOB_EXPORT);
    expect(citedBlob(at("scripts/missing.sh", 1, 2), LISTING)).toBeUndefined();
  });
});

describe("the match rule of R10", () => {
  it("matches two findings on the same file and observation with ranges 10-20 and 18-25", () => {
    expect(findingsMatch(at("scripts/export.sh", 10, 20), at("scripts/export.sh", 18, 25), LISTING)).toBe(true);
  });

  it("does not match ranges 10-20 and 21-25", () => {
    expect(findingsMatch(at("scripts/export.sh", 10, 20), at("scripts/export.sh", 21, 25), LISTING)).toBe(false);
  });

  it("matches one observation on two byte-identical files at different paths with overlapping ranges", () => {
    expect(findingsMatch(at("scripts/export.sh", 10, 20), at("vendor/export.sh", 18, 25), LISTING)).toBe(true);
  });

  it("does not match the same two findings on files with different content", () => {
    expect(findingsMatch(at("scripts/export.sh", 10, 20), at("scripts/sync.sh", 18, 25), LISTING)).toBe(false);
  });

  it("does not match two observations on the same lines", () => {
    const other = at("scripts/export.sh", 10, 20, { observation: "fails-on-documented-input" });
    expect(findingsMatch(at("scripts/export.sh", 10, 20), other, LISTING)).toBe(false);
  });

  it("matches whatever the criterion, the check, the model or the second location", () => {
    const other = at("scripts/export.sh", 10, 20, {
      criterion: "safe-to-run-sandboxed",
      check: "permissions",
      model: "none",
      contradicts: { path: "README.md", start: 1, end: 1 },
    });
    expect(findingsMatch(at("scripts/export.sh", 10, 20), other, LISTING)).toBe(true);
  });

  it("does not match a finding whose path is not in the listing", () => {
    expect(findingsMatch(at("scripts/missing.sh", 10, 20), at("scripts/missing.sh", 10, 20), LISTING)).toBe(false);
  });

  it("matches destination findings only when they name the same host", () => {
    const one = finding({ location: { path: "README.md", start: 3, end: 4 } });
    const same = finding({ location: { path: "README.md", start: 4, end: 4 }, model: "none" });
    const other = finding({ location: { path: "README.md", start: 4, end: 4 }, host: "cdn.other-vendor.example" });
    expect(one.host).toBe(HOST);
    expect(findingsMatch(one, same, LISTING)).toBe(true);
    expect(findingsMatch(one, other, LISTING)).toBe(false);
  });
});

describe("match groups and confirmation", () => {
  it("puts two matching findings from two nodes in one group confirmed by two organizations", () => {
    const groups = matchGroups(
      [from(NODE_A, at("scripts/export.sh", 10, 20)), from(NODE_B, at("scripts/export.sh", 18, 25))],
      LISTING,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.findings).toHaveLength(2);
    expect(groups[0]?.nodes).toEqual([NODE_A, NODE_B]);
    expect(groups[0]?.confirmed).toBe(true);
    expect(groups[0]?.blob).toBe(BLOB_EXPORT);
  });

  it("lists both paths of a group on two byte-identical files", () => {
    const groups = matchGroups(
      [from(NODE_B, at("vendor/export.sh", 18, 25)), from(NODE_A, at("scripts/export.sh", 10, 20))],
      LISTING,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.paths).toEqual(["scripts/export.sh", "vendor/export.sh"]);
    expect(groups[0]?.confirmed).toBe(true);
  });

  it("keeps destination findings that name different hosts in separate, unconfirmed groups", () => {
    const one = finding({ location: { path: "README.md", start: 3, end: 4 } });
    const other = finding({ location: { path: "README.md", start: 3, end: 4 }, host: "cdn.other-vendor.example" });
    const groups = matchGroups([from(NODE_A, one), from(NODE_B, other)], LISTING);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.confirmed)).toEqual([false, false]);
    expect(groups.map((group) => group.host).sort()).toEqual(["cdn.other-vendor.example", HOST]);
  });

  it("keeps findings that do not match in separate, unconfirmed groups", () => {
    const groups = matchGroups(
      [from(NODE_A, at("scripts/export.sh", 10, 20)), from(NODE_B, at("scripts/export.sh", 21, 25))],
      LISTING,
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.confirmed)).toEqual([false, false]);
    expect(groups.map((group) => group.nodes)).toEqual([[NODE_A], [NODE_B]]);
  });

  it("splits groups between two lines, and joins them on a shared line or under a wider finding", () => {
    const nodes = [NODE_A, NODE_B, NODE_C];
    const groupsOf = (...ranges: (readonly [start: number, end: number])[]) =>
      matchGroups(
        ranges.map(([start, end], i) => from(nodes[i] ?? NODE_A, at("scripts/export.sh", start, end))),
        LISTING,
      );
    expect(groupsOf([10, 20], [21, 25])).toHaveLength(2);
    expect(groupsOf([10, 20], [20, 25])).toHaveLength(1);
    // The last two share no line with each other. The first holds both.
    const held = groupsOf([10, 50], [12, 14], [40, 45]);
    expect(held).toHaveLength(1);
    expect(held[0]?.findings).toHaveLength(3);
  });

  it("joins a chain of overlapping findings into one group", () => {
    const groups = matchGroups(
      [
        from(NODE_C, at("scripts/export.sh", 24, 30)),
        from(NODE_A, at("scripts/export.sh", 10, 20)),
        from(NODE_B, at("scripts/export.sh", 18, 25)),
      ],
      LISTING,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.findings.map((member) => member.record.location.start)).toEqual([10, 18, 24]);
    expect(groups[0]?.nodes).toEqual([NODE_A, NODE_B, NODE_C]);
  });

  it("confirms a finding with one author and one confirming re-check from a second node", () => {
    const found = from(NODE_A, at("scripts/export.sh", 10, 20));
    const groups = matchGroups([found, from(NODE_B, recheck({ finding: found.id }))], LISTING);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.nodes).toEqual([NODE_A, NODE_B]);
    expect(groups[0]?.confirmed).toBe(true);
    expect(groups[0]?.rechecks).toHaveLength(1);
  });

  it("does not confirm a finding with one author and a counter-finding", () => {
    const found = from(NODE_A, at("scripts/export.sh", 10, 20));
    const dispute = from(NODE_C, counterFinding({ finding: found.id }));
    const groups = matchGroups([found, dispute], LISTING);
    expect(groups[0]?.nodes).toEqual([NODE_A]);
    expect(groups[0]?.confirmed).toBe(false);
    expect(groups[0]?.counterFindings).toEqual([dispute]);
  });

  it("confirms a finding with two authors and a counter-finding, and keeps the dispute beside it", () => {
    const one = from(NODE_A, at("scripts/export.sh", 10, 20));
    const two = from(NODE_B, at("scripts/export.sh", 12, 14));
    const dispute = from(NODE_C, counterFinding({ finding: two.id }));
    const groups = matchGroups([one, two, dispute], LISTING);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.nodes).toEqual([NODE_A, NODE_B]);
    expect(groups[0]?.confirmed).toBe(true);
    expect(groups[0]?.counterFindings).toEqual([dispute]);
  });

  it("counts an organization once, whatever it publishes", () => {
    const one = from(NODE_A, at("scripts/export.sh", 10, 20));
    const again = from(NODE_A, at("scripts/export.sh", 12, 14));
    const own = from(NODE_A, recheck({ finding: one.id }));
    const groups = matchGroups([one, again, own], LISTING);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.nodes).toEqual([NODE_A]);
    expect(groups[0]?.confirmed).toBe(false);
  });

  it("counts two nodes that publish the same finding record as two organizations", () => {
    const record = at("scripts/export.sh", 10, 20);
    const groups = matchGroups([from(NODE_A, record, sha("a")), from(NODE_B, record, sha("a"))], LISTING);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.nodes).toEqual([NODE_A, NODE_B]);
    expect(groups[0]?.confirmed).toBe(true);
  });

  it("does not count a re-check of a finding in another group", () => {
    const one = from(NODE_A, at("scripts/export.sh", 10, 20));
    const far = from(NODE_A, at("scripts/sync.sh", 1, 2));
    const groups = matchGroups([one, far, from(NODE_B, recheck({ finding: far.id }))], LISTING);
    const confirmed = groups.filter((group) => group.confirmed);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.paths).toEqual(["scripts/sync.sh"]);
  });

  it("leaves out a finding whose path is not in the listing, and ignores other record types", () => {
    const groups = matchGroups(
      [from(NODE_A, at("scripts/missing.sh", 1, 2)), from(NODE_B, patchRecheck())],
      LISTING,
    );
    expect(groups).toEqual([]);
  });

  it("gives the same groups whatever the order of the records", () => {
    const records = [
      from(NODE_A, at("scripts/export.sh", 10, 20)),
      from(NODE_B, at("vendor/export.sh", 18, 25)),
      from(NODE_C, at("scripts/sync.sh", 3, 4)),
      from(NODE_B, at("README.md", 1, 1)),
    ];
    expect(matchGroups([...records].reverse(), LISTING)).toEqual(matchGroups(records, LISTING));
  });

  it("is confirmed at two organizations", () => {
    expect(isConfirmed([NODE_A])).toBe(false);
    expect(isConfirmed([NODE_A, NODE_B])).toBe(true);
  });
});

describe("confirmation per criterion (R10)", () => {
  const under = (criterion: Criterion): Finding => at("scripts/export.sh", 10, 20, { criterion });
  const groupOf = (records: readonly Sourced[]): MatchGroup | undefined => {
    const groups = matchGroups(records, LISTING);
    expect(groups).toHaveLength(1);
    return groups[0];
  };
  /** Whether the early rejection check rejects for a lens that requires these criteria. */
  const rejects = (group: MatchGroup | undefined, required: readonly Criterion[]): boolean =>
    (group?.criteria ?? []).some(
      (count) => count.confirmed && countsAgainstLens({ criterion: count.criterion }, { required, approvedHosts: [] }),
    );

  it("covers AE12: confirms what two nodes saw, and no criterion, when they name unrelated criteria", () => {
    const group = groupOf([from(NODE_A, under("works-as-documented")), from(NODE_B, under("safe-to-read"))]);
    expect(group).toMatchObject({ nodes: [NODE_A, NODE_B], confirmed: true });
    expect(group?.criteria).toEqual([
      { criterion: "safe-to-read", nodes: [NODE_B], confirmed: false },
      { criterion: "safe-to-run-sandboxed", nodes: [NODE_B], confirmed: false },
      { criterion: "safe-to-run-with-access", nodes: [NODE_B], confirmed: false },
      { criterion: "works-as-documented", nodes: [NODE_A], confirmed: false },
    ]);
    expect(rejects(group, ["safe-to-read"])).toBe(false);
    expect(rejects(group, ["safe-to-run-with-access", "works-as-documented"])).toBe(false);
  });

  it("covers AE12: counts a finding against a weaker criterion toward every stricter one", () => {
    const group = groupOf([from(NODE_A, under("safe-to-read")), from(NODE_B, under("safe-to-run-with-access"))]);
    expect(group?.criteria).toEqual([
      { criterion: "safe-to-read", nodes: [NODE_A], confirmed: false },
      { criterion: "safe-to-run-sandboxed", nodes: [NODE_A], confirmed: false },
      { criterion: "safe-to-run-with-access", nodes: [NODE_A, NODE_B], confirmed: true },
    ]);
    expect(rejects(group, ["safe-to-run-with-access"])).toBe(true);
    expect(rejects(group, ["safe-to-run-sandboxed"])).toBe(false);
    expect(rejects(group, ["safe-to-read"])).toBe(false);
  });

  it("confirms the criterion that two nodes both name", () => {
    const group = groupOf([from(NODE_A, under("works-as-documented")), from(NODE_B, under("works-as-documented"))]);
    expect(group?.criteria).toEqual([{ criterion: "works-as-documented", nodes: [NODE_A, NODE_B], confirmed: true }]);
    expect(rejects(group, ["works-as-documented"])).toBe(true);
    expect(rejects(group, ["safe-to-run-with-access"])).toBe(false);
  });

  it("counts a re-check under the criterion of the finding it confirms", () => {
    const first = from(NODE_A, under("safe-to-run-sandboxed"));
    const second = from(NODE_B, under("works-as-documented"));
    const group = groupOf([first, second, from(NODE_C, recheck({ finding: first.id }))]);
    expect(group?.nodes).toEqual([NODE_A, NODE_B, NODE_C]);
    expect(group?.criteria).toEqual([
      { criterion: "safe-to-run-sandboxed", nodes: [NODE_A, NODE_C], confirmed: true },
      { criterion: "safe-to-run-with-access", nodes: [NODE_A, NODE_C], confirmed: true },
      { criterion: "works-as-documented", nodes: [NODE_B], confirmed: false },
    ]);
  });

  it("counts an organization once under a criterion, whatever it publishes", () => {
    const first = from(NODE_A, under("safe-to-read"));
    const group = groupOf([
      first,
      from(NODE_A, under("safe-to-run-sandboxed")),
      from(NODE_A, recheck({ finding: first.id })),
    ]);
    expect(group?.criteria.map((count) => [count.criterion, count.nodes, count.confirmed])).toEqual([
      ["safe-to-read", [NODE_A], false],
      ["safe-to-run-sandboxed", [NODE_A], false],
      ["safe-to-run-with-access", [NODE_A], false],
    ]);
  });
});

describe("patch confirmations, counted per patch ID (R24)", () => {
  const PATCH_ID = sha("d");

  it("counts two for a patch ID with two authoring nodes", () => {
    const authors = [
      { node: NODE_A, patchId: PATCH_ID },
      { node: NODE_B, patchId: PATCH_ID },
    ];
    expect(patchConfirmations(PATCH_ID, authors, [])).toEqual([NODE_A, NODE_B]);
  });

  it("counts two for one author and one `resolves` re-check from another node", () => {
    const authors = [{ node: NODE_A, patchId: PATCH_ID }];
    const rechecks = [from(NODE_B, patchRecheck({ patch: PATCH_ID, verdict: "resolves" }))];
    expect(patchConfirmations(PATCH_ID, authors, rechecks)).toEqual([NODE_A, NODE_B]);
  });

  it("does not count a re-check with another verdict", () => {
    const authors = [{ node: NODE_A, patchId: PATCH_ID }];
    const rechecks = [
      from(NODE_B, patchRecheck({ patch: PATCH_ID, verdict: "does-not-resolve" })),
      from(NODE_C, patchRecheck({ patch: PATCH_ID, verdict: "does-more" })),
    ];
    expect(patchConfirmations(PATCH_ID, authors, rechecks)).toEqual([NODE_A]);
  });

  it("does not count an author or a re-check of another patch ID, and counts a node once", () => {
    const authors = [
      { node: NODE_A, patchId: PATCH_ID },
      { node: NODE_A, patchId: PATCH_ID },
      { node: NODE_B, patchId: sha("e") },
    ];
    const rechecks = [
      from(NODE_A, patchRecheck({ patch: PATCH_ID, verdict: "resolves" })),
      from(NODE_C, patchRecheck({ patch: sha("e"), verdict: "resolves" })),
      from(NODE_C, recheck()),
    ];
    expect(patchConfirmations(PATCH_ID, authors, rechecks)).toEqual([NODE_A]);
  });
});
