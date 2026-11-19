import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9235);
const OUT_DIR = process.env.OUT_DIR || "output/base-dashboard-batch-20261119";
mkdirSync(OUT_DIR, { recursive: true });

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("CDP target not ready");
}

function connectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        consoleErrors,
        close() {
          ws.close();
        },
      });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.code}: ${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params?.exceptionDetails?.text || "exception");
      } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        consoleErrors.push(msg.params.entry.text);
      }
    };
  });
}

async function apiReq(cookie, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return { status: res.status, data: text ? JSON.parse(text) : null, setCookie };
}

async function evalJS(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(`JS error: ${exceptionDetails.text} ${exceptionDetails.exception?.description || ""}`);
  }
  return result?.value;
}

async function waitFor(cdp, expr, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await evalJS(cdp, expr);
    if (val) return val;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for: ${expr}`);
}

async function screenshot(cdp, name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const outPath = `${OUT_DIR}/${name}`;
  writeFileSync(outPath, Buffer.from(data, "base64"));
  console.log("Saved screenshot:", outPath);
}

async function typeInto(cdp, selector, text) {
  const ok = await evalJS(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    })()`,
  );
  if (!ok) throw new Error(`Input not found: ${selector}`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  if (text) await cdp.send("Input.insertText", { text });
  await new Promise((r) => setTimeout(r, 100));
}

