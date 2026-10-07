import { describe, expect, it } from "vitest";
import { countsAgainst, countsAgainstLens, implied } from "../src/criteria.ts";
import type { LensRule } from "../src/criteria.ts";
import { CRITERIA } from "../src/enums.ts";
import { HOST } from "./fixtures.ts";

describe("the implication order of R5", () => {
  it("has a stricter criterion imply every weaker one", () => {
    expect(implied("safe-to-run-with-access")).toEqual(["safe-to-read", "safe-to-run-sandboxed"]);
    expect(implied("safe-to-run-sandboxed")).toEqual(["safe-to-read"]);
    expect(implied("safe-to-read")).toEqual([]);
  });

  it("keeps works-as-documented apart", () => {
    expect(implied("works-as-documented")).toEqual([]);
  });

  it("counts a finding against safe-to-run-sandboxed against safe-to-run-with-access", () => {
    expect(countsAgainst("safe-to-run-sandboxed", "safe-to-run-with-access")).toBe(true);
  });

  it("does not count a finding against safe-to-run-sandboxed against safe-to-read", () => {
    expect(countsAgainst("safe-to-run-sandboxed", "safe-to-read")).toBe(false);
  });

  it("counts a finding against its own criterion and against every stricter one", () => {
    expect(CRITERIA.filter((required) => countsAgainst("safe-to-read", required))).toEqual([
      "safe-to-read",
      "safe-to-run-sandboxed",
      "safe-to-run-with-access",
    ]);
    expect(CRITERIA.filter((required) => countsAgainst("safe-to-run-with-access", required))).toEqual([
      "safe-to-run-with-access",
    ]);
  });

  it("counts a finding against works-as-documented against no safety criterion", () => {
    expect(CRITERIA.filter((required) => countsAgainst("works-as-documented", required))).toEqual([
      "works-as-documented",
    ]);
  });

  it("counts no safety finding against works-as-documented", () => {
    expect(countsAgainst("safe-to-read", "works-as-documented")).toBe(false);
    expect(countsAgainst("safe-to-run-with-access", "works-as-documented")).toBe(false);
  });
});

describe("the lens rule of R23", () => {
  const strict: LensRule = { required: ["safe-to-run-with-access"], approvedHosts: [] };
  const approving: LensRule = { required: ["safe-to-run-with-access"], approvedHosts: [HOST] };
  const destination = { criterion: "safe-to-run-with-access", host: HOST } as const;

  it("covers AE9: counts a destination finding against a lens that does not list its host", () => {
    expect(countsAgainstLens(destination, strict)).toBe(true);
  });

  it("covers AE9: does not count it against a lens that lists its host", () => {
    expect(countsAgainstLens(destination, approving)).toBe(false);
  });

  it("approves a host only by its exact name", () => {
    const parent: LensRule = { required: ["safe-to-run-with-access"], approvedHosts: ["harbor-metrics.example"] };
    expect(countsAgainstLens(destination, parent)).toBe(true);
    const other: LensRule = { required: ["safe-to-run-with-access"], approvedHosts: ["cdn.other-vendor.example"] };
    expect(countsAgainstLens(destination, other)).toBe(true);
  });

  it("counts a finding with no host whatever the approved hosts", () => {
    expect(countsAgainstLens({ criterion: "safe-to-run-with-access" }, approving)).toBe(true);
  });

  it("counts a finding against a weaker criterion against a lens that requires a stricter one", () => {
    expect(countsAgainstLens({ criterion: "safe-to-read" }, strict)).toBe(true);
  });

  it("does not count a finding against a criterion the lens does not require", () => {
    const readOnly: LensRule = { required: ["safe-to-read"], approvedHosts: [] };
    expect(countsAgainstLens(destination, readOnly)).toBe(false);
    expect(countsAgainstLens({ criterion: "works-as-documented" }, strict)).toBe(false);
    expect(countsAgainstLens(destination, { required: [], approvedHosts: [] })).toBe(false);
  });

  it("applies each criterion a lens requires", () => {
    const both: LensRule = { required: ["safe-to-read", "works-as-documented"], approvedHosts: [] };
    expect(countsAgainstLens({ criterion: "works-as-documented" }, both)).toBe(true);
    expect(countsAgainstLens({ criterion: "safe-to-read" }, both)).toBe(true);
    expect(countsAgainstLens({ criterion: "safe-to-run-sandboxed" }, both)).toBe(false);
  });
});
