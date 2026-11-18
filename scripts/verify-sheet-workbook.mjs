import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Uses a throwaway account and workbook on local disposable servers.
const app = process.env.JIANGE_SHEET_TEST_URL;
const cdp = process.env.JIANGE_SHEET_CDP_URL;
if (!app || !cdp || ![app, cdp].every((url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))) {
  throw new Error("Set local disposable JIANGE_SHEET_TEST_URL and JIANGE_SHEET_CDP_URL");
}
const out = process.env.JIANGE_SHEET_SCREENSHOT_DIR || process.cwd();
await fs.mkdir(out, { recursive: true });

const target = await (await fetch(new URL("/json/new?about:blank", cdp), { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const jobs = new Map();
ws.onmessage = (event) => {
  const item = JSON.parse(event.data);
  if (!item.id) return;
  const job = jobs.get(item.id);
  jobs.delete(item.id);
  item.error ? job.reject(item.error) : job.resolve(item.result);
};

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const run = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
};

const wait = async (expression) => {
  for (let i = 0; i < 250; i++) {
    try {
      if (await run(expression)) return;
    } catch (err) {
      if (err?.code !== -32000) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for: ${expression}\nBody: ${(await run("document.body.innerText")).slice(0, 800)}`);
};

const pressKey = async (key, code = key, windowsVirtualKeyCode = 0) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
};

const setInputValue = async (selector, value) => {
  await run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
};

const selectRange = async (rangeText) => {
  await run(`document.querySelector('[data-sheet-address]').focus()`);
  await setInputValue("[data-sheet-address]", rangeText);
  await pressKey("Enter", "Enter", 13);
  await wait(`document.querySelector('[data-sheet-address]')?.value === ${JSON.stringify(rangeText.toUpperCase())}`);
};

const editFormulaCell = async (address, value) => {
  await selectRange(address);
  await run(`document.querySelector('[data-sheet-formula]').focus()`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await setInputValue("[data-sheet-formula]", value);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await pressKey("Enter", "Enter", 13);
  await wait(`document.querySelector('[data-sheet-save-status]')?.textContent?.includes('已经保存到云端')`);
};

const screenshot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, name), Buffer.from(data, "base64"));
};

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: new URL("/", app).href });
await wait('document.readyState === "complete"');

// 1. Register throwaway account & create spreadsheet from Home -> verify kind="sheet" & URL "#/sheet/{id}".
const email = `sheet-${Date.now()}@example.test`;
await run(`(async () => {
  const r = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(email)}, name: '小表', password: 'isolated-test-only' })
  });
  if (!r.ok) throw Error('register ' + r.status);
})()`);
await send("Page.reload");
await new Promise((resolve) => setTimeout(resolve, 400));
await wait('!![...document.querySelectorAll("button")].find(b => b.textContent.includes("新建") && b.getAttribute("aria-haspopup") === "menu")');

await run(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("新建") && b.getAttribute("aria-haspopup") === "menu").click()`);
await wait('!!document.querySelector("[data-new-sheet]")');
await run('document.querySelector("[data-new-sheet]").click()');
await wait('location.hash.startsWith("#/sheet/") && !!document.querySelector("[data-sheet-grid]")');

const sheetId = Number(await run('location.hash.match(/^#\\/sheet\\/(\\d+)/)?.[1] || 0'));
if (!sheetId) throw new Error("Failed to navigate to created spreadsheet");
const sheetMeta = await run(`fetch('/api/docs/${sheetId}').then(r => r.json())`);
if (sheetMeta.kind !== "sheet") throw new Error(`Expected sheet kind, got ${JSON.stringify(sheetMeta)}`);

// Confirm Feishu layout ordering: worksheet tabs above toolbar, toolbar above formula bar, formula bar above grid.
const orderOk = await run(`(() => {
  const tabs = document.querySelector('[data-sheet-tabs]')?.getBoundingClientRect();
  const toolbar = document.querySelector('[data-sheet-toolbar]')?.getBoundingClientRect();
  const formula = document.querySelector('[data-sheet-formula]')?.getBoundingClientRect();
  const grid = document.querySelector('[data-sheet-grid]')?.getBoundingClientRect();
  return !!tabs && !!toolbar && !!formula && !!grid && tabs.bottom <= toolbar.top + 1 && toolbar.bottom <= formula.top + 1 && formula.bottom <= grid.top + 1;
})()`);
if (!orderOk) throw new Error("Sheet UI layout order does not match Feishu tabs-above-toolbar layout");

// 2. Rename workbook title & create Sheet2 with cross-sheet reference value.
await run('document.querySelector("[data-sheet-title]").click()');
await wait('!!document.querySelector("[aria-label=\\"工作簿名称\\"]")');
await setInputValue('[aria-label="工作簿名称"]', "Q4 研发预算明细");
await pressKey("Enter", "Enter", 13);
await wait('document.querySelector("[data-sheet-title]")?.textContent?.includes("Q4 研发预算明细")');

