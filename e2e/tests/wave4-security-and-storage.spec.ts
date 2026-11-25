import { expect, test } from "@playwright/test";
import {
  apiURL,
  assertZeroNativeSelects,
  collectConsoleErrors,
  E2E_BASE_URL,
  openAccountMenu,
  registerFreshUser,
  uniqueTag,
} from "./helpers";

test.describe("Wave 4 Account Security, Storage Quota, Attachment Reindex & Ownership Transfer", () => {
  test("forgot password UI, #/login hash normalization, change password & active sessions", async ({
    page,
    request,
  }) => {
    const errors = collectConsoleErrors(page);
    const tag = uniqueTag("w4-sec");
    const resetProbeEmail = `reset-${tag}@jiange.test`;
    const email = `${tag}@jiange.test`;
    const name = `E2E Wave4 ${tag.slice(-6)}`;
    const oldPassword = `Jiange!${tag.slice(-8)}A1`;
    const newPassword = `Jiange!${tag.slice(-8)}Z9`;

    // 1. Navigate to #/login -> verify "忘记密码？" switches cleanly to Forgot Password request UI
    await page.goto(`${E2E_BASE_URL}/#/login`);
    await expect(page.locator("#email")).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe("#/login");

    const forgotBtn = page.locator("[data-forgot-password-btn]");
    await expect(forgotBtn).toBeVisible();
    await expect(forgotBtn).toContainText("忘记密码？");
    await forgotBtn.click();

    const resetRequestForm = page.locator("[data-password-reset-request-form]");
    await expect(resetRequestForm).toBeVisible();
    await assertZeroNativeSelects(page, "Forgot Password request view");

    // Submit Forgot Password request -> 200 OK without email enumeration
    await resetRequestForm.locator("[data-reset-email-input]").fill(resetProbeEmail);
    const resetReqPromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/auth/password-reset/request") &&
        res.request().method() === "POST",
    );
    await resetRequestForm.locator("[data-reset-request-submit-btn]").click();
    const resetReqResp = await resetReqPromise;
    expect(
      resetReqResp.status(),
      "POST /api/auth/password-reset/request should return 200 without enumeration",
    ).toBe(200);
    const resetReqBody = (await resetReqResp.json()) as { ok?: boolean; message?: string };
    expect(resetReqBody.ok).toBe(true);
    expect((resetReqBody.message ?? "").length).toBeGreaterThan(0);
    await expect(resetRequestForm.locator("[data-password-reset-sent-banner]")).toBeVisible();

    // Verify Reset Confirm UI is reachable from Forgot Password view
    await resetRequestForm.locator("[data-goto-reset-confirm-btn]").click();
    const resetConfirmForm = page.locator("[data-password-reset-confirm-form]");
    await expect(resetConfirmForm).toBeVisible();
    await expect(resetConfirmForm.locator("[data-reset-token-input]")).toBeVisible();
    await expect(resetConfirmForm.locator("[data-reset-new-password-input]")).toBeVisible();
    await expect(resetConfirmForm.locator("[data-reset-confirm-password-input]")).toBeVisible();
    await expect(resetConfirmForm.locator("[data-reset-confirm-submit-btn]")).toBeVisible();

    // Return to login form (still on #/login) and register a fresh user via UI
    await resetConfirmForm.locator("[data-reset-back-btn]").click();
    await expect(page.locator("#email")).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe("#/login");

    await page.locator("form p button[type='button']").last().click();
    await expect(page.locator("#name")).toBeVisible();

    await page.locator("#email").fill(email);
    await page.locator("#name").fill(name);
    await page.locator("#password").fill(oldPassword);

    const registerRespPromise = page.waitForResponse(
      (res) => res.url().includes("/api/auth/register") && res.request().method() === "POST",
    );
    await page.locator("form button[type='submit']").click();
    const registerResp = await registerRespPromise;
    expect(registerResp.status(), "POST /api/auth/register should succeed with 201").toBe(201);

    await expect(page.locator("[data-active-workspace-name]")).toBeVisible();

    // 2. Verify #/login hash normalized automatically off #/login
    await expect
      .poll(async () => page.evaluate(() => window.location.hash))
      .not.toMatch(/^#\/login/i);
    expect(page.url()).not.toMatch(/#\/login/i);
    expect(await page.evaluate(() => window.location.hash)).toBe("#/");

    // Ensure no uncaught page errors occurred during auth, then clear expected pre-auth 401 log
    expect(errors.pageErrors).toEqual([]);
    errors.clear();

    // 3. Open Account Security dialog -> inspect "登录设备" (Active Sessions) tab
    await openAccountMenu(page);
    await page.locator("[data-open-account-security]").click();
    const securityDialog = page.locator("[data-account-security-dialog]");
    await expect(securityDialog).toBeVisible();

    const sessionsRespPromise = page.waitForResponse(
      (res) => res.url().includes("/api/me/sessions") && res.request().method() === "GET",
    );
    const sessionsTab = securityDialog.locator("[data-security-tab='sessions']");
    await expect(sessionsTab).toContainText("登录设备");
    await sessionsTab.click();
    const sessionsResp = await sessionsRespPromise;
    expect(sessionsResp.status(), "GET /api/me/sessions should return 200").toBe(200);

    await expect(securityDialog.locator("[data-sessions-security-panel]")).toBeVisible();
    const sessionItems = securityDialog.locator("[data-session-item]");
    await expect(sessionItems.first()).toBeVisible();
    expect(await sessionItems.count()).toBeGreaterThanOrEqual(1);

    const currentBadge = securityDialog.locator("[data-current-session-badge]");
    await expect(currentBadge).toBeVisible();
    await expect(currentBadge).toHaveText("当前设备");
    await assertZeroNativeSelects(page, "Account Security Active Sessions tab");

    // 4. Switch to "修改密码" (Change Password) tab -> change password -> verify 200 & notice
    const passwordTab = securityDialog.locator("[data-security-tab='password']");
    await expect(passwordTab).toContainText("修改密码");
    await passwordTab.click();

    const passwordForm = securityDialog.locator("[data-password-change-form]");
    await expect(passwordForm).toBeVisible();
    await passwordForm.locator("[data-current-password-input]").fill(oldPassword);
    await passwordForm.locator("[data-new-password-input]").fill(newPassword);
    await passwordForm.locator("[data-confirm-password-input]").fill(newPassword);

    const changePwdRespPromise = page.waitForResponse(
      (res) => res.url().includes("/api/me/password") && res.request().method() === "POST",
    );
    await passwordForm.locator("[data-password-change-submit]").click();
    const changePwdResp = await changePwdRespPromise;
    expect(changePwdResp.status(), "POST /api/me/password should return 200").toBe(200);
    const changePwdBody = (await changePwdResp.json()) as { ok?: boolean };
    expect(changePwdBody.ok).toBe(true);

    const changeNotice = passwordForm.locator("[data-password-change-notice]");
    await expect(changeNotice).toBeVisible();
    await expect(changeNotice).toContainText("密码已修改");

    // Close Account Security dialog cleanly
    await page.keyboard.press("Escape");
    await expect(securityDialog).toBeHidden();

    // 5. Verify signing in via API with old password fails (401) and new password succeeds (200)
    const oldLoginRes = await request.post(apiURL("/api/auth/login"), {
      data: { email, password: oldPassword },
    });
    expect(oldLoginRes.status(), "Signing in with old password should fail with 401").toBe(401);

    const newLoginRes = await request.post(apiURL("/api/auth/login"), {
      data: { email, password: newPassword },
    });
    expect(newLoginRes.status(), "Signing in with new password should succeed with 200").toBe(200);

    await assertZeroNativeSelects(page, "Workspace Home after Wave 4 account security checks");
    errors.assertNoErrors();
  });

  test("workspace storage quota (413 enforcement), attachment reindex, instant global enforced-MFA banner & owner transfer", async ({
    page,
    request,
  }) => {
    const errors = collectConsoleErrors(page);

    // 1. Register a fresh owner user and an isolated second user via API
    const owner = await registerFreshUser(page, "w4-owner");
    expect(errors.pageErrors).toEqual([]);
    errors.clear();

    const peerTag = uniqueTag("w4-peer");
    const peerEmail = `${peerTag}@jiange.test`;
    const peerName = `E2E Peer ${peerTag.slice(-6)}`;
    const peerPassword = `Jiange!${peerTag.slice(-8)}B2`;

    const peerRegRes = await request.post(apiURL("/api/auth/register"), {
      data: { email: peerEmail, name: peerName, password: peerPassword },
    });
    const peerRegRaw = await peerRegRes.text();
    expect(
      peerRegRes.status(),
      `Failed to register peer user ${peerEmail}: ${peerRegRaw}`,
    ).toBe(201);
    const peerMe = JSON.parse(peerRegRaw) as {
      user: { id: number; email: string; name: string };
    };
    const peerUserId = peerMe.user.id;
    expect(peerUserId).toBeGreaterThan(0);

    // 2. Navigate to #/org -> "安全审计与水印" tab
    await page.goto("/#/org");
    await expect(page.locator("[data-org-page]")).toBeVisible();
    await page.locator("[data-org-tab='security']").click();
    await expect(page.locator("[data-org-audit-panel]")).toBeVisible();
    await assertZeroNativeSelects(page, "Org Security & Audit tab");

    // 3. Verify "存储空间与附件索引" card renders and click "重建附件全文索引"
    const storageCard = page.locator("[data-storage-usage-card]");
    await expect(storageCard).toBeVisible();
    await expect(storageCard).toContainText("存储空间与附件索引");

    const reindexBtn = storageCard.locator("[data-storage-reindex-btn]");
    await expect(reindexBtn).toBeVisible();
    await expect(reindexBtn).toContainText("重建附件全文索引");

    const reindexRespPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/workspaces/${owner.workspaceId}/attachments/reindex`) &&
        res.request().method() === "POST",
    );
    await reindexBtn.click();
    const reindexResp = await reindexRespPromise;
    expect(
      reindexResp.status(),
      "POST /api/workspaces/{wsId}/attachments/reindex should return 200",
    ).toBe(200);
    const reindexStats = (await reindexResp.json()) as {
      scanned?: number;
      indexed?: number;
      skipped?: number;
      failed?: number;
    };
    expect(typeof reindexStats.scanned).toBe("number");
    expect(typeof reindexStats.indexed).toBe("number");

    const reindexFeedback = storageCard.locator("[data-storage-reindex-result]");
    await expect(reindexFeedback).toBeVisible();
    await expect(reindexFeedback).toContainText("附件索引重建完成");

    // 4. Storage quota enforcement via API:
    //    Set quota to 64 bytes -> 256-byte doc attachment fails with 413 "storage_quota_exceeded"
    //    Reset quota to 0 (unlimited) -> 256-byte doc attachment succeeds with 201
    const quotaEndpoint = `/api/workspaces/${owner.workspaceId}/storage/quota`;
    const setQuotaRes = await page.request.put(quotaEndpoint, {
      data: { quotaBytes: 64 },
    });
    const setQuotaRaw = await setQuotaRes.text();
    expect(setQuotaRes.status(), `PUT ${quotaEndpoint} (64 bytes) failed: ${setQuotaRaw}`).toBe(
      200,
    );
    expect((JSON.parse(setQuotaRaw) as { quotaBytes?: number }).quotaBytes).toBe(64);

    const createDocRes = await page.request.post("/api/docs", {
      data: {
        workspaceId: owner.workspaceId,
        title: `E2E Quota Doc ${peerTag.slice(-6)}`,
      },
    });
    const createDocRaw = await createDocRes.text();
    expect(createDocRes.status(), `POST /api/docs failed: ${createDocRaw}`).toBe(201);
    const createdDoc = JSON.parse(createDocRaw) as { id: number };
    expect(createdDoc.id).toBeGreaterThan(0);

    const payload256 = Buffer.alloc(256, "q");
    const overQuotaRes = await page.request.post(`/api/docs/${createdDoc.id}/files`, {
      headers: { "X-Jiange-Upload": "1" },
      multipart: {
        file: {
          name: "quota-test-256b.txt",
          mimeType: "text/plain",
          buffer: payload256,
        },
      },
    });
    const overQuotaRaw = await overQuotaRes.text();
    expect(
      overQuotaRes.status(),
      `Expected 413 for 256-byte upload under 64-byte quota: ${overQuotaRaw}`,
    ).toBe(413);
    expect((JSON.parse(overQuotaRaw) as { error?: string }).error).toBe("storage_quota_exceeded");

    // Reset quota to 0 (unlimited) and verify upload succeeds with 201
    const resetQuotaRes = await page.request.put(quotaEndpoint, {
      data: { quotaBytes: 0 },
    });
    const resetQuotaRaw = await resetQuotaRes.text();
    expect(
      resetQuotaRes.status(),
      `PUT ${quotaEndpoint} (0 = unlimited) failed: ${resetQuotaRaw}`,
    ).toBe(200);
    expect((JSON.parse(resetQuotaRaw) as { quotaBytes?: number }).quotaBytes).toBe(0);

    const allowedUploadRes = await page.request.post(`/api/docs/${createdDoc.id}/files`, {
      headers: { "X-Jiange-Upload": "1" },
      multipart: {
        file: {
          name: "quota-test-256b.txt",
          mimeType: "text/plain",
          buffer: payload256,
        },
      },
    });
    const allowedUploadRaw = await allowedUploadRes.text();
    expect(
      allowedUploadRes.status(),
      `Expected 201 after resetting quota to unlimited: ${allowedUploadRaw}`,
    ).toBe(201);

    // 5. Instant Global Enforced-MFA top banner (WITHOUT reloading the page)
    const globalMfaBanner = page.locator("[data-global-mfa-banner]");
    await expect(globalMfaBanner).toBeHidden();

    const requireMfaToggle = page.locator("[data-require-mfa-toggle]");
    await expect(requireMfaToggle).toHaveAttribute("aria-checked", "false");
    await requireMfaToggle.click();
    await expect(requireMfaToggle).toHaveAttribute("aria-checked", "true");

    const enableMfaRespPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/workspaces/${owner.workspaceId}/security-policy`) &&
        res.request().method() === "PUT",
    );
    await page.locator("[data-dlp-save]").click();
    const enableMfaResp = await enableMfaRespPromise;
    expect(
      enableMfaResp.status(),
      "PUT security-policy (requireMfa=true) should return 200",
    ).toBe(200);

    // Banner appears immediately without reloading the page
    await expect(globalMfaBanner).toBeVisible();
    await expect(globalMfaBanner.locator("[data-global-mfa-setup-btn]")).toBeVisible();
    await expect(globalMfaBanner.locator("[data-global-mfa-setup-btn]")).toContainText(
      "立即配置双因素认证",
    );
    await expect(globalMfaBanner.locator("[data-global-mfa-passkey-btn]")).toBeVisible();
    await expect(globalMfaBanner.locator("[data-global-mfa-passkey-btn]")).toContainText(
      "注册通行密钥",
    );

    // Toggle Require MFA back OFF and save -> banner disappears immediately without reload
    await requireMfaToggle.click();
    await expect(requireMfaToggle).toHaveAttribute("aria-checked", "false");

    const disableMfaRespPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/workspaces/${owner.workspaceId}/security-policy`) &&
        res.request().method() === "PUT",
    );
    await page.locator("[data-dlp-save]").click();
    const disableMfaResp = await disableMfaRespPromise;
    expect(
      disableMfaResp.status(),
      "PUT security-policy (requireMfa=false) should return 200",
    ).toBe(200);
    await expect(globalMfaBanner).toBeHidden();

    // 6. Add 2nd user to the workspace (invite + accept), open "成员" tab, and transfer ownership
    const inviteRes = await page.request.post(`/api/workspaces/${owner.workspaceId}/members`, {
      data: { email: peerEmail, role: "member" },
    });
    const inviteRaw = await inviteRes.text();
    expect(
      inviteRes.status(),
      `POST /api/workspaces/${owner.workspaceId}/members failed: ${inviteRaw}`,
    ).toBe(200);
    const inviteChange = JSON.parse(inviteRaw) as {
      status?: string;
      invitation?: { id: number };
    };
    if (inviteChange.invitation?.id) {
      const acceptRes = await request.post(
        apiURL(`/api/invitations/${inviteChange.invitation.id}/accept`),
        { data: {} },
      );
      expect(
        acceptRes.status(),
        `POST /api/invitations/${inviteChange.invitation.id}/accept failed: ${await acceptRes.text()}`,
      ).toBe(204);
    }

    // Reload #/org to load the updated member roster cleanly
    await page.reload();
    await expect(page.locator("[data-org-page]")).toBeVisible();
    await expect(globalMfaBanner).toBeHidden();

    await page.locator("[data-org-tab='members']").click();
    await assertZeroNativeSelects(page, "Org Members tab");

    const transferBtn = page.locator(`[data-transfer-owner='${peerUserId}']`);
    await expect(transferBtn).toBeVisible();
    await expect(transferBtn).toContainText("转让所有者");
    await transferBtn.click();

    // Confirm ownership transfer in custom dialog
    const confirmDialog = page.locator("[data-ask]");
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText(peerName);

    const transferRespPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/workspaces/${owner.workspaceId}/transfer-owner`) &&
        res.request().method() === "POST",
    );
    await confirmDialog.locator("[data-ask-ok]").click();
    const transferResp = await transferRespPromise;
    expect(
      transferResp.status(),
      "POST /api/workspaces/{wsId}/transfer-owner should return 200",
    ).toBe(200);
    const transferBody = (await transferResp.json()) as {
      ok?: boolean;
      workspaceId?: number;
      ownerId?: number;
    };
    expect(transferBody.ok).toBe(true);
    expect(transferBody.ownerId).toBe(peerUserId);

    // Verify ownership transfer reflected cleanly in UI and server snapshot
    await expect(confirmDialog).toBeHidden();
    await expect(page.locator("[data-org-page] [role='status']")).toContainText(peerName);
    await expect(page.locator("[data-transfer-owner]")).toHaveCount(0);
    await expect(page.locator("[data-org-page] header")).toContainText("管理员");

    const orgSnapRes = await page.request.get(`/api/workspaces/${owner.workspaceId}/org`);
    expect(orgSnapRes.status()).toBe(200);
    const orgSnap = (await orgSnapRes.json()) as {
      callerRole?: string;
      members?: Array<{ userId: number; role: string }>;
    };
    expect(orgSnap.callerRole).toBe("admin");
    const newOwnerEntry = (orgSnap.members ?? []).find((m) => m.userId === peerUserId);
    expect(newOwnerEntry?.role).toBe("owner");

    errors.assertNoErrors();
  });
});