async function setCookieOnBrowser(cdp, rawSetCookie) {
  const [nameVal] = rawSetCookie.split(";");
  const eqIdx = nameVal.indexOf("=");
  await cdp.send("Network.setCookie", {
    name: nameVal.slice(0, eqIdx),
    value: nameVal.slice(eqIdx + 1),
    url: APP,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

async function main() {
  const ts = Date.now();
  const email = `bdb-cdp-${ts}@example.com`;
  const reg = await apiReq(null, "POST", "/api/auth/register", {
    email,
    name: "项目总监",
    password: "password123",
  });
  const cookie = reg.setCookie.split(";")[0];
  const userId = String(reg.data.user.id);
  const uidHeader = { "X-Jiange-User-Id": userId };

  // Create Base & configure schema
  const baseNode = (
    await apiReq(cookie, "POST", "/api/drive/nodes", { kind: "base", title: "产品研发交付看板", scope: "personal" }, uidHeader)
  ).data;
  const baseId = baseNode.id;
  const initBase = (await apiReq(cookie, "GET", `/api/bases/${baseId}`)).data;
  const tableId = initBase.tables[0].id;
  const primaryFieldId = initBase.fields[0].id;

  // Rename primary field to 任务名称 & add rich analytical fields
  await apiReq(cookie, "PATCH", `/api/bases/${baseId}/fields/${primaryFieldId}`, { name: "任务名称" });
  const stageField = (
    await apiReq(cookie, "POST", `/api/bases/${baseId}/fields`, {
      tableId,
      name: "项目阶段",
      type: "select",
      options: ["需求评审", "开发中", "测试验收", "已上线"],
    })
  ).data;
  const budgetField = (
    await apiReq(cookie, "POST", `/api/bases/${baseId}/fields`, {
      tableId,
      name: "预算(万)",
      type: "number",
    })
  ).data;
  const dateField = (
    await apiReq(cookie, "POST", `/api/bases/${baseId}/fields`, {
      tableId,
      name: "交付日期",
      type: "date",
    })
  ).data;
  const doneField = (
    await apiReq(cookie, "POST", `/api/bases/${baseId}/fields`, {
      tableId,
      name: "已验收",
      type: "checkbox",
    })
  ).data;

  // Seed 6 realistic rows (using initial 5 rows + 1 new row)
  const extraRec = (await apiReq(cookie, "POST", `/api/bases/${baseId}/records`, { tableId, cells: {} })).data;
  const seedRows = [
    { name: "文档协同重构", stage: "已上线", budget: 120, date: "2026-11-10", done: true },
    { name: "电子表格公式引擎", stage: "已上线", budget: 95, date: "2026-11-14", done: true },
    { name: "多维表格仪表盘", stage: "开发中", budget: 80, date: "2026-11-18", done: false },
    { name: "全局搜索持久索引", stage: "测试验收", budget: 60, date: "2026-11-18", done: true },
    { name: "移动端手势适配", stage: "开发中", budget: 40, date: "2026-11-22", done: false },
    { name: "组织权限审计", stage: "需求评审", budget: 25, date: "2026-11-25", done: false },
  ];
  const allRecordIds = [...initBase.records.map((r) => r.id), extraRec.id];
  const updates = seedRows.map((row, idx) => ({
    id: allRecordIds[idx],
    cells: {
      [String(primaryFieldId)]: row.name,
      [String(stageField.id)]: row.stage,
      [String(budgetField.id)]: row.budget,
      [String(dateField.id)]: row.date,
      [String(doneField.id)]: row.done,
    },
  }));
  await apiReq(cookie, "POST", `/api/bases/${baseId}/records/batch-update`, { updates });

  // Connect Headless Chrome CDP
  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await setCookieOnBrowser(cdp, reg.setCookie);

  // Navigate to Base
  await cdp.send("Page.navigate", { url: `${APP}/#/base/${baseId}` });
  await waitFor(cdp, `document.querySelectorAll('[data-row-check]').length === 6`);
  console.log("Base grid loaded with 6 rows");

  // 1. Check first 2 rows -> verify desktop batch bar appears!
  await evalJS(
    cdp,
    `(() => {
      const checks = [...document.querySelectorAll('[data-row-check]')];
      checks[0].click();
      checks[1].click();
    })()`,
  );
  await waitFor(cdp, `Boolean(document.querySelector('[data-batch-bar]')) && document.querySelector('[data-batch-bar]')?.textContent?.includes('2')`);
  await screenshot(cdp, "01-base-batch-bar.png");
  console.log("Desktop batch bar visible for 2 selected records");

  // 2. Atomic batch delete + Undo restore!
  await evalJS(cdp, `document.querySelector('[data-batch-delete]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[role="alertdialog"]')) || [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === '确定')`);
  // Confirm ask dialog
  await evalJS(
    cdp,
    `(() => {
      const btn = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find(b => b.textContent?.includes('确定') || b.textContent?.includes('删除'));
      if (!btn) throw new Error('Confirm button not found');
      btn.click();
    })()`,
  );
  await waitFor(cdp, `document.querySelectorAll('[data-row-check]').length === 4`);
  console.log("Atomic batch delete reduced rows 6 -> 4");

  // Click toolbar Undo button -> atomically restores both deleted rows!
  await waitFor(cdp, `!document.querySelector('[data-base-undo]')?.disabled`);
  await evalJS(cdp, `document.querySelector('[data-base-undo]').click()`);
  await waitFor(cdp, `document.querySelectorAll('[data-row-check]').length === 6 && document.body.textContent.includes('文档协同重构') && document.body.textContent.includes('电子表格公式引擎')`);
  await screenshot(cdp, "02-base-undo-restored.png");
  console.log("Undo atomically restored both deleted records (4 -> 6)");

  // 3. Switch to Dashboard -> verify default multi-type charts (metric, bar, pie, line, pivot)
  await evalJS(cdp, `document.querySelector('[data-sidebar-dashboard]').click()`);
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-dashboard-viz="bar"]') && document.querySelector('[data-dashboard-viz="pie"]') && document.querySelector('[data-dashboard-viz="line"]') && document.querySelector('[data-dashboard-viz="pivot"]'))`,
  );
  await screenshot(cdp, "03-dashboard-default-charts.png");
  console.log("Default multi-type dashboard rendered (KPI + bar + pie + line + pivot)");

  // 4. Add custom Horizontal Bar widget via modal & persist to PostgreSQL!
  await evalJS(cdp, `document.querySelector('[data-dashboard-add-widget]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-dashboard-widget-modal]'))`);
  await evalJS(cdp, `document.querySelector('[data-widget-type-choice="horizontal_bar"]').click()`);
  await typeInto(cdp, "[data-widget-title-input]", "阶段预算排行条形图");
  await evalJS(
    cdp,
    `(() => {
      const sel = document.querySelector('[data-widget-metric-select]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'sum');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  );
  await new Promise((r) => setTimeout(r, 100));
  await evalJS(cdp, `document.querySelector('[data-widget-save-btn]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-dashboard-viz="horizontal_bar"]')) && document.body.textContent.includes('阶段预算排行条形图')`);

  // Reload page & verify custom widget persisted in Postgres!
  await cdp.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 500));
  await waitFor(cdp, `Boolean(document.querySelector('[data-sidebar-dashboard]'))`);
  await evalJS(cdp, `document.querySelector('[data-sidebar-dashboard]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-dashboard-viz="horizontal_bar"]')) && document.body.textContent.includes('阶段预算排行条形图')`);
  await evalJS(cdp, `(() => { const el = document.querySelector('[data-dashboard]'); if (el) el.scrollTop = el.scrollHeight; })()`);
  await new Promise((r) => setTimeout(r, 250));
  await screenshot(cdp, "04-dashboard-custom-persisted.png");
  console.log("Custom horizontal_bar widget persisted cleanly across full reload");

  // 5. Mobile 390x844 viewport check
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evalJS(cdp, `(() => { const el = document.querySelector('[data-dashboard]'); if (el) el.scrollTop = 0; })()`);
  await new Promise((r) => setTimeout(r, 300));
  const overflow = await evalJS(cdp, `document.documentElement.scrollWidth - window.innerWidth`);
  if (overflow > 2) throw new Error(`Mobile horizontal overflow detected: ${overflow}px`);
  await screenshot(cdp, "05-mobile-dashboard.png");
  console.log("Mobile 390x844 dashboard verified with 0px overflow");

  if (cdp.consoleErrors.length > 0) {
    throw new Error(`Console/page errors detected: ${JSON.stringify(cdp.consoleErrors)}`);
  }

  cdp.close();
  console.log("ALL BASE DASHBOARD & BATCH E2E CHECKS PASSED!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
