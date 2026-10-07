import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, recordId } from "../src/canonical.ts";
import { gitBlobHash, sha256Hex } from "../src/hash.ts";
import { utf8 } from "./fixtures.ts";


describe("canonical JSON", () => {
  it("sorts keys at every depth and writes no whitespace", () => {
    const value = { b: 1, a: [2, { d: "x", c: "y" }] };
    expect(canonicalJson(value)).toBe('{"a":[2,{"c":"y","d":"x"}],"b":1}');
  });

  it("keeps array order", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
  });

  it("writes strings as JSON strings", () => {
    expect(canonicalJson({ a: 'q"\\\n' })).toBe('{"a":"q\\"\\\\\\n"}');
  });

  it("writes integers, with negative zero as zero", () => {
    expect(canonicalJson([0, -0, 7, -3])).toBe("[0,0,7,-3]");
  });

  it("refuses a number that is not a safe integer", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ a: 2 ** 53 })).toThrow();
  });

  it("refuses a value that JSON cannot hold", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson(new Date(0))).toThrow();
  });

  it("gives one form for the same fields in a different key order", () => {
    const one = { type: "finding", version: "1", start: 3 };
    const two = { start: 3, version: "1", type: "finding" };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });
});

describe("hashes", () => {
  it("computes SHA-256 as lower-case hexadecimal", async () => {
    expect(await sha256Hex(utf8(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const text = "cairnfield";
    expect(await sha256Hex(utf8(text))).toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("computes the Git blob hash of file content", async () => {
    // `git hash-object` gives these two values.
    expect(await gitBlobHash(utf8(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await gitBlobHash(utf8("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("hashes the bytes of a view into a larger buffer", async () => {
    const whole = utf8("xxhello\nxx");
    expect(await gitBlobHash(whole.subarray(2, 8))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("record ID", () => {
  it("is the SHA-256 of the canonical JSON", async () => {
    const record = { version: "1", type: "claim", number: 4 };
    const expected = createHash("sha256").update('{"number":4,"type":"claim","version":"1"}').digest("hex");
    expect(await recordId(record)).toBe(expected);
  });

  it("is the same for the same fields in a different key order", async () => {
    const one = { version: "1", type: "claim", number: 4, at: { path: "a", start: 1 } };
    const two = { at: { start: 1, path: "a" }, number: 4, type: "claim", version: "1" };
    expect(await recordId(one)).toBe(await recordId(two));
  });

  it("differs when one field differs", async () => {
    expect(await recordId({ number: 4 })).not.toBe(await recordId({ number: 5 }));
  });
});
