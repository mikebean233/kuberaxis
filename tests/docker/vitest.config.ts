import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Building the images from scratch can take a few minutes.
    hookTimeout: 15 * 60_000,
    testTimeout: 60_000,
  },
});
