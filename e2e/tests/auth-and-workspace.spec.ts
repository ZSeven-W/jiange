import { expect, test } from "@playwright/test";
import {
  assertZeroNativeSelects,
  collectConsoleErrors,
  openAccountMenu,
  registerFreshUser,
  uniqueTag,
} from "./helpers";

test.describe("Auth, Multi-Workspace Switcher & Account Security", () => {
  test("registers via UI, manages workspaces, and inspects MFA / Passkey / PAT lifecycle", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);

    // 1. Register fresh user through the live Login/Register UI -> lands in Workspace Home (#/)
    const user = await registerFreshUser(page, "auth", { via: "ui" });
    expect(page.url()).toMatch(/#\/?$/);
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator("[data-active-workspace-name]")).toBeVisible();
    await assertZeroNativeSelects(page, "Workspace Home");

    // Ensure no uncaught page errors occurred during signup, then clear any expected
    // pre-auth 401 probe console log before asserting strict zero console errors.
    expect(errors.pageErrors).toEqual([]);
    errors.clear();

    const initialWorkspaceName = (
      await page.locator("[data-active-workspace-name]").innerText()
    ).trim();
    expect(initialWorkspaceName.length).toBeGreaterThan(0);

    // 2. Multi-workspace switcher: create new workspace, verify switch, switch back & forth,
    //    rename workspace, then delete extra workspace cleanly
    const tag = uniqueTag("ws").slice(-8);
    const createdWsName = `E2E Space ${tag}`;
    const renamedWsName = `E2E Renamed ${tag}`;

    await openAccountMenu(page);
    await expect(page.locator("[data-switch-workspace]")).toHaveCount(1);
    await assertZeroNativeSelects(page, "Account & Workspace Menu");

    await page.locator("[data-create-workspace-btn]").click();
    const askInput = page.locator("[data-ask] [data-ask-input]");
    await expect(askInput).toBeVisible();
    await askInput.fill(createdWsName);
    await askInput.press("Enter");

    await expect(page.locator("[data-active-workspace-name]")).toHaveText(createdWsName);

    // Verify switcher lists both workspaces and allows switching back and forth
    await openAccountMenu(page);
    const workspaceButtons = page.locator("[data-switch-workspace]");
    await expect(workspaceButtons).toHaveCount(2);
    await expect(
      workspaceButtons.filter({ hasText: createdWsName }),
    ).toHaveAttribute("aria-pressed", "true");

    // Switch back to initial workspace
    await workspaceButtons.filter({ hasText: initialWorkspaceName }).first().click();
    await expect(page.locator("[data-active-workspace-name]")).toHaveText(initialWorkspaceName);

    // Switch back to the extra workspace so we can rename and delete it
    await openAccountMenu(page);
    await page.locator("[data-switch-workspace]", { hasText: createdWsName }).click();
    await expect(page.locator("[data-active-workspace-name]")).toHaveText(createdWsName);

    // Rename extra workspace
    await openAccountMenu(page);
    await page.locator("[data-rename-workspace-btn]").click();
    const renameModal = page.locator("[data-workspace-modal='rename']");
    await expect(renameModal).toBeVisible();
    const renameInput = renameModal.locator("[data-workspace-rename-input]");
    await renameInput.fill(renamedWsName);
    await renameModal.locator("[data-workspace-modal-submit]").click();

    await expect(renameModal).toBeHidden();
    await expect(page.locator("[data-active-workspace-name]")).toHaveText(renamedWsName);

    // Delete extra workspace cleanly
    await openAccountMenu(page);
    await page.locator("[data-delete-workspace-btn]").click();
    const deleteModal = page.locator("[data-workspace-modal='delete']");
    await expect(deleteModal).toBeVisible();
    await deleteModal.locator("[data-workspace-delete-confirm-input]").fill(renamedWsName);
    await deleteModal.locator("[data-workspace-modal-submit]").click();

    await expect(deleteModal).toBeHidden();
    await expect(page.locator("[data-active-workspace-name]")).toHaveText(initialWorkspaceName);

    await openAccountMenu(page);
    await expect(page.locator("[data-switch-workspace]")).toHaveCount(1);

    // 3. Account Security Dialog: inspect MFA tab, Passkeys tab, and PAT create + revoke
    await page.locator("[data-open-account-security]").click();
    const securityDialog = page.locator("[data-account-security-dialog]");
    await expect(securityDialog).toBeVisible();

    // MFA tab (default)
    await expect(securityDialog.locator("[data-security-tab='mfa']")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(securityDialog.locator("[data-mfa-settings]")).toBeVisible();
    await expect(securityDialog.locator("[data-mfa-status-badge]")).toHaveAttribute(
      "data-mfa-enabled",
      "false",
    );
    await assertZeroNativeSelects(page, "Account Security MFA tab");

    // Passkeys tab
    await securityDialog.locator("[data-security-tab='passkey']").click();
    await expect(securityDialog.locator("[data-passkey-settings]")).toBeVisible();
    await expect(securityDialog.locator("[data-passkey-count-badge]")).toBeVisible();
    await expect(securityDialog.locator("[data-passkey-list]")).toBeVisible();
    await assertZeroNativeSelects(page, "Account Security Passkeys tab");

    // PAT tab: create and revoke a Personal Access Token
    await securityDialog.locator("[data-security-tab='pat']").click();
    await expect(securityDialog.locator("[data-pat-manager]")).toBeVisible();
    await assertZeroNativeSelects(page, "Account Security PAT tab");

    const patName = `E2E PAT ${tag}`;
    await securityDialog.locator("[data-pat-name-input]").fill(patName);
    await securityDialog.locator("[data-pat-create-submit]").click();

    await expect(securityDialog.locator("[data-pat-created-banner]")).toBeVisible();
    const rawTokenText = (
      await securityDialog.locator("[data-pat-raw-token]").innerText()
    ).trim();
    expect(rawTokenText).toMatch(/^jg_pat_/);

    // Verify created token appears in table as active
    const tokenRow = securityDialog.locator("[data-pat-table] tbody tr", { hasText: patName });
    await expect(tokenRow).toBeVisible();
    await expect(tokenRow).toHaveAttribute("data-pat-status", "active");

    // Revoke token via confirmation dialog
    await tokenRow.locator("[data-pat-revoke]").click();
    const confirmOk = page.locator("[data-ask] [data-ask-ok]");
    await expect(confirmOk).toBeVisible();
    await confirmOk.click();

    await expect(tokenRow).toHaveAttribute("data-pat-status", "revoked");

    // Close dialog cleanly
    await page.keyboard.press("Escape");
    await expect(securityDialog).toBeHidden();

    // Final checks
    expect(user.email).toContain("@jiange.test");
    await assertZeroNativeSelects(page, "Workspace Home after security checks");
    errors.assertNoErrors();
  });
});
