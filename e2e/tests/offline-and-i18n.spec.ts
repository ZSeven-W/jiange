import { expect, test } from "@playwright/test";
import {
  assertZeroNativeSelects,
  collectConsoleErrors,
  registerFreshUser,
} from "./helpers";

test.describe("Internationalization (i18n) & Offline Resilience", () => {
  test("switches between Chinese and English across navigation and Organization admin labels", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await registerFreshUser(page, "i18n");
    errors.clear();

    const localeToggle = page.locator("[data-locale-toggle]").first();
    await expect(localeToggle).toBeVisible();

    // Ensure starting state is Chinese (zh-CN)
    const sidebarNav = page.locator("aside nav");
    if ((await localeToggle.innerText()).trim() === "中") {
      await localeToggle.click();
    }
    await expect(sidebarNav).toContainText("主页");
    await expect(sidebarNav).toContainText("云盘");
    await expect(sidebarNav).toContainText("知识库");
    await expect(sidebarNav).toContainText("组织架构");
    await expect(sidebarNav).toContainText("回收站");

    // Switch to English
    await localeToggle.click();
    await expect(sidebarNav).toContainText("Home");
    await expect(sidebarNav).toContainText("Drive");
    await expect(sidebarNav).toContainText("Wiki");
    await expect(sidebarNav).toContainText("Organization");
    await expect(sidebarNav).toContainText("Trash");

    // Navigate to #/org and verify Organization labels render in English
    await page.goto("/#/org");
    await expect(page.locator("[data-org-page]")).toBeVisible();
    await expect(page.locator("[data-org-page] h1")).toHaveText("Organization");
    await expect(page.locator("[data-org-tab='departments']")).toHaveText("Departments");
    await expect(page.locator("[data-org-tab='groups']")).toHaveText("User groups");
    await expect(page.locator("[data-org-tab='members']")).toHaveText("Workspace members");
    await expect(page.locator("[data-org-tab='sso']")).toHaveText("Single Sign-On (SSO)");
    await expect(page.locator("[data-org-tab='security']")).toHaveText("Audit & Watermark");
    await expect(page.locator("[data-org-tab='developer']")).toHaveText("Open API & SCIM");
    await assertZeroNativeSelects(page, "Org page (English)");

    // Switch back to Chinese
    await page.locator("[data-locale-toggle]").first().click();
    await expect(page.locator("[data-org-page] h1")).toHaveText("组织架构");
    await expect(page.locator("[data-org-tab='departments']")).toHaveText("部门架构");
    await expect(page.locator("[data-org-tab='security']")).toHaveText("安全审计与水印");
    await expect(page.locator("[data-org-tab='developer']")).toHaveText("开放 API 与 SCIM");
    await expect(sidebarNav).toContainText("主页");

    errors.assertNoErrors();
  });

  test("handles offline mode gracefully with offline banner and recovers when back online", async ({
    page,
    context,
  }) => {
    const errors = collectConsoleErrors(page);
    await registerFreshUser(page, "offline");
    errors.clear();

    // Ensure Home is rendered and online before going offline
    await expect(page.locator("main h1")).toBeVisible();

    try {
      // Simulate network disconnection
      await context.setOffline(true);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
      });

      // Verify offline banner appears gracefully
      const offlineBanner = page.locator("[data-offline-banner]");
      await expect(offlineBanner).toBeVisible();
      await expect(offlineBanner.locator("[data-offline-drawer-btn]")).toBeVisible();

      // App should remain interactive without crashing while offline
      await offlineBanner.locator("[data-offline-drawer-btn]").click();
      await expect(page.locator("[role='dialog']")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("aside nav")).toBeVisible();
      await assertZeroNativeSelects(page, "Offline state");
    } finally {
      // Always restore online connectivity even if an assertion fails
      await context.setOffline(false);
    }

    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
    });

    // Offline banner should clear and app should recover cleanly
    await expect(page.locator("[data-offline-banner]")).toBeHidden({ timeout: 10_000 });

    // Confirm live navigation works after reconnection
    await page.goto("/#/org");
    await expect(page.locator("[data-org-page]")).toBeVisible();

    // Assert zero uncaught page crashes (expected net::ERR_INTERNET_DISCONNECTED console logs ignored)
    errors.assertNoErrors({ ignoreNetworkErrors: true });
  });
});
