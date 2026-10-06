import path from "node:path";
import { defineConfig } from "@playwright/test";

const workspaceId = "10000000-0000-4000-8000-000000000029";
const baseURL = "http://127.0.0.1:3019";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "dashboard-page.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL,
    browserName: "chromium",
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: true,
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3019",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      ENABLE_LOCAL_UPLOAD: "true",
      DEV_UPLOAD_WORKSPACE_ID: workspaceId,
      LOCAL_UPLOAD_ORIGIN: baseURL,
      LOCAL_STORAGE_ROOT: path.resolve(".local/dashboard-e2e-storage"),
    },
  },
});
