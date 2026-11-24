import { expect, test } from "@playwright/test";
import {
  apiURL,
  assertZeroNativeSelects,
  collectConsoleErrors,
  registerFreshUser,
} from "./helpers";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

test.describe("Enterprise Admin, Observability, OpenAPI & SCIM 2.0", () => {
  test("verifies health probes, Prometheus metrics, OpenAPI 3.1 spec (350+ ops), and SCIM 2.0 discovery", async ({
    request,
  }) => {
    // 1. /healthz
    const healthz = await request.get(apiURL("/healthz"));
    expect(healthz.status(), "GET /healthz should return 200").toBe(200);

    // 2. /readyz
    const readyz = await request.get(apiURL("/readyz"));
    expect(readyz.status(), "GET /readyz should return 200").toBe(200);
    expect(readyz.headers()["content-type"] ?? "").toContain("application/json");
    const readyzBody = (await readyz.json()) as {
      status?: string;
      checks?: Record<string, string>;
    };
    expect(readyzBody.status).toBe("ready");
    expect(readyzBody.checks?.database).toBe("ok");

    // 3. /metrics (Prometheus exposition text)
    const metrics = await request.get(apiURL("/metrics"));
    expect(metrics.status(), "GET /metrics should return 200").toBe(200);
    expect(metrics.headers()["content-type"] ?? "").toContain("text/plain");
    const metricsText = await metrics.text();
    expect(metricsText).toContain("# HELP");
    expect(metricsText).toContain("# TYPE");

    // 4. /api/openapi.json (OpenAPI 3.1 with 350+ operations)
    const openapi = await request.get(apiURL("/api/openapi.json"));
    expect(openapi.status(), "GET /api/openapi.json should return 200").toBe(200);
    expect(openapi.headers()["content-type"] ?? "").toContain("application/json");
    const spec = (await openapi.json()) as {
      openapi?: string;
      paths?: Record<string, Record<string, unknown>>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(spec.openapi ?? "").toMatch(/^3\.1/);
    const paths = spec.paths ?? {};
    let operationCount = 0;
    for (const methodsObj of Object.values(paths)) {
      if (!methodsObj || typeof methodsObj !== "object") continue;
      for (const method of HTTP_METHODS) {
        if (methodsObj[method]) operationCount++;
      }
    }
    expect(
      operationCount,
      `Expected /api/openapi.json to expose 350+ operations, got ${operationCount}`,
    ).toBeGreaterThanOrEqual(350);
    expect(Object.keys(spec.components?.schemas ?? {}).length).toBeGreaterThan(0);

    // 5. /scim/v2/ServiceProviderConfig
    const spConfig = await request.get(apiURL("/scim/v2/ServiceProviderConfig"));
    expect(spConfig.status(), "GET /scim/v2/ServiceProviderConfig should return 200").toBe(200);
    expect(spConfig.headers()["content-type"] ?? "").toContain("application/scim+json");
    const spBody = (await spConfig.json()) as { schemas?: string[] };
    expect(spBody.schemas ?? []).toContain(
      "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
    );

    // 6. /scim/v2/Schemas
    const scimSchemas = await request.get(apiURL("/scim/v2/Schemas"));
    expect(scimSchemas.status(), "GET /scim/v2/Schemas should return 200").toBe(200);
    expect(scimSchemas.headers()["content-type"] ?? "").toContain("application/scim+json");
    const schemasBody = (await scimSchemas.json()) as { Resources?: unknown[]; totalResults?: number };
    expect((schemasBody.Resources ?? []).length).toBeGreaterThanOrEqual(2);

    // 7. /scim/v2/ResourceTypes
    const scimResourceTypes = await request.get(apiURL("/scim/v2/ResourceTypes"));
    expect(scimResourceTypes.status(), "GET /scim/v2/ResourceTypes should return 200").toBe(200);
    expect(scimResourceTypes.headers()["content-type"] ?? "").toContain("application/scim+json");
    const rtBody = (await scimResourceTypes.json()) as { Resources?: unknown[]; totalResults?: number };
    expect((rtBody.Resources ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("manages DLP + Require MFA persistence, inspects SSO OIDC/SAML 2.0, and explores Developer OpenAPI/SCIM", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await registerFreshUser(page, "org-admin");
    errors.clear();

    // Open #/org
    await page.goto("/#/org");
    await expect(page.locator("[data-org-page]")).toBeVisible();
    await assertZeroNativeSelects(page, "Org overview");

    // -------------------------------------------------------------------------
    // 1. Security & Audit tab: DLP enable, add rule, live test, toggle Require MFA,
    //    save, reload to verify persistence, then reset cleanly
    // -------------------------------------------------------------------------
    await page.locator("[data-org-tab='security']").click();
    await expect(page.locator("[data-org-audit-panel]")).toBeVisible();
    await assertZeroNativeSelects(page, "Org Security & Audit tab");

    const dlpToggle = page.locator("[data-dlp-enabled-toggle]");
    const requireMfaToggle = page.locator("[data-require-mfa-toggle]");
    const savePolicyBtn = page.locator("[data-dlp-save]");

    // Enable DLP
    if ((await dlpToggle.getAttribute("aria-checked")) !== "true") {
      await dlpToggle.click();
    }
    await expect(dlpToggle).toHaveAttribute("aria-checked", "true");

    // Add a sensitive DLP rule
    const sensitiveRule = "机密代号ALPHA";
    await page.locator("[data-dlp-rule-input]").fill(sensitiveRule);
    await page.locator("[data-dlp-add-rule-btn]").click();
    const ruleChip = page.locator(`[data-dlp-rule-chip='${sensitiveRule}']`);
    await expect(ruleChip).toBeVisible();

    // Live test rule via the DLP sandbox
    await page.locator("[data-dlp-test-input]").fill(`测试文本包含 ${sensitiveRule} 敏感字段`);
    await page.locator("[data-dlp-test-btn]").click();
    const testResult = page.locator("[data-dlp-test-result]");
    await expect(testResult).toBeVisible();
    await expect(testResult).toContainText(sensitiveRule);

    // Toggle Require MFA on
    if ((await requireMfaToggle.getAttribute("aria-checked")) !== "true") {
      await requireMfaToggle.click();
    }
    await expect(requireMfaToggle).toHaveAttribute("aria-checked", "true");

    // Save policy and wait for server confirmation
    const saveResp = page.waitForResponse(
      (res) =>
        /\/api\/workspaces\/\d+\/security-policy/.test(res.url()) &&
        res.request().method() === "PUT" &&
        res.status() < 300,
    );
    await savePolicyBtn.click();
    await saveResp;

    // Reload and verify DLP + rule + Require MFA persisted
    await page.reload();
    await expect(page.locator("[data-org-page]")).toBeVisible();
    await page.locator("[data-org-tab='security']").click();
    await expect(page.locator("[data-org-audit-panel]")).toBeVisible();

    await expect(page.locator("[data-dlp-enabled-toggle]")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(`[data-dlp-rule-chip='${sensitiveRule}']`)).toBeVisible();
    await expect(page.locator("[data-require-mfa-toggle]")).toHaveAttribute("aria-checked", "true");

    // Reset policy cleanly back to default disabled state
    await page.locator("[data-require-mfa-toggle]").click();
    await expect(page.locator("[data-require-mfa-toggle]")).toHaveAttribute("aria-checked", "false");
    await page.locator("[data-dlp-enabled-toggle]").click();
    await expect(page.locator("[data-dlp-enabled-toggle]")).toHaveAttribute("aria-checked", "false");
    await page.locator(`[data-dlp-rule-chip='${sensitiveRule}'] button`).click();
    await expect(page.locator(`[data-dlp-rule-chip='${sensitiveRule}']`)).toHaveCount(0);

    const resetResp = page.waitForResponse(
      (res) =>
        /\/api\/workspaces\/\d+\/security-policy/.test(res.url()) &&
        res.request().method() === "PUT" &&
        res.status() < 300,
    );
    await page.locator("[data-dlp-save]").click();
    await resetResp;

    // -------------------------------------------------------------------------
    // 2. SSO tab: verify OIDC & SAML 2.0 options render cleanly with 0 native <select>
    // -------------------------------------------------------------------------
    await page.locator("[data-org-tab='sso']").click();
    await expect(page.locator("[data-org-sso-panel]")).toBeVisible();
    await assertZeroNativeSelects(page, "Org SSO tab");

    await page.locator("[data-sso-create-btn]").click();
    const ssoModal = page.locator("[data-sso-modal]");
    await expect(ssoModal).toBeVisible();

    // OIDC preset & discovery fields
    await ssoModal.locator("[data-sso-preset='oidc']").click();
    await expect(ssoModal.locator("[data-sso-issuer-input]")).toBeVisible();
    await expect(ssoModal.locator("[data-sso-discover-btn]")).toBeVisible();

    // SAML 2.0 preset & metadata / ACS / certificate fields
    await ssoModal.locator("[data-sso-preset='saml']").click();
    await expect(ssoModal.locator("[data-sso-saml-sso-url-input]")).toBeVisible();
    await expect(ssoModal.locator("[data-sso-saml-cert-input]")).toBeVisible();
    await expect(ssoModal.locator("[data-sso-modal-saml-metadata-url]")).toBeVisible();
    await expect(ssoModal.locator("[data-sso-modal-saml-acs-url]")).toBeVisible();

    // Verify protocol selector is FeishuSelect (zero native <select>)
    await expect(ssoModal.locator("[data-sso-provider-type-select]")).toBeVisible();
    await assertZeroNativeSelects(page, "Org SSO modal");

    await page.keyboard.press("Escape");
    await expect(ssoModal).toBeHidden();

    // -------------------------------------------------------------------------
    // 3. Developer tab: OpenAPI 3.1 explorer + schema badge + SCIM 2.0 table
    // -------------------------------------------------------------------------
    await page.locator("[data-org-tab='developer']").click();
    await expect(page.locator("[data-org-developer-panel]")).toBeVisible();
    await assertZeroNativeSelects(page, "Org Developer tab");

    // SCIM 2.0 reference table
    const scimTable = page.locator("[data-scim-endpoints-table]");
    await expect(scimTable).toBeVisible();
    await expect(scimTable).toContainText("/scim/v2/ServiceProviderConfig");
    await expect(scimTable).toContainText("/scim/v2/Schemas");
    await expect(scimTable).toContainText("/scim/v2/ResourceTypes");
    await expect(scimTable).toContainText("/scim/v2/Users");
    await expect(scimTable).toContainText("/scim/v2/Groups");

    // OpenAPI 3.1 explorer badges & search filter
    await expect(page.locator("[data-openapi-version]")).toContainText("OpenAPI 3.1");
    await expect(page.locator("[data-openapi-endpoint-count]")).toBeVisible();
    await expect(page.locator("[data-openapi-schema-count]")).toBeVisible();
    await expect(page.locator("[data-openapi-endpoint-list]")).toBeVisible();

    await page.locator("[data-openapi-search]").fill("/scim/v2/Schemas");
    await expect(
      page.locator("[data-openapi-endpoint-list] [data-openapi-endpoint]").first(),
    ).toContainText("/scim/v2/Schemas");

    errors.assertNoErrors();
  });
});
