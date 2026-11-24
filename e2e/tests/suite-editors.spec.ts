import { expect, test, type Page } from "@playwright/test";
import {
  assertZeroNativeSelects,
  collectConsoleErrors,
  registerFreshUser,
  uniqueTag,
} from "./helpers";

async function openHomeCreateMenu(page: Page) {
  await page.goto("/#/");
  const createBtn = page.locator("main button[aria-haspopup='menu']").first();
  await expect(createBtn).toBeVisible();
  await createBtn.click();
  const menu = page.locator("[role='menu']").first();
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("Core Suite Editors & Global Search", () => {
  test("creates and persists Document, Spreadsheet, Base, Slides, and finds Document via Global Search", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    await registerFreshUser(page, "suite");
    errors.clear();

    const tag = uniqueTag("suite").slice(-8);
    const docTitle = `E2E Spec Doc ${tag}`;
    const docBody = `Collaborative paragraph persistence check ${tag}`;

    // -------------------------------------------------------------------------
    // 1. Document: create, type title & body text, reload, verify persistence
    // -------------------------------------------------------------------------
    const docMenu = await openHomeCreateMenu(page);
    await docMenu.locator("button[role='menuitem']").first().click();

    await expect(page).toHaveURL(/#\/doc\/\d+/);
    const docMatch = /#\/doc\/(\d+)/.exec(page.url());
    expect(docMatch, "Expected URL to include numeric doc ID").not.toBeNull();
    const docId = Number(docMatch![1]);

    const titleInput = page.locator("[data-document-focus-scope] textarea").first();
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toBeEnabled();
    await expect(page.locator("[data-status='synced']")).toBeVisible();

    await titleInput.click();
    await titleInput.fill(docTitle);
    await titleInput.press("Enter");

    const editor = page.locator("[data-editor]");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type(docBody);
    await expect(editor).toContainText(docBody);

    // Wait for both collab sync and directory title auto-sync to persist to PostgreSQL
    await expect(page.locator("[data-status='synced']")).toBeVisible();
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/docs/${docId}`);
          if (!res.ok()) return "";
          const data = (await res.json()) as { title?: string };
          return data.title ?? "";
        },
        { timeout: 12_000, message: "Waiting for document title auto-sync to persist" },
      )
      .toBe(docTitle);

    await assertZeroNativeSelects(page, "Document editor");

    // Reload and verify title & body text persisted
    await page.reload();
    await expect(titleInput).toBeEnabled();
    await expect(page.locator("[data-status='synced']")).toBeVisible();
    await expect(titleInput).toHaveValue(docTitle);
    await expect(page.locator("[data-editor]")).toContainText(docBody);

    // -------------------------------------------------------------------------
    // 2. Spreadsheet (sheet): edit cells & formula, reload, verify persistence
    // -------------------------------------------------------------------------
    const sheetMenu = await openHomeCreateMenu(page);
    await sheetMenu.locator("[data-new-sheet]").click();

    await expect(page).toHaveURL(/#\/sheet\/\d+/);
    await expect(page.locator("[data-sheet-grid]")).toBeVisible();
    await assertZeroNativeSelects(page, "Spreadsheet editor");

    const formulaInput = page.locator("[data-sheet-formula]");
    await expect(formulaInput).toBeVisible();

    // Enter 12 into A1
    await page.locator("[role='gridcell'][aria-label='A1']").click();
    await formulaInput.click();
    await formulaInput.fill("12");
    await formulaInput.press("Enter");

    // Enter 30 into A2
    await page.locator("[role='gridcell'][aria-label='A2']").click();
    await formulaInput.click();
    await formulaInput.fill("30");
    await formulaInput.press("Enter");

    // Enter formula =A1+A2 into A3
    await page.locator("[role='gridcell'][aria-label='A3']").click();
    await formulaInput.click();
    await formulaInput.fill("=A1+A2");
    await formulaInput.press("Enter");

    await expect(page.locator("[role='gridcell'][aria-label='A3']")).toContainText("42");
    await expect(page.locator("[data-sheet-save-status]")).toContainText(/已经保存到云端|Saved/i);

    // Reload and verify computed value and formula persisted
    await page.reload();
    await expect(page.locator("[data-sheet-grid]")).toBeVisible();
    await expect(page.locator("[role='gridcell'][aria-label='A3']")).toContainText("42");
    await page.locator("[role='gridcell'][aria-label='A3']").click();
    await expect(page.locator("[data-sheet-formula]")).toHaveValue("=A1+A2");

    // -------------------------------------------------------------------------
    // 3. Base (base): verify grid loads and can add a record persistently
    // -------------------------------------------------------------------------
    const baseMenu = await openHomeCreateMenu(page);
    await baseMenu.locator("button[role='menuitem']", { hasText: /多维表格|Base/i }).click();

    await expect(page).toHaveURL(/#\/base\/\d+/);
    await expect(page.locator("[data-grid]")).toBeVisible();
    await assertZeroNativeSelects(page, "Base grid");

    const rowAnchors = page.locator("[data-grid] [data-row-menu-anchor]");
    const initialRowCount = await rowAnchors.count();

    const addRecordResp = page.waitForResponse(
      (res) =>
        /\/api\/bases\/\d+\/records/.test(res.url()) &&
        res.request().method() === "POST" &&
        res.status() < 300,
    );
    await page.locator("[data-add-record]").click();
    await addRecordResp;

    await expect(rowAnchors).toHaveCount(initialRowCount + 1);

    await page.reload();
    await expect(page.locator("[data-grid]")).toBeVisible();
    await expect(page.locator("[data-grid] [data-row-menu-anchor]")).toHaveCount(
      initialRowCount + 1,
    );

    // -------------------------------------------------------------------------
    // 4. Slides (slides): create deck, verify canvas renders cleanly & saves
    // -------------------------------------------------------------------------
    const slidesMenu = await openHomeCreateMenu(page);
    await slidesMenu.locator("button[role='menuitem']", { hasText: /幻灯片|Slides/i }).click();

    await expect(page).toHaveURL(/#\/slides\/\d+/);
    const canvas = page.locator("[data-slides-canvas]");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box, "Expected slides canvas to have non-zero layout dimensions").not.toBeNull();
    expect(box!.width).toBeGreaterThan(200);
    expect(box!.height).toBeGreaterThan(100);
    await assertZeroNativeSelects(page, "Slides editor");

    const slideTitleInput = page.locator("[data-slides-title]");
    await expect(slideTitleInput).toBeVisible();
    const slideTitle = `E2E Deck Title ${tag}`;
    const slideSaveResp = page.waitForResponse(
      (res) =>
        /\/api\/slides\/\d+\/pages\/\d+/.test(res.url()) &&
        (res.request().method() === "PUT" || res.request().method() === "PATCH") &&
        res.status() < 300,
    );
    await slideTitleInput.click();
    await slideTitleInput.fill(slideTitle);
    await slideTitleInput.blur();
    await slideSaveResp;

    // -------------------------------------------------------------------------
    // 5. Global Search: locate the newly created document
    // -------------------------------------------------------------------------
    await page.goto("/#/");
    const searchTrigger = page.locator("[data-search]");
    await expect(searchTrigger).toBeVisible();
    await searchTrigger.click();

    const searchDialog = page.locator("[role='dialog']").last();
    await expect(searchDialog).toBeVisible();
    const searchInput = searchDialog.locator("input[role='combobox']");
    await expect(searchInput).toBeVisible();
    await searchInput.fill(docTitle);

    const matchingOption = searchDialog
      .locator("[role='listbox'] [role='option']", { hasText: docTitle })
      .first();
    await expect(matchingOption).toBeVisible({ timeout: 12_000 });
    await matchingOption.click();

    await expect(page).toHaveURL(new RegExp(`#/doc/${docId}(?:$|\\?)`));
    await expect(page.locator("[data-document-focus-scope] textarea").first()).toHaveValue(
      docTitle,
    );

    errors.assertNoErrors();
  });
});
