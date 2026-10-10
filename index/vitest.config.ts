import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Every file under these folders of the repo's fixtures, as text, by its path under `fixtures/`. */
function fixtures(...folders: readonly string[]): { [path: string]: string } {
  const files: { [path: string]: string } = {};
  for (const folder of folders) {
    for (const entry of readdirSync(join(FIXTURES, folder), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      files[file.slice(FIXTURES.length)] = readFileSync(file, "utf8");
    }
  }
  return files;
}

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
      miniflare: {
        bindings: {
          // The migrations are read here, in Node, and each test file applies them to its database.
          MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
          // A test in the Workers runtime reads no file. The demo plugin's first commit and
          // the hand-made patch on it are read here, and are data to every test (KTD26).
          FIXTURES: fixtures("demo-plugin/first", "out-of-scope"),
        },
      },
    })),
  ],
});