await run('document.querySelector("[data-sheet-add-tab]").click()');
await wait('!!document.querySelector("[data-sheet-tab=\\"Sheet2\\"]")');
await run('document.querySelector("[data-sheet-tab=\\"Sheet2\\"]").click()');
await wait('document.querySelector("footer")?.textContent?.includes("Sheet2 ·")');
await editFormulaCell("A1", "500");
await wait('document.querySelector("[data-sheet-cell=\\"0:0\\"]")?.textContent?.includes("500")');

// 3. Return to Sheet1, populate cells, style headers, format currency, merge note, freeze row, write cross-sheet formula.
await run('document.querySelector("[data-sheet-tab=\\"Sheet1\\"]").click()');
await wait('document.querySelector("footer")?.textContent?.includes("Sheet1 ·")');

await editFormulaCell("A1", "项目");
await editFormulaCell("B1", "研发投入");
await editFormulaCell("C1", "云资源");
await editFormulaCell("D1", "汇总合计");

await selectRange("A1:D1");
await run('document.querySelector("[data-sheet-tool=\\"bold\\"]").click()');
await wait('document.querySelector("[data-sheet-save-status]")?.textContent?.includes("已经保存到云端")');
await run('document.querySelector("[aria-label=\\"单元格填充\\"]").click()');
await wait('!!document.querySelector("[aria-label=\\"#eef3ff\\"]")');
await run('document.querySelector("[aria-label=\\"#eef3ff\\"]").click()');
await wait('document.querySelector("[data-sheet-save-status]")?.textContent?.includes("已经保存到云端")');

await run('document.querySelector("[data-sheet-tool=\\"freeze\\"]").click()');
await wait('!![...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("冻结首行"))');
await run('[...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("冻结首行")).click()');
await wait('document.querySelector("[data-sheet-save-status]")?.textContent?.includes("已经保存到云端")');

await editFormulaCell("A2", "飞书对齐专案");
await editFormulaCell("B2", "12000");
await editFormulaCell("C2", "3500");
await editFormulaCell("A3", "协同底座");
await editFormulaCell("B3", "8000");
await editFormulaCell("C3", "2000");

await selectRange("B2:C3");
await run('document.querySelector("[data-sheet-tool=\\"numfmt\\"]").click()');
await wait('!![...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("货币"))');
await run('[...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("货币")).click()');
await wait('document.querySelector("[data-sheet-cell=\\"1:1\\"]")?.textContent?.includes("12,000.00")');

await editFormulaCell("A4", "跨表实时汇总说明");
await selectRange("A4:C4");
await run('document.querySelector("[data-sheet-tool=\\"merge\\"]").click()');
await wait('document.querySelector("[data-sheet-tool=\\"merge\\"]")?.textContent?.includes("取消合并")');

await editFormulaCell("D2", "=SUM(B2:C2)+Sheet2!A1");
await wait('document.querySelector("[data-sheet-cell=\\"1:3\\"]")?.textContent?.includes("16000")');

// Focus formula bar on D2 to verify Feishu #ff8800 orange reference highlight on B2:C2.
await selectRange("D2");
await run('document.querySelector("[data-sheet-formula]").focus()');
await wait('document.querySelector("[data-sheet-cell=\\"1:1\\"] > div")?.style?.boxShadow?.includes("255, 136, 0")');
const desktopLayoutOk = await run(`(() => {
  const titleRect = document.querySelector('[data-sheet-title]')?.getBoundingClientRect();
  const shareRect = document.querySelector('[data-sheet-share]')?.getBoundingClientRect();
  return !!titleRect && !!shareRect && titleRect.left >= 0 && shareRect.right <= 1440 && document.documentElement.scrollWidth <= 1440;
})()`);
if (!desktopLayoutOk) throw new Error("Desktop Sheet layout exceeded 1440px viewport");
await screenshot("jiange-sheet-workbook-desktop-20261118.png");
await pressKey("Escape", "Escape", 27);
await wait('document.querySelector("[data-sheet-cell=\\"1:3\\"]")?.textContent?.includes("16000")');

