import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9234);
const OUT_DIR = process.env.OUT_DIR || "output/sheet-advanced-20261119";
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

async function apiReq(cookie, method, path, body, extraHeaders = {}, allowStatus = null) {
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
  if (allowStatus !== null) {
    return { status: res.status, data: text ? JSON.parse(text) : null, setCookie };
  }
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

async function setReactInput(cdp, selector, value) {
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
  if (value) {
    await cdp.send("Input.insertText", { text: value });
  }
  await new Promise((r) => setTimeout(r, 120));
}

async function setNameBoxRange(cdp, rangeStr) {
  await setReactInput(cdp, "[data-sheet-address]", rangeStr);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor(cdp, `document.querySelector('[data-sheet-address]')?.value === ${JSON.stringify(rangeStr)}`, 5000);
  await new Promise((r) => setTimeout(r, 150));
}

async function setCookieOnBrowser(cdp, rawSetCookie) {
  const [nameVal] = rawSetCookie.split(";");
  const eqIdx = nameVal.indexOf("=");
  const name = nameVal.slice(0, eqIdx);
  const value = nameVal.slice(eqIdx + 1);
  await cdp.send("Network.setCookie", {
    name,
    value,
    url: APP,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

async function main() {
  const ts = Date.now();
  const ownerEmail = `sa-owner-${ts}@example.com`;
  const editorEmail = `sa-editor-${ts}@example.com`;

  const regOwner = await apiReq(null, "POST", "/api/auth/register", {
    email: ownerEmail,
    name: "产品负责人",
    password: "password123",
  });
  const ownerCookie = regOwner.setCookie.split(";")[0];
  const ownerId = regOwner.data.user.id;
  const ownerHeaders = { "X-Jiange-User-Id": String(ownerId), "X-Jiange-Sheet-Version": "1" };

  const regEditor = await apiReq(null, "POST", "/api/auth/register", {
    email: editorEmail,
    name: "研发协作者",
    password: "password123",
  });
  const editorCookie = regEditor.setCookie.split(";")[0];
  const editorId = regEditor.data.user.id;
  const editorHeaders = { "X-Jiange-User-Id": String(editorId), "X-Jiange-Sheet-Version": "1" };

  // Create spreadsheet and share with editor
  const node = (
    await apiReq(ownerCookie, "POST", "/api/drive/nodes", { kind: "sheet", title: "Q4 研发预算与排期", scope: "personal" }, ownerHeaders)
  ).data;
  await apiReq(ownerCookie, "PUT", `/api/docs/${node.id}/shares`, { email: editorEmail, role: "edit" }, ownerHeaders);

  const snap = (await apiReq(ownerCookie, "GET", `/api/sheets/${node.id}`, undefined, ownerHeaders)).data;
  const ws = snap.sheets[0];

  // Seed realistic table data including formula =SUM(C2:C4) in C5
  const seedRows = [
    ["任务模块", "负责人", "预算(万)", "进度状态", "截止日期"],
    ["云文档协同", "张伟", "120", "进行中", "2026-11-30"],
    ["电子表格分析", "李敏", "85", "已完成", "2026-12-15"],
    ["多维表格视图", "王强", "45", "已延期", "2026-11-25"],
    ["合计预算", "自动汇总", "=SUM(C2:C4)", "", ""],
  ];
  const cells = [];
  for (let r = 0; r < seedRows.length; r++) {
    for (let c = 0; c < seedRows[r].length; c++) {
      if (!seedRows[r][c]) continue;
      cells.push({
        rowId: ws.rows[r].id,
        columnId: ws.columns[c].id,
        expectedRevision: 0,
        raw: seedRows[r][c],
        ...(r === 0 || r === 4
          ? { style: { bold: true, bg: r === 0 ? "#f2f3f5" : "#fafbfc" } }
          : {}),
      });
    }
  }
  await apiReq(
    ownerCookie,
    "POST",
    `/api/sheets/${node.id}/cells`,
    { mutationId: "11111111111111111111111111111111", worksheetId: ws.id, cells },
    ownerHeaders,
  );

  // Connect CDP
  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await setCookieOnBrowser(cdp, regOwner.setCookie);

  // Open spreadsheet
  await cdp.send("Page.navigate", { url: `${APP}/#/sheet/${node.id}` });
  await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-page="${node.id}"]') && document.querySelector('[data-sheet-cell="4:2"]')?.textContent?.includes('250'))`);
  console.log("Sheet loaded with evaluated formula total = 250");

  // 1. Add Data Validation on D2:D4 via side panel & test inline dropdown
  await setNameBoxRange(cdp, "D2:D4");
  await evalJS(cdp, `document.querySelector('[data-sheet-tool="validation"]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-panel="validation"]'))`);
  const valPanelText = await evalJS(cdp, `document.querySelector('[data-sheet-panel="validation"]')?.textContent || ''`);
  console.log("Validation panel header range check:", valPanelText.includes("D2:D4") ? "D2:D4 OK" : valPanelText.slice(0, 120));
  await evalJS(cdp, `document.querySelector('[data-sheet-add-validation]').click()`);
  try {
    await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-cell-dropdown-btn="1:3"]'))`, 8000);
  } catch (e) {
    const diag = await evalJS(cdp, `JSON.stringify({ alert: document.querySelector('[role="alert"]')?.textContent, dropdowns: [...document.querySelectorAll('[data-sheet-cell-dropdown-btn]')].map(x => x.getAttribute('data-sheet-cell-dropdown-btn')), valItems: document.querySelectorAll('[data-sheet-validation-item]').length })`);
    throw new Error(`${e.message} | diag=${diag}`);
  }
  // Open dropdown on D2 (row 1, col 3) and capture screenshot
  await evalJS(cdp, `document.querySelector('[data-sheet-cell-dropdown-btn="1:3"]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-dropdown-menu="1:3"]'))`);
  await screenshot(cdp, "01-validation-dropdown.png");

  // Pick "已完成" from dropdown
  await evalJS(cdp, `document.querySelector('[data-sheet-dropdown-option="已完成"]').click()`);
  await waitFor(cdp, `document.querySelector('[data-sheet-cell="1:3"]')?.textContent?.includes('已完成')`);
  console.log("Dropdown selection updated D2 -> 已完成");

  // Verify strict validation blocks invalid write at server (422)
  const snapV = (await apiReq(ownerCookie, "GET", `/api/sheets/${node.id}`, undefined, ownerHeaders)).data;
  const d2Cell = snapV.sheets[0].cells.find((c) => c.rowId === ws.rows[1].id && c.columnId === ws.columns[3].id);
  const badValRes = await apiReq(
    ownerCookie,
    "POST",
    `/api/sheets/${node.id}/cells`,
    {
      mutationId: "22222222222222222222222222222222",
      worksheetId: ws.id,
      cells: [{ rowId: ws.rows[1].id, columnId: ws.columns[3].id, expectedRevision: d2Cell.revision, raw: "非法状态" }],
    },
    ownerHeaders,
    422,
  );
  if (badValRes.status !== 422 || badValRes.data?.error !== "validation_failed") {
    throw new Error(`Expected 422 validation_failed, got ${badValRes.status} ${JSON.stringify(badValRes.data)}`);
  }
  console.log("Strict server validation rejected invalid value with 422 validation_failed");

  // 2. Add Conditional Formatting rules: C2:C5 > 100 (green), D2:D4 == 已延期 (red)
  await setNameBoxRange(cdp, "C2:C5");
  await evalJS(cdp, `document.querySelector('[data-sheet-panel-tab="condfmt"]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-panel="condfmt"]'))`);
  await evalJS(cdp, `document.querySelector('[data-sheet-add-condfmt]').click()`);
  await waitFor(cdp, `document.querySelector('[data-sheet-cell="1:2"]')?.getAttribute('data-sheet-cond-bg') === '#dcfce7' && document.querySelector('[data-sheet-cell="4:2"]')?.getAttribute('data-sheet-cond-bg') === '#dcfce7'`);

  await setNameBoxRange(cdp, "D2:D4");
  await evalJS(
    cdp,
    `(() => {
      const sel = document.querySelector('[data-sheet-cf-op]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'eq');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  );
  await setReactInput(cdp, "[data-sheet-cf-val1]", "已延期");
  await evalJS(cdp, `document.querySelector('[data-sheet-cf-preset="red"]').click()`);
  await evalJS(cdp, `document.querySelector('[data-sheet-add-condfmt]').click()`);
  await waitFor(cdp, `document.querySelector('[data-sheet-cell="3:3"]')?.getAttribute('data-sheet-cond-bg') === '#fee2e2'`);
  await screenshot(cdp, "02-conditional-formatting.png");
  console.log("Conditional formatting dynamically highlighted C2, formula C5 (#dcfce7), and D4 (#fee2e2)");

  // 3. Add Protected Range on A5:E5 (totals row)
  await setNameBoxRange(cdp, "A5:E5");
  await evalJS(cdp, `document.querySelector('[data-sheet-panel-tab="protect"]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-panel="protect"]'))`);
  await setReactInput(cdp, "[data-sheet-protect-desc]", "预算合计公式锁定区（仅管理员可修改）");
  await evalJS(cdp, `document.querySelector('[data-sheet-add-protect]').click()`);
  await waitFor(cdp, `document.querySelector('[data-sheet-cell="4:2"]')?.getAttribute('data-sheet-protected') === 'allowed'`);
  await screenshot(cdp, "03-protected-range.png");
  console.log("Protected range A5:E5 created and persisted");

  // 4. Add Cell-Anchored Comment on C5
  await setNameBoxRange(cdp, "C5");
  await evalJS(cdp, `document.querySelector('[data-sheet-panel-tab="comments"]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-panel="comments"]'))`);
  await setReactInput(cdp, "[data-sheet-comment-input]", "请核对多维表格预算，确认总计 250 万准确无误。");
  await evalJS(cdp, `document.querySelector('[data-sheet-comment-submit]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-cell-comment-badge="4:2"]')) && document.querySelector('[data-sheet-comment-count]')?.textContent?.trim() === '1'`);
  await screenshot(cdp, "04-cell-comments.png");
  console.log("Cell comment anchored on C5 with orange corner badge & count=1");

  // Resolve and reopen comment
  await evalJS(cdp, `document.querySelector('[data-sheet-comment-resolve]').click()`);
  await waitFor(cdp, `document.querySelector('[data-sheet-comment-item]')?.getAttribute('data-sheet-comment-resolved') === 'true' && !document.querySelector('[data-sheet-cell-comment-badge="4:2"]')`);
  await evalJS(cdp, `document.querySelector('[data-sheet-comment-resolve]').click()`);
  await waitFor(cdp, `document.querySelector('[data-sheet-comment-item]')?.getAttribute('data-sheet-comment-resolved') === 'false' && Boolean(document.querySelector('[data-sheet-cell-comment-badge="4:2"]'))`);
  console.log("Comment resolve & reopen toggled cleanly");

  // 5. Verify Editor collaborator is blocked from editing protected range A5:E5 at API + UI
  const snapP = (await apiReq(editorCookie, "GET", `/api/sheets/${node.id}`, undefined, editorHeaders)).data;
  const c5Cell = snapP.sheets[0].cells.find((c) => c.rowId === ws.rows[4].id && c.columnId === ws.columns[2].id);
  const blockedWrite = await apiReq(
    editorCookie,
    "POST",
    `/api/sheets/${node.id}/cells`,
    {
      mutationId: "33333333333333333333333333333333",
      worksheetId: ws.id,
      cells: [{ rowId: ws.rows[4].id, columnId: ws.columns[2].id, expectedRevision: c5Cell.revision, raw: "999" }],
    },
    editorHeaders,
    403,
  );
  if (blockedWrite.status !== 403) {
    throw new Error(`Expected 403 for editor writing protected C5, got ${blockedWrite.status}`);
  }
  const blockedDeleteRow = await apiReq(
    editorCookie,
    "POST",
    `/api/sheets/${node.id}/worksheets/${ws.id}/axes`,
    { op: "delete_row", index: 4, count: 1 },
    editorHeaders,
    403,
  );
  if (blockedDeleteRow.status !== 403) {
    throw new Error(`Expected 403 for editor deleting protected row 5, got ${blockedDeleteRow.status}`);
  }

  // Switch browser cookie to Editor and verify client-side blocked state + alert
  await setCookieOnBrowser(cdp, regEditor.setCookie);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, `document.querySelector('[data-sheet-cell="4:2"]')?.getAttribute('data-sheet-protected') === 'blocked'`);
  await evalJS(
    cdp,
    `document.querySelector('[data-sheet-cell="4:2"] > div').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
  );
  await waitFor(cdp, `document.querySelector('[role="alert"]')?.textContent?.includes('保护区域')`);
  console.log("Editor blocked from editing protected C5 in both API (403) and UI");

  // 6. Mobile 390x844 layout check
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 300));
  await evalJS(cdp, `document.querySelector('[data-sheet-tool="comments"]').click()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-sheet-panel="comments"]'))`);
  const overflow = await evalJS(cdp, `document.documentElement.scrollWidth - window.innerWidth`);
  if (overflow > 2) throw new Error(`Mobile horizontal overflow detected: ${overflow}px`);
  await screenshot(cdp, "05-mobile-sheet-panel.png");
  console.log("Mobile 390x844 layout verified with 0px overflow");

  if (cdp.consoleErrors.length > 0) {
    throw new Error(`Console/page errors detected: ${JSON.stringify(cdp.consoleErrors)}`);
  }

  cdp.close();
  console.log("ALL SHEET ADVANCED E2E CHECKS PASSED!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
