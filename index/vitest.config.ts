import { defineConfig } from "vitest/config";

// The package's own config: without this file `npm test` here would pick up the
// workspace config in the parent directory.
export default defineConfig({
  test: {
    // Goes when this package gets its first test.
    passWithNoTests: true,
  },
});