// 4. Verify multi-sheet XLSX export -> UI file import -> reload persistence.
await run(`(() => {
  window.__exportedBlob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    window.__exportedBlob = blob;
    return orig(blob);
  };
})()`);
await run('document.querySelector("header [aria-label=\\"更多操作\\"]").click()');
await wait('!![...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("导出 XLSX"))');
await run('[...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("导出 XLSX")).click()');
await wait('!!window.__exportedBlob');
const xlsxBytes = await run('(async () => Array.from(new Uint8Array(await window.__exportedBlob.arrayBuffer())))()');
if (!xlsxBytes || xlsxBytes[0] !== 0x50 || xlsxBytes[1] !== 0x4b) {
  throw new Error("Exported XLSX does not start with ZIP magic bytes");
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jiange-sheet-xlsx-"));
const xlsxPath = path.join(tmpDir, "roundtrip.xlsx");
await fs.writeFile(xlsxPath, Buffer.from(xlsxBytes));
try {
  const { root } = await send("DOM.getDocument");
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[aria-label="选择 XLSX 文件"]' });
  await send("DOM.setFileInputFiles", { nodeId, files: [xlsxPath] });
  await wait('!!document.querySelector("[aria-labelledby=\\"sheet-import-confirm-title\\"]")');
  const previewOk = await run('document.querySelector("[aria-labelledby=\\"sheet-import-confirm-title\\"]")?.textContent?.includes("2 个工作表")');
  if (!previewOk) throw new Error("XLSX import dialog did not detect 2 worksheets");
  await run('[...document.querySelectorAll("[aria-labelledby=\\"sheet-import-confirm-title\\"] button")].find(b => b.textContent.includes("确认导入")).click()');
  await wait('document.body.innerText.includes("已导入并保存到云端")');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

await send("Page.reload");
await wait('!!document.querySelector("[data-sheet-tab=\\"Sheet2\\"]") && document.querySelector("[data-sheet-cell=\\"1:3\\"]")?.textContent?.includes("16000")');

// 5. Home TypeFilter ("sheet"), Duplicate preserving workbook content, Global Search cell match, Trash badge.
await run('location.hash = "#/"');
await wait('document.querySelectorAll("[data-home-row]").length >= 1');
await run(`(() => {
  const sel = document.querySelector('select');
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  set.call(sel, 'sheet');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await wait('document.querySelectorAll("[data-home-row]").length === 1 && document.querySelector("[data-home-row]").textContent.includes("Q4 研发预算明细")');

await run('document.querySelector("[aria-label=\\"Q4 研发预算明细 更多操作\\"]").click()');
await wait('!![...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("创建副本"))');
await run('[...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("创建副本")).click()');
await wait('document.body.innerText.includes("副本已创建")');

const copyMeta = await run(`fetch('/api/docs').then(r => r.json()).then(d => d.docs.find(item => item.title === 'Q4 研发预算明细 副本'))`);
if (!copyMeta || copyMeta.kind !== "sheet") throw new Error(`Duplicated sheet invalid: ${JSON.stringify(copyMeta)}`);
const copySnapshot = await run(`fetch('/api/sheets/${copyMeta.id}', { headers: { 'X-Jiange-User-Id': String(${sheetMeta.creatorId}), 'X-Jiange-Sheet-Version': '1' } }).then(r => r.json())`);
if (!copySnapshot || !Array.isArray(copySnapshot.sheets) || copySnapshot.sheets.length !== 2) {
  throw new Error(`Duplicated workbook lost worksheets: ${JSON.stringify(copySnapshot)}`);
}

await run('document.querySelector("[data-search]").click()');
await wait('!!document.querySelector("[role=dialog][aria-label=全局搜索]")');
await setInputValue('[aria-label="搜索文档标题和正文"]', "飞书对齐专案");
await run('[...document.querySelector("[role=dialog][aria-label=全局搜索]").querySelectorAll("button")].find(b => b.textContent.includes("高级搜索")).click()');
await wait('!!document.querySelector("[aria-label=文档类型筛选]")');
await run(`(() => {
  const sel = document.querySelector('[aria-label="文档类型筛选"]');
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  set.call(sel, 'sheet');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await wait('document.querySelector("[role=listbox]")?.textContent?.includes("Q4 研发预算明细")');
await screenshot("jiange-sheet-home-search-20261118.png");
await run('document.querySelector("[aria-label=\\"关闭搜索\\"]").click()');
await wait('!document.querySelector("[role=dialog][aria-label=全局搜索]")');

await run(`location.hash = "#/sheet/${copyMeta.id}"`);
await wait('!!document.querySelector("[data-sheet-grid]")');
await run('document.querySelector("header [aria-label=\\"更多操作\\"]").click()');
await wait('!![...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("移至回收站"))');
await run('[...document.querySelectorAll("[role=menuitem]")].find(b => b.textContent.includes("移至回收站")).click()');
await wait('!!document.querySelector("[data-ask-ok]")');
await run('document.querySelector("[data-ask-ok]").click()');
await wait('location.hash === "#/" || location.hash === ""');

await run('location.hash = "#/trash"');
await wait(`!!document.querySelector('[data-trash-row="${copyMeta.id}"] [data-sheet-tag]')`);

// 6. Simulated mobile viewport (390x844) layout verification.
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await run(`location.hash = "#/sheet/${sheetId}"`);
await wait('!!document.querySelector("[data-sheet-grid]") && document.querySelector("[data-sheet-cell=\\"1:3\\"]")?.textContent?.includes("16000")');
await new Promise((resolve) => setTimeout(resolve, 300));
const mobileOk = await run(`(() => {
  const titleRect = document.querySelector('[data-sheet-title]')?.getBoundingClientRect();
  const shareRect = document.querySelector('[data-sheet-share]')?.getBoundingClientRect();
  return !!titleRect && !!shareRect && titleRect.left >= 44 && shareRect.right <= 390 && document.documentElement.scrollWidth <= 390;
})()`);
if (!mobileOk) throw new Error("Mobile header overlapped sidebar toggle or exceeded 390px viewport");
await screenshot("jiange-sheet-mobile-20261118.png");

console.log(JSON.stringify({ sheetId, copyId: copyMeta.id, verified: ["desktop", "xlsx-roundtrip", "home-filter", "duplicate", "search-cell", "trash", "mobile-390x844"] }));
await send("Page.close");
ws.close();
