import fs from "node:fs/promises";
import path from "node:path";

const APP = process.env.JIANGE_SHEET_TEST_URL || "http://127.0.0.1:5174";
const CDP = process.env.JIANGE_SHEET_CDP_URL || "http://127.0.0.1:9227";
const OUT = process.env.JIANGE_SHEET_SCREENSHOT_DIR || process.cwd();
if (![APP, CDP].every((url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))) {
  throw new Error("Only local disposable URLs allowed");
}
await fs.mkdir(OUT, { recursive: true });

const versionInfo = await (await fetch(new URL("/json/version", CDP))).json();
const browserWs = new WebSocket(versionInfo.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  browserWs.onopen = res;
  browserWs.onerror = rej;
});

let bSeq = 0;
const bJobs = new Map();
browserWs.onmessage = (ev) => {
  const item = JSON.parse(ev.data);
  if (!item.id) return;
  const job = bJobs.get(item.id);
  if (!job) return;
  bJobs.delete(item.id);
  item.error ? job.reject(new Error(item.error.message)) : job.resolve(item.result);
};
const bSend = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++bSeq;
    bJobs.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, method, params }));
  });

const { browserContextId } = await bSend("Target.createBrowserContext", { disposeOnDetach: true });
const { targetId } = await bSend("Target.createTarget", { url: "about:blank", browserContextId });
const list = await (await fetch(new URL("/json/list", CDP))).json();
const target = list.find((t) => t.id === targetId);
if (!target?.webSocketDebuggerUrl) throw new Error(`Missing WS URL for target ${targetId}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const jobs = new Map();
const consoleErrors = [];
const pageErrors = [];
ws.onmessage = (ev) => {
  const item = JSON.parse(ev.data);
  if (item.method === "Runtime.consoleAPICalled" && item.params?.type === "error") {
    consoleErrors.push((item.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (item.method === "Runtime.exceptionThrown") {
    pageErrors.push(item.params?.exceptionDetails?.text || "exception");
  }
  if (!item.id) return;
  const job = jobs.get(item.id);
  if (!job) return;
  jobs.delete(item.id);
  item.error ? job.reject(new Error(item.error.message)) : job.resolve(item.result);
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
const wait = async (expression, limit = 160) => {
  for (let i = 0; i < limit; i++) {
    try {
      if (await run(expression)) return;
    } catch (err) {
      if (err?.code !== -32000) throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for: ${expression}\nBody: ${(await run("document.body.innerText")).slice(0, 600)}`);
};
const screenshot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(OUT, name), Buffer.from(data, "base64"));
};
const assertNoOverflow = async (label) => {
  const rect = await run(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`);
  if (rect.scrollWidth > rect.innerWidth) {
    throw new Error(`${label} horizontal overflow: ${rect.scrollWidth} > ${rect.innerWidth}`);
  }
};
const setInputValue = async (selector, value) => {
  await run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('missing input ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
};
const setSelectValue = async (selector, value) => {
  await run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('missing select ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

try {
  // 1. Register user and reload app so authenticated session loads cleanly.
  await send("Page.navigate", { url: `${APP}/` });
  await wait(`!!document.querySelector('form')`);
  const suffix = Date.now();
  const me = await run(`fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sheet-analytics-${suffix}@example.test', name: 'Analyst', password: 'password123' })
  }).then(async (r) => { if (!r.ok) throw new Error('register ' + r.status + ' ' + await r.text()); return r.json(); })`);
  const userId = me.user.id;
  const wsId = me.workspaces[0].id;

  // Create Sheet workbook via API and seed realistic multi-row sales data with live formulas.
  const created = await run(`fetch('/api/drive/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Jiange-User-Id': '${userId}' },
    body: JSON.stringify({ kind: 'sheet', title: '2026 销售分析与透视', scope: 'private' })
  }).then(async (r) => { if (!r.ok) throw new Error('create sheet ' + r.status + ' ' + await r.text()); return r.json(); })`);
  const sheetId = created.id;

  const snap = await run(`fetch('/api/sheets/${sheetId}', {
    headers: { 'X-Jiange-User-Id': '${userId}', 'X-Jiange-Sheet-Version': '1' }
  }).then(async (r) => { if (!r.ok) throw new Error('get sheet ' + r.status + ' ' + await r.text()); return r.json(); })`);
  const firstSheet = snap.sheets[0];

  const rowsData = [
    ["部门", "季度", "销售额", "成本", "利润"],
    ["市场部", "Q1", "120", "70", "=C2-D2"],
    ["市场部", "Q2", "180", "95", "=C3-D3"],
    ["研发部", "Q1", "200", "110", "=C4-D4"],
    ["研发部", "Q2", "260", "140", "=C5-D5"],
    ["交付部", "Q1", "90", "55", "=C6-D6"],
    ["交付部", "Q2", "140", "80", "=C7-D7"],
  ];
  const seedCells = [];
  for (let r = 0; r < rowsData.length; r++) {
    for (let c = 0; c < rowsData[r].length; c++) {
      seedCells.push({
        rowId: firstSheet.rows[r].id,
        columnId: firstSheet.columns[c].id,
        expectedRevision: 0,
        raw: rowsData[r][c],
        style: r === 0 ? { bold: true, bg: "#eef3ff" } : {},
      });
    }
  }
  const seedMutId = String(suffix).padStart(32, "a").slice(-32);
  await run(`fetch('/api/sheets/${sheetId}/cells', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Jiange-User-Id': '${userId}', 'X-Jiange-Sheet-Version': '1' },
    body: JSON.stringify({
      mutationId: '${seedMutId}',
      worksheetId: ${firstSheet.id},
      mergeMode: 'auto',
      cells: ${JSON.stringify(seedCells)}
    })
  }).then(async (r) => { if (!r.ok) throw new Error('seed failed ' + r.status + ' ' + await r.text()); })`);

  // Reload to hydrate session then open the Sheet.
  await send("Page.reload", { ignoreCache: true });
  await wait(`!document.querySelector('input[type="password"]')`);
  await run(`location.hash = '#/sheet/${sheetId}'`);
  await wait(`document.querySelector('[data-sheet-cell="4:4"]')?.innerText?.trim() === '120'`);
  await assertNoOverflow("desktop-initial");

  // 2. Open Charts side panel and insert Column chart over A1:E7.
  await run(`document.querySelector('[data-sheet-tool="charts"]').click()`);
  await wait(`!!document.querySelector('[data-sheet-charts-panel]')`);
  await setInputValue("[data-chart-title-input]", "部门季度业绩对比");
  await setInputValue("[data-chart-range-input]", "A1:E7");
  await run(`document.querySelector('[data-chart-save-btn]').click()`);
  await wait(`document.querySelectorAll('[data-sheet-chart]').length === 1`);

  // Drag-move chart 1 smoothly to the right of the sales table so it sits neatly at x=560, y=36.
  const chartDragBox = await run(`(() => {
    const el = document.querySelector('[data-sheet-chart-drag]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await run(`(() => {
    const el = document.querySelector('[data-sheet-chart-drag]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${chartDragBox.x}, clientY: ${chartDragBox.y}, button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${chartDragBox.x + 510}, clientY: ${chartDragBox.y - 180}, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${chartDragBox.x + 510}, clientY: ${chartDragBox.y - 180} }));
  })()`);
  await wait(`(() => {
    const el = document.querySelector('[data-sheet-chart]');
    return el && parseInt(el.style.left, 10) >= 500;
  })()`);

  // Verify chart SVG rendered strictly 3 numeric series (6 rows x 3 series = 18 bars, skipping text-only 季度)!
  const chart1Check = await run(`(() => {
    const el = document.querySelector('[data-sheet-chart]');
    return {
      rectCount: el.querySelectorAll('svg rect').length,
      text: el.textContent,
      left: parseInt(el.style.left, 10),
      top: parseInt(el.style.top, 10),
    };
  })()`);
  if (chart1Check.rectCount !== 18 || !chart1Check.text.includes("市场部·Q1")) {
    throw new Error(`Expected 18 SVG column bars (3 numeric series x 6 rows) with combined labels, got ${JSON.stringify(chart1Check)}`);
  }

  // Insert a 2nd embedded chart: Pie chart (销售额分布占比) below the table.
  await run(`document.querySelector('[data-sheet-charts-panel] button')?.click()`);
  await wait(`document.querySelector('[data-chart-save-btn]')?.textContent?.includes('插入图表到画布')`);
  await setInputValue("[data-chart-title-input]", "销售额分布占比");
  await run(`document.querySelector('[data-chart-type-option="pie"]').click()`);
  await setInputValue("[data-chart-range-input]", "A1:C7");
  await run(`document.querySelector('[data-chart-save-btn]').click()`);
  await wait(`document.querySelectorAll('[data-sheet-chart]').length === 2`);
  await wait(`document.querySelectorAll('[data-sheet-chart]')[1].querySelectorAll('[data-chart-pie-slice]').length === 6`);

  // Verify live formula reactivity: update C5 (row 4 col 2) from 260 -> 300 so E5 (=C5-D5) becomes 160!
  await run(`(() => {
    const cell = document.querySelector('[data-sheet-cell="4:2"] > div');
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await wait(`!!document.querySelector('[data-sheet-cell="4:2"] input')`);
  await run(`(() => {
    const inp = document.querySelector('[data-sheet-cell="4:2"] input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '300');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(`document.querySelector('[data-sheet-cell="4:4"]')?.innerText?.trim() === '160'`);
  await wait(`(() => {
    const c1 = document.querySelectorAll('[data-sheet-chart]')[0];
    return c1 && c1.textContent.includes('160');
  })()`);

  await assertNoOverflow("desktop-charts");
  await screenshot("sheet-charts-desktop.png");

  // 3. Switch to Pivot Table panel, build cross-tab pivot over live formula column 利润 (col 4).
  await run(`document.querySelector('[data-sheet-tool="pivot"]').click()`);
  await wait(`!!document.querySelector('[data-sheet-pivot-panel]')`);
  await setInputValue("[data-pivot-title-input]", "各部门季度利润透视");
  await setInputValue("[data-pivot-range-input]", "A1:E7");
  await setSelectValue("[data-pivot-col-field]", "1");
  await setSelectValue('[data-pivot-value-col="0"]', "4");
  await setSelectValue('[data-pivot-value-agg="0"]', "sum");

  await wait(`(() => {
    const t = document.querySelector('[data-pivot-preview-table]');
    return t && t.innerText.includes('研发部') && t.innerText.includes('250') && t.innerText.includes('480');
  })()`);

  // Save pivot table config to worksheet metadata.
  await run(`document.querySelector('[data-pivot-save-btn]').click()`);
  await wait(`document.querySelectorAll('[data-pivot-saved-item]').length === 1`);
  await assertNoOverflow("desktop-pivot");
  await screenshot("sheet-pivot-desktop.png");

  // Materialize pivot table to a brand-new styled worksheet!
  await run(`document.querySelector('[data-pivot-materialize-btn]').click()`);
  await wait(`document.querySelectorAll('[data-sheet-tab]').length === 2`);
  await wait(`document.querySelector('[data-sheet-grid]')?.innerText?.includes('480') && document.querySelector('[data-sheet-grid]')?.innerText?.includes('250')`);
  await run(`document.querySelector('[data-sheet-panel-close]')?.click()`);
  await new Promise((r) => setTimeout(r, 250));
  await assertNoOverflow("desktop-pivot-materialized");
  await screenshot("sheet-pivot-materialized-desktop.png");

  // 4. Reload browser and verify full PostgreSQL persistence of charts, pivot config, and materialized sheet!
  await send("Page.reload", { ignoreCache: true });
  await wait(`document.querySelectorAll('[data-sheet-tab]').length === 2`);
  // Switch to Sheet1 (first tab)
  await run(`document.querySelectorAll('[data-sheet-tab]')[0].click()`);
  await wait(`document.querySelectorAll('[data-sheet-chart]').length === 2`);
  const persistedCharts = await run(`Array.from(document.querySelectorAll('[data-sheet-chart]')).map(el => ({
    type: el.getAttribute('data-sheet-chart-type'),
    left: parseInt(el.style.left, 10),
    hasSvg: !!el.querySelector('svg'),
  }))`);
  if (persistedCharts[0].type !== "column" || persistedCharts[0].left < 500 || persistedCharts[1].type !== "pie") {
    throw new Error(`Unexpected persisted charts after reload: ${JSON.stringify(persistedCharts)}`);
  }

  // Re-open Pivot panel and confirm saved pivot config persisted in Postgres!
  await run(`document.querySelector('[data-sheet-tool="pivot"]').click()`);
  await wait(`document.querySelectorAll('[data-pivot-saved-item]').length === 1`);

  // 5. Mobile 390x844 responsive verification (both drawer open & closed, 0px horizontal overflow).
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 300));
  await assertNoOverflow("mobile-390-pivot-open");
  await screenshot("sheet-pivot-mobile.png");

  await run(`document.querySelector('[data-sheet-panel-close]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  await assertNoOverflow("mobile-390-charts");
  await screenshot("sheet-charts-mobile.png");

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(`Browser errors detected: console=${JSON.stringify(consoleErrors)} page=${JSON.stringify(pageErrors)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    sheetId,
    chart1Check,
    persistedCharts,
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
  }, null, 2));
} finally {
  ws.close();
  await bSend("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  browserWs.close();
}
