import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Self-contained on purpose: without this file Vitest would pick up the
// workspace config in the parent directory.
//
// The tests run inside the Workers runtime, with the bindings of the Wrangler config
// (KTD29). Each test puts the in-memory fake in place of the Artifacts binding.

/** The Workers pool over the Wrangler config, with these variables set on top of it. */
function workersPool(variables: { readonly [name: string]: string } = {}) {
  return cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    // Artifacts has no local simulation, so the pool would open a session on the
    // developer's Cloudflare account to reach it. A test never calls the live service
    // (KTD29), so that stays off.
    remoteBindings: false,
    miniflare: { bindings: variables },
  });
}

// The Workflow engine gives the Workflow the variables of its Worker, so the tests of a
// node that has an index address run as a second project. Its files end in `.indexed.test.ts`.
const INDEXED = "test/**/*.indexed.test.ts";
// A third project has an index address and no base URL of its own. Its files end in `.nameless.test.ts`.
const NAMELESS = "test/**/*.nameless.test.ts";
// A fourth has an index address and a base URL with a path. Its files end in `.pathed.test.ts`.
const PATHED = "test/**/*.pathed.test.ts";
// A fifth has its own base URL and an index address with a slash at its end. Its files end in `.slashed.test.ts`.
const SLASHED = "test/**/*.slashed.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [workersPool()],
        test: { name: "node", include: ["test/**/*.test.ts"], exclude: [INDEXED, NAMELESS, PATHED, SLASHED] },
      },
      {
        plugins: [
          workersPool({ NODE_URL: "https://node.team-a.example", INDEX_URL: "https://index.cairnfield.example" }),
        ],
        test: { name: "node with an index", include: [INDEXED] },
      },
      {
        plugins: [workersPool({ INDEX_URL: "https://index.cairnfield.example" })],
        test: { name: "node with an index and no address of its own", include: [NAMELESS] },
      },
      {
        plugins: [
          workersPool({ NODE_URL: "https://nodes.cairnfield.example/team-a", INDEX_URL: "https://index.cairnfield.example" }),
        ],
        test: { name: "node with an index and an address with a path", include: [PATHED] },
      },
      {
        plugins: [
          workersPool({ NODE_URL: "https://node.team-a.example", INDEX_URL: "https://index.cairnfield.example/" }),
        ],
        test: { name: "node with an index address that ends in a slash", include: [SLASHED] },
      },
    ],
  },
});
