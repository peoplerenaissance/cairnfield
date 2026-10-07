import { describe, expect, it } from "vitest";
import {
  MAX_BLOB_BYTES,
  MAX_FETCH_BYTES,
  MAX_HOSTNAME_LENGTH,
  MAX_LISTING_ENTRIES,
  MAX_PATCH_LINES,
  MAX_PATCH_REPLACEMENTS,
  MAX_PATH_LENGTH,
  MAX_RECORD_BYTES,
  MAX_RECORDS_PER_COMPONENT,
  MAX_URL_LENGTH,
  isBranchName,
  isCommit,
  isHostname,
  isHttpsUrl,
  isNodeUrl,
  isNamespaceName,
  isPath,
  isRepoName,
  isSha256,
} from "../src/limits.ts";
import {
  GOOD_NODE_URLS,
  GOOD_URLS,
  NODE_A,
  NODE_URLS_NOT_SERIALIZED,
  NODE_URLS_OFF_PATTERN,
  URLS_NOT_SERIALIZED,
  URLS_OFF_PATTERN,
} from "./fixtures.ts";

describe("limits of KTD6", () => {
  it("holds the plan's numbers", () => {
    expect(MAX_HOSTNAME_LENGTH).toBe(253);
    expect(MAX_PATCH_REPLACEMENTS).toBe(3);
    expect(MAX_PATCH_LINES).toBe(60);
    expect(MAX_PATH_LENGTH).toBe(200);
    expect(MAX_RECORD_BYTES).toBe(4096);
    expect(MAX_LISTING_ENTRIES).toBe(5000);
    expect(MAX_RECORDS_PER_COMPONENT).toBe(500);
    expect(MAX_BLOB_BYTES).toBe(256 * 1024);
    expect(MAX_FETCH_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe("commit", () => {
  const commit = "3f".repeat(20);

  it("accepts 40 lower-case hexadecimal characters", () => {
    expect(isCommit(commit)).toBe(true);
  });

  it("rejects a commit of 39 characters", () => {
    expect(isCommit(commit.slice(1))).toBe(false);
  });

  it("rejects a commit with an upper-case letter", () => {
    expect(isCommit(`A${commit.slice(1)}`)).toBe(false);
  });

  it("rejects 41 characters, other letters and other types", () => {
    expect(isCommit(`${commit}0`)).toBe(false);
    expect(isCommit(`g${commit.slice(1)}`)).toBe(false);
    expect(isCommit(`${commit.slice(1)}\n`)).toBe(false);
    expect(isCommit(40)).toBe(false);
  });
});

describe("sha256", () => {
  it("accepts 64 lower-case hexadecimal characters only", () => {
    expect(isSha256("ab".repeat(32))).toBe(true);
    expect(isSha256("ab".repeat(31))).toBe(false);
    expect(isSha256("AB".repeat(32))).toBe(false);
    expect(isSha256(undefined)).toBe(false);
  });
});

describe("repo and fork name", () => {
  it("accepts a name that starts with a lower-case letter or a digit", () => {
    expect(isRepoName("team-a_records.v1")).toBe(true);
    expect(isRepoName("9lives")).toBe(true);
    expect(isRepoName("a")).toBe(true);
  });

  it("rejects a fork name that starts with a hyphen, a dot or an underscore", () => {
    expect(isRepoName("-fork")).toBe(false);
    expect(isRepoName(".fork")).toBe(false);
    expect(isRepoName("_fork")).toBe(false);
  });

  it("rejects upper case, a slash, a space, the empty name and an overlong name", () => {
    expect(isRepoName("Fork")).toBe(false);
    expect(isRepoName("team/fork")).toBe(false);
    expect(isRepoName("team fork")).toBe(false);
    expect(isRepoName("")).toBe(false);
    expect(isRepoName("a".repeat(101))).toBe(false);
    expect(isRepoName("a".repeat(100))).toBe(true);
  });
});

describe("namespace name", () => {
  it("accepts 2 to 63 characters under the repo name rule", () => {
    expect(isNamespaceName("cairnfield-team-a")).toBe(true);
    expect(isNamespaceName("ab")).toBe(true);
    expect(isNamespaceName("a".repeat(63))).toBe(true);
  });

  it("rejects a namespace name of 64 characters", () => {
    expect(isNamespaceName("a".repeat(64))).toBe(false);
  });

  it("rejects one character and a leading hyphen", () => {
    expect(isNamespaceName("a")).toBe(false);
    expect(isNamespaceName("-team")).toBe(false);
  });
});

describe("branch name", () => {
  it("accepts names from the fixed character set", () => {
    expect(isBranchName("main")).toBe(true);
    expect(isBranchName("variant/b-2.0_x")).toBe(true);
  });

  it("rejects a leading hyphen", () => {
    expect(isBranchName("-main")).toBe(false);
    expect(isBranchName("--upload-pack=x")).toBe(false);
  });

  it("rejects other characters, empty parts and parent parts", () => {
    expect(isBranchName("")).toBe(false);
    expect(isBranchName("a b")).toBe(false);
    expect(isBranchName("a~1")).toBe(false);
    expect(isBranchName("a:b")).toBe(false);
    expect(isBranchName("a..b")).toBe(false);
    expect(isBranchName("a//b")).toBe(false);
    expect(isBranchName("/a")).toBe(false);
    expect(isBranchName("a/")).toBe(false);
    expect(isBranchName("a".repeat(201))).toBe(false);
  });
});

describe("path", () => {
  it("accepts a relative path from the fixed character set", () => {
    expect(isPath("skills/export/run.sh")).toBe(true);
    expect(isPath(".claude-plugin/plugin.json")).toBe(true);
    expect(isPath("README.md")).toBe(true);
    expect(isPath("a..b/c")).toBe(true);
  });

  it("rejects a path with `..`", () => {
    expect(isPath("../secrets")).toBe(false);
    expect(isPath("skills/../../secrets")).toBe(false);
    expect(isPath("skills/..")).toBe(false);
  });

  it("rejects a part that starts with a hyphen, which a command reads as an option", () => {
    expect(isPath("-rf")).toBe(false);
    expect(isPath("--force")).toBe(false);
    expect(isPath("a/-b")).toBe(false);
    expect(isPath("a-b/c-d.md")).toBe(true);
  });

  it("rejects a `.git` part in any letter case", () => {
    expect(isPath(".git/config")).toBe(false);
    expect(isPath("a/.git/hooks/pre-commit")).toBe(false);
    expect(isPath("a/.git")).toBe(false);
    expect(isPath(".GIT/config")).toBe(false);
    expect(isPath(".gitignore")).toBe(true);
    expect(isPath(".github/workflows/ci.yml")).toBe(true);
    expect(isPath("a.git/b")).toBe(true);
  });

  it("rejects an absolute path", () => {
    expect(isPath("/etc/passwd")).toBe(false);
  });

  it("rejects a path longer than 200 characters", () => {
    expect(isPath("a".repeat(200))).toBe(true);
    expect(isPath("a".repeat(201))).toBe(false);
  });

  it("rejects empty parts, a single dot part, other characters and other types", () => {
    expect(isPath("")).toBe(false);
    expect(isPath("a//b")).toBe(false);
    expect(isPath("a/")).toBe(false);
    expect(isPath("./a")).toBe(false);
    expect(isPath("a/./b")).toBe(false);
    expect(isPath("a b")).toBe(false);
    expect(isPath("a\\b")).toBe(false);
    expect(isPath("a\nb")).toBe(false);
    expect(isPath("café.md")).toBe(false);
    expect(isPath(["a"])).toBe(false);
  });
});

describe("hostname", () => {
  it("accepts lower-case labels joined by dots", () => {
    expect(isHostname("collect.harbor-metrics.example")).toBe(true);
    expect(isHostname("localhost")).toBe(true);
    expect(isHostname("203.0.113.9")).toBe(true);
  });

  it("rejects an upper-case letter, a slash or a space", () => {
    expect(isHostname("Collect.harbor-metrics.example")).toBe(false);
    expect(isHostname("collect.harbor-metrics.example/ingest")).toBe(false);
    expect(isHostname("collect harbor-metrics.example")).toBe(false);
  });

  it("rejects more than 253 characters", () => {
    const label = "a".repeat(63);
    const longest = `${label}.${label}.${label}.${"a".repeat(61)}`;
    expect(longest.length).toBe(253);
    expect(isHostname(longest)).toBe(true);
    expect(isHostname(`${label}.${label}.${label}.${"a".repeat(62)}`)).toBe(false);
  });

  it("rejects empty labels, edge hyphens, a port, a scheme and other types", () => {
    expect(isHostname("")).toBe(false);
    expect(isHostname(".example")).toBe(false);
    expect(isHostname("collect..example")).toBe(false);
    expect(isHostname("collect.example.")).toBe(false);
    expect(isHostname("-collect.example")).toBe(false);
    expect(isHostname("collect-.example")).toBe(false);
    expect(isHostname("a".repeat(64))).toBe(false);
    expect(isHostname("collect.example:8443")).toBe(false);
    expect(isHostname("https://collect.example")).toBe(false);
    expect(isHostname(null)).toBe(false);
  });
});

describe("https url", () => {
  it("accepts a plain origin, an origin with a trailing slash and a Git URL with a path", () => {
    for (const value of GOOD_URLS) {
      expect(isHttpsUrl(value), value).toBe(true);
    }
  });

  it.each(URLS_OFF_PATTERN)("rejects %s", (_why, value) => {
    expect(isHttpsUrl(value)).toBe(false);
  });

  it.each(URLS_NOT_SERIALIZED)("rejects %s, which is not the serialized form", (_why, value) => {
    expect(isHttpsUrl(value)).toBe(false);
  });

  it("rejects another scheme, more than 2,048 characters and other types", () => {
    expect(isHttpsUrl("http://node.team-a.example")).toBe(false);
    const longest = `${NODE_A}/${"a".repeat(MAX_URL_LENGTH - NODE_A.length - 1)}`;
    expect(longest.length).toBe(2048);
    expect(isHttpsUrl(longest)).toBe(true);
    expect(isHttpsUrl(`${longest}a`)).toBe(false);
    expect(isHttpsUrl(new URL(NODE_A))).toBe(false);
  });
});

describe("node url (KTD8)", () => {
  it("accepts an origin, an origin with a port and a node under a path", () => {
    for (const value of GOOD_NODE_URLS) {
      expect(isNodeUrl(value), value).toBe(true);
    }
  });

  // A second spelling of one node would count as a second organization.
  it.each([...NODE_URLS_OFF_PATTERN, ...NODE_URLS_NOT_SERIALIZED, ...URLS_OFF_PATTERN])("rejects %s", (_why, value) => {
    expect(isNodeUrl(value)).toBe(false);
  });

  it("accepts a URL only as a URL parser writes it, less the last slash of a bare origin", () => {
    for (const value of GOOD_NODE_URLS) {
      const { href } = new URL(value);
      expect(href === value || (href === `${value}/` && new URL(value).pathname === "/"), value).toBe(true);
    }
  });

  it("rejects more than 2,048 characters and other types", () => {
    const longest = `${NODE_A}/${"a".repeat(MAX_URL_LENGTH - NODE_A.length - 1)}`;
    expect(isNodeUrl(longest)).toBe(true);
    expect(isNodeUrl(`${longest}a`)).toBe(false);
    expect(isNodeUrl(new URL(NODE_A))).toBe(false);
  });
});
