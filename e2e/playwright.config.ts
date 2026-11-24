import { defineConfig, devices } from "@playwright/test";

/**
 * Base URL for the Jiange Web SPA (Vite dev server locally or embedded Go binary in CI).
 */
export const E2E_BASE_URL = (process.env.E2E_BASE_URL || "http://127.0.0.1:5173").replace(/\/+$/, "");

/**
 * Direct base URL for the Jiange Go API server (used for probes, /metrics, OpenAPI, SCIM).
 */
export const E2E_API_URL = (process.env.E2E_API_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");

/**
 * Resolves an absolute URL against the Jiange Go API server.
 */
export function apiURL(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${E2E_API_URL}${normalized}`;
}

export default defineConfig({
  testDir: "./tests",
  outputDir: "../test-results",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "../playwright-report" }],
  ],
  use: {
    baseURL: E2E_BASE_URL,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 25_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        locale: "zh-CN",
        ...(process.env.E2E_BROWSER_CHANNEL
          ? { channel: process.env.E2E_BROWSER_CHANNEL }
          : {}),
      },
    },
  ],
});
