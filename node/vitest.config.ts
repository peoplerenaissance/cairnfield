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

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [workersPool()],
        test: { name: "node", include: ["test/**/*.test.ts"], exclude: [INDEXED] },
      },
      {
        plugins: [
          workersPool({ NODE_URL: "https://node.team-a.example", INDEX_URL: "https://index.cairnfield.example" }),
        ],
        test: { name: "node with an index", include: [INDEXED] },
      },
    ],
  },
});
