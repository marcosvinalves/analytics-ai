import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/integration/setup.ts"],
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
