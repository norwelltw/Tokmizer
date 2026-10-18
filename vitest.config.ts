import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    include: ["packages/**/__tests__/**/*.test.ts", "packages/**/src/**/*.test.ts"]
  }
});
