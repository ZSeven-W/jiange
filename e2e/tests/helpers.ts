import { expect, type Page } from "@playwright/test";
import { apiURL, E2E_API_URL, E2E_BASE_URL } from "../playwright.config";

export { apiURL, E2E_API_URL, E2E_BASE_URL };

export interface FreshUser {
  email: string;
  name: string;
  password: string;
  userId: number;
  workspaceId: number;
  workspaceName: string;
}

interface MePayload {
  user: { id: number; email: string; name: string };
  workspaces: Array<{ id: number; name: string; ownerId: number }>;
}

/**
 * Generates a unique suffix suitable for isolated E2E accounts, titles, and tokens.
 */
export function uniqueTag(prefix = "e2e"): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}`;
}

/**
 * Registers a brand-new isolated user and ensures the browser is signed in on Workspace Home.
 *
 * - `via: "api"` (default): registers via `/api/auth/register` through the browser context's
 *   request jar (fast & deterministic), then navigates to `#/`.
 * - `via: "ui"`: walks through the real Login/Register page form in `apps/web/src/pages/login.tsx`.
 */
export async function registerFreshUser(
  page: Page,
  prefix = "e2e",
  options: { via?: "api" | "ui" } = {},
): Promise<FreshUser> {
  const via = options.via ?? "api";
  const tag = uniqueTag(prefix);
  const email = `${tag}@jiange.test`;
  const name = `E2E ${prefix} ${tag.slice(-6)}`;
  const password = `Jiange!${tag.slice(-8)}A1`;

  if (via === "ui") {
    await page.goto("/#/");
    await page.locator("#email").waitFor({ state: "visible" });

    // Toggle from Login mode to Register mode ("免费注册" / "Sign up")
    const switchBtn = page.locator("form p button[type='button']").last();
    await switchBtn.click();
    await page.locator("#name").waitFor({ state: "visible" });

    await page.locator("#email").fill(email);
    await page.locator("#name").fill(name);
    await page.locator("#password").fill(password);

    const registerRespPromise = page.waitForResponse(
      (res) => res.url().includes("/api/auth/register") && res.request().method() === "POST",
    );
    await page.locator("form button[type='submit']").click();
    const registerResp = await registerRespPromise;
    expect(registerResp.status(), "Expected /api/auth/register to succeed").toBe(201);
    const me = (await registerResp.json()) as MePayload;

    await page.locator("[data-active-workspace-name]").waitFor({ state: "visible" });

    return {
      email,
      name,
      password,
      userId: me.user.id,
      workspaceId: me.workspaces[0]?.id ?? 0,
      workspaceName: me.workspaces[0]?.name ?? "",
    };
  }

  // API registration via the browser context's cookie jar so session cookies apply immediately.
  const res = await page.request.post("/api/auth/register", {
    data: { email, name, password },
  });
  expect(res.status(), `Failed to register fresh user ${email}: ${await res.text()}`).toBe(201);
  const me = (await res.json()) as MePayload;

  await page.goto("/#/");
  await page.locator("[data-active-workspace-name]").waitFor({ state: "visible" });

  return {
    email,
    name,
    password,
    userId: me.user.id,
    workspaceId: me.workspaces[0]?.id ?? 0,
    workspaceName: me.workspaces[0]?.name ?? "",
  };
}

/**
 * Verifies Jiange's Feishu design rule: zero native `<select>` elements rendered in the DOM
 * (all dropdowns use `FeishuSelect`).
 */
export async function assertZeroNativeSelects(page: Page, contextLabel = "current view"): Promise<void> {
  const selectCount = await page.locator("select").count();
  expect(selectCount, `Expected zero native <select> elements in ${contextLabel}`).toBe(0);
}

export interface ConsoleErrorCollector {
  consoleErrors: string[];
  pageErrors: string[];
  clear: () => void;
  assertNoErrors: (options?: { ignoreNetworkErrors?: boolean }) => void;
}

const NETWORK_NOISE_PATTERNS = [
  /net::ERR_INTERNET_DISCONNECTED/i,
  /net::ERR_FAILED/i,
  /Failed to load resource/i,
  /Failed to fetch/i,
  /WebSocket connection to/i,
];

/**
 * Attaches listeners to capture browser console errors and uncaught page exceptions.
 */
export function collectConsoleErrors(page: Page): ConsoleErrorCollector {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.stack || err.message || String(err));
  });

  return {
    consoleErrors,
    pageErrors,
    clear: () => {
      consoleErrors.length = 0;
      pageErrors.length = 0;
    },
    assertNoErrors: (options = {}) => {
      expect(pageErrors, `Uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
      const relevant = options.ignoreNetworkErrors
        ? consoleErrors.filter((line) => !NETWORK_NOISE_PATTERNS.some((re) => re.test(line)))
        : consoleErrors;
      expect(relevant, `Browser console errors:\n${relevant.join("\n")}`).toEqual([]);
    },
  };
}

/**
 * Opens the sidebar account & workspace switcher popover menu.
 */
export async function openAccountMenu(page: Page): Promise<void> {
  const trigger = page.locator("aside button", {
    has: page.locator("[data-active-workspace-name]"),
  });
  await trigger.waitFor({ state: "visible" });
  const expanded = await trigger.getAttribute("aria-expanded");
  if (expanded !== "true") {
    await trigger.click();
  }
  await page.locator("[data-create-workspace-btn]").waitFor({ state: "visible" });
}
