import { defineConfig } from "vitest/config";

// `node/` and `site/` are self-contained and run their own checks.
export default defineConfig({
  test: {
    projects: ["protocol", "index", "cli", "sim"],
    passWithNoTests: true,
  },
});
