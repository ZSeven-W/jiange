import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9232);
const OUT_DIR = process.env.OUT_DIR || "output/home-drive-closure-20261119";
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
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      consoleErrors,
      close() { ws.close(); },
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
  return { data: text ? JSON.parse(text) : null, setCookie };
}

async function waitFor(cdp, expr, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (result?.value) return result.value;
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

async function main() {
  const ts = Date.now();
  const email = `hd-cdp-${ts}@example.com`;
  const reg = await apiReq(null, "POST", "/api/auth/register", { email, name: "DriveOwner", password: "password123" });
  const cookie = reg.setCookie.split(";")[0];
  const userId = String(reg.data.user.id);
  const uidHeader = { "X-Jiange-User-Id": userId };

  // Seed Drive items in personal scope
  const folder = (await apiReq(cookie, "POST", "/api/drive/folders", { title: "研发档案", scope: "personal" }, uidHeader)).data;
  const docNode = (await apiReq(cookie, "POST", "/api/drive/nodes", { kind: "doc", title: "架构评审纪要", scope: "personal" }, uidHeader)).data;
  const baseNode = (await apiReq(cookie, "POST", "/api/drive/nodes", { kind: "base", title: "项目台账", scope: "personal" }, uidHeader)).data;
  const sheetNode = (await apiReq(cookie, "POST", "/api/drive/nodes", { kind: "sheet", title: "财务预算表", scope: "personal" }, uidHeader)).data;

  // Add second table & row to Base so we verify multi-table duplication fidelity
  await apiReq(cookie, "POST", `/api/bases/${baseNode.id}/tables`, { name: "里程碑清单" });
  const baseDetail = (await apiReq(cookie, "GET", `/api/bases/${baseNode.id}`)).data;
  await apiReq(cookie, "POST", `/api/bases/${baseNode.id}/records`, {
    cells: { [String(baseDetail.fields[0].id)]: "主表核心任务" },
  }, uidHeader);

  // Pin docNode & sheetNode, record visits so Home displays all three
  await apiReq(cookie, "PUT", `/api/docs/${docNode.id}/account-pin`, undefined, uidHeader);
  await apiReq(cookie, "PUT", `/api/docs/${sheetNode.id}/account-pin`, undefined, uidHeader);
  for (const n of [docNode, baseNode, sheetNode]) {
    await apiReq(cookie, "POST", `/api/docs/${n.id}/visit`);
  }

  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const [cookieName, cookieVal] = cookie.split("=");
  await cdp.send("Network.setCookie", { name: cookieName, value: cookieVal, domain: "127.0.0.1", path: "/" });
  await cdp.send("Page.navigate", { url: `${APP}/#/home` });
  await cdp.send("Page.bringToFront");

  // 1) Verify Home pinned docs section & batch selection
  await waitFor(cdp, `document.querySelectorAll('[data-home-pin-card]').length === 2`);
  await waitFor(cdp, `document.querySelectorAll('[data-home-row]').length >= 3`);

  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const checks = [...document.querySelectorAll('[data-home-row] [data-home-select]')];
      if (checks.length < 2) throw new Error("expected >= 2 home checkboxes");
      checks[0].click();
      checks[1].click();
    })()`,
  });
  await waitFor(cdp, `document.querySelector('[data-home-batch]')?.innerText.includes("已选择 2 项")`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "01-home-pins-and-batch.png");

  // Duplicate Base directly from Home more-actions menu!
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector('button[aria-label="项目台账 更多操作"]');
      if (!btn) throw new Error("base actions button not found");
      btn.click();
    })()`,
  });
  await waitFor(cdp, `[...document.querySelectorAll('[role="menuitem"]')].some((b) => (b.textContent || "").includes("创建副本"))`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => (b.textContent || "").includes("创建副本"));
      if (!item || item.disabled) throw new Error("base duplicate menu item missing or disabled");
      item.click();
    })()`,
  });
  await waitFor(cdp, `document.body.innerText.includes("副本已创建")`);
  console.log("Home pinned docs, batch toolbar, and Base duplication verified.");

  // 2) Navigate to Drive (我的文件夹)
  await cdp.send("Page.navigate", { url: `${APP}/#/drive/mine` });
  await waitFor(cdp, `!!document.querySelector('[data-drive-folder="${folder.id}"]')`);
  await waitFor(cdp, `!!document.querySelector('[data-drive-add-shortcut]')`);

  // Add shortcut to 架构评审纪要
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-drive-add-shortcut]').click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[role="dialog"][aria-label="添加快捷方式"]')`);
  await waitFor(cdp, `document.querySelector('[role="dialog"][aria-label="添加快捷方式"]')?.innerText.includes("架构评审纪要")`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="添加快捷方式"]');
      const row = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || "").includes("架构评审纪要"));
      if (!row) throw new Error("shortcut candidate not found");
      row.click();
    })()`,
  });
  await new Promise((r) => setTimeout(r, 150));
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="添加快捷方式"]');
      const confirm = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || "").includes("添加到当前目录"));
      if (!confirm || confirm.disabled) throw new Error("confirm shortcut button disabled");
      confirm.click();
    })()`,
  });
  await waitFor(cdp, `document.querySelector('[data-drive-shortcuts]')?.innerText.includes("架构评审纪要")`);
  console.log("Drive shortcut creation & rendering verified.");

  // Switch to Grid View and select two cards via batch checkboxes
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('button[aria-label="网格视图"]').click()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-drive-card]').length >= 3`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const boxes = [...document.querySelectorAll('[data-drive-card] [data-drive-select]')];
      if (boxes.length < 2) throw new Error("expected >= 2 grid checkboxes");
      boxes[0].click();
      boxes[1].click();
    })()`,
  });
  await waitFor(cdp, `document.querySelector('[data-drive-batch]')?.innerText.includes("已选择 2 项")`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "02-drive-shortcuts-and-grid-batch.png");

  // Clear selection, copy 项目台账 into folder 研发档案 via CopyToDialog
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const cancel = [...document.querySelectorAll('[data-drive-batch] button')].find((b) => (b.textContent || "").includes("取消选择"));
      if (cancel) cancel.click();
    })()`,
  });
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector('[data-drive-card="${baseNode.id}"] button[aria-label*="更多操作"]');
      if (!btn) throw new Error("drive card menu not found");
      btn.click();
    })()`,
  });
  await waitFor(cdp, `[...document.querySelectorAll('button')].some((b) => (b.textContent || "").trim() === "复制到…")`);
  await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('button')].find((b) => (b.textContent || "").trim() === "复制到…").click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[role="dialog"][aria-label="复制到指定目录"]')`);
  await waitFor(cdp, `document.querySelector('[role="dialog"][aria-label="复制到指定目录"]')?.innerText.includes("研发档案")`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="复制到指定目录"]');
      const folderBtn = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || "").includes("研发档案"));
      folderBtn.click();
    })()`,
  });
  await new Promise((r) => setTimeout(r, 250));
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="复制到指定目录"]');
      const copyBtn = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || "").includes("复制到这里"));
      copyBtn.click();
    })()`,
  });
  await waitFor(cdp, `document.body.innerText.includes("已创建副本")`);
  console.log("Drive copy-to-folder verified.");

  // Drag and drop 财务预算表 card onto folder card 研发档案!
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const src = document.querySelector('[data-drive-card="${sheetNode.id}"]');
      const dst = document.querySelector('[data-drive-folder="${folder.id}"]');
      if (!src || !dst) throw new Error("drag src or dst not found");
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`,
  });
  await waitFor(cdp, `!document.querySelector('[data-drive-card="${sheetNode.id}"]')`);
  console.log("Drive drag-and-drop move into folder verified.");

  // Navigate into folder 研发档案 and verify both copied Base and dragged Sheet live inside!
  await cdp.send("Page.navigate", { url: `${APP}/#/drive/${folder.id}` });
  await waitFor(cdp, `document.body.innerText.includes("项目台账 副本") && document.body.innerText.includes("财务预算表")`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "03-drive-folder-copy-and-drop.png");

  // Verify copied Base inside folder has 2 data tables via API
  const folderChildren = (await apiReq(cookie, "GET", `/api/drive/children?parent=${folder.id}`)).data.entries;
  const copiedBaseInFolder = folderChildren.find((e) => e.kind === "base" && e.title === "项目台账 副本");
  if (!copiedBaseInFolder) throw new Error("Copied Base not found in target folder children");
  const copiedBaseDetail = (await apiReq(cookie, "GET", `/api/bases/${copiedBaseInFolder.id}`)).data;
  if (!Array.isArray(copiedBaseDetail.tables) || copiedBaseDetail.tables.length !== 2) {
    throw new Error(`Expected copied Base to preserve 2 tables, got ${JSON.stringify(copiedBaseDetail.tables)}`);
  }

  // 3) Mobile 390x844 verification for Home and Drive
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Page.navigate", { url: `${APP}/#/home` });
  await waitFor(cdp, `!!document.querySelector('[data-home-pins]')`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "04-home-mobile.png");

  await cdp.send("Page.navigate", { url: `${APP}/#/drive/mine` });
  await waitFor(cdp, `!!document.querySelector('[data-drive-shortcuts]')`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "05-drive-mobile.png");

  if (cdp.consoleErrors.length) {
    throw new Error(`Console errors: ${cdp.consoleErrors.join("; ")}`);
  }
  console.log("CDP Home & Drive closure verification succeeded with 0 console errors.");
  cdp.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
