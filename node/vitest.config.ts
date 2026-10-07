import { defineConfig } from "vitest/config";

// Self-contained on purpose: without this file Vitest would pick up the
// workspace config in the parent directory.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
