import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The package's own config: without this file `npm test` here would pick up the
// workspace config in the parent directory.
//
// The tests run inside the Workers runtime, with the bindings of the Wrangler config
// (KTD29). The database and the queue are local. Each test puts in-memory fakes in place
// of the Artifacts binding and the queue.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Artifacts has no local simulation, so the pool would open a session on the
      // developer's Cloudflare account to reach it. A test never calls the live service
      // (KTD29), so that stays off.
      remoteBindings: false,
      // The migrations are read here, in Node, and each test file applies them to its database.
      miniflare: { bindings: { MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))) } },
    })),
  ],
});
