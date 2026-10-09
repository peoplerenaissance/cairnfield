import { defineConfig } from "vitest/config";

// The package's own config: without this file `npm test` here would pick up the
// workspace config in the parent directory. A run that finds no test fails.
export default defineConfig({});
