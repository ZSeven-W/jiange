import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:18080";
const CDP_PORT = Number(process.env.CDP_PORT || 9226);
const OUT_DIR = process.env.OUT_DIR || "output/base-multitable-verify-20261119";
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

async function apiReq(cookie, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return { data: text ? JSON.parse(text) : null, setCookie };
}

function cookieValue(setCookie) {
  return setCookie.split(";")[0];
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
  const aliceEmail = `alice-mt-${ts}@example.com`;
  const bobEmail = `bob-mt-${ts}@example.com`;

  const aReg = await apiReq(null, "POST", "/api/auth/register", { email: aliceEmail, name: "Alice", password: "password123" });
  const aliceCookie = cookieValue(aReg.setCookie);
  const bReg = await apiReq(null, "POST", "/api/auth/register", { email: bobEmail, name: "Bob", password: "password123" });
  const bobCookie = cookieValue(bReg.setCookie);

  const me = await apiReq(aliceCookie, "GET", "/api/me");
  const wsId = me.data.workspaces[0].id;

  const base = (await apiReq(aliceCookie, "POST", "/api/bases", { workspaceId: wsId, title: "项目与任务管理" })).data;
  const snap1 = (await apiReq(aliceCookie, "GET", `/api/bases/${base.id}`)).data;
  const projTableId = snap1.tables[0].id;
  const projPrimaryId = snap1.fields[0].id;

  await apiReq(aliceCookie, "PATCH", `/api/bases/${base.id}/tables/${projTableId}`, { name: "项目表" });
  const taskTable = (await apiReq(aliceCookie, "POST", `/api/bases/${base.id}/tables`, { name: "任务表" })).data;
  const snap2 = (await apiReq(aliceCookie, "GET", `/api/bases/${base.id}?tableId=${taskTable.id}`)).data;
  const taskPrimaryId = snap2.fields[0].id;
  const taskViewId = snap2.views[0].id;

  const projRec = (await apiReq(aliceCookie, "POST", `/api/bases/${base.id}/records`, {
    tableId: projTableId,
    cells: { [projPrimaryId]: "飞书对齐专项" },
  })).data;

  const linkField = (await apiReq(aliceCookie, "POST", `/api/bases/${base.id}/fields`, {
    tableId: taskTable.id,
    name: "所属项目",
    type: "link",
    options: [String(base.id)],
    targetTableId: projTableId,
  })).data;

  await apiReq(aliceCookie, "POST", `/api/bases/${base.id}/records`, {
    tableId: taskTable.id,
    cells: { [taskPrimaryId]: "完成多数据表与视图锁", [linkField.id]: [projRec.id] },
  });

  // Alice locks view config (NOT data permission!) on 任务表's default view.
  await apiReq(aliceCookie, "PATCH", `/api/bases/${base.id}/views/${taskViewId}`, {
    config: { configLocked: true },
  });

  // Share to Bob with edit role.
  await apiReq(aliceCookie, "PUT", `/api/docs/${base.id}/shares`, { email: bobEmail, role: "edit" });

  // Bob creates a personal view on 任务表.
  const personalView = (await apiReq(bobCookie, "POST", `/api/bases/${base.id}/views`, {
    tableId: taskTable.id,
    type: "grid",
    name: "Bob 个人视图",
    isPersonal: true,
  })).data;

  // Verify Alice cannot see Bob's personal view.
  const aliceTaskSnap = (await apiReq(aliceCookie, "GET", `/api/bases/${base.id}?tableId=${taskTable.id}`)).data;
  if (aliceTaskSnap.views.some((v) => v.id === personalView.id)) {
    throw new Error("Alice must NOT see Bob's personal view!");
  }

  // Open browser via CDP.
  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  async function loginAs(cookie) {
    const [name, value] = cookie.split("=");
    await cdp.send("Network.clearBrowserCookies");
    await cdp.send("Network.setCookie", { name, value, url: APP, path: "/" });
  }

  // 1. Alice desktop view: multi-table sidebar, 任务表 active, linked record title + 锁定视图配置 toggle.
  await loginAs(aliceCookie);
  await cdp.send("Page.navigate", { url: `${APP}/#/base/${base.id}` });
  await waitFor(cdp, `document.body.innerText.includes("项目表") && document.body.innerText.includes("任务表")`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-base-table-item="${taskTable.id}"] button')?.click()`,
  });
  await waitFor(cdp, `document.body.innerText.includes("完成多数据表与视图锁") && document.body.innerText.includes("飞书对齐专项")`);
  await waitFor(cdp, `!!document.querySelector('[data-config-lock-toggle] input')?.checked && !document.querySelector('[data-lock-toggle] input')?.checked`);
  await new Promise((r) => setTimeout(r, 400));
  await screenshot(cdp, "01-alice-multitable-config-lock.png");

  // 2. Bob desktop view: switches to 任务表, sees 配置已锁定 badge on shared view, NO writeRestricted banner, and sees his personal view tab.
  await loginAs(bobCookie);
  await cdp.send("Page.navigate", { url: `${APP}/` });
  await waitFor(cdp, `document.body.innerText.includes("项目与任务管理") || true`);
  await cdp.send("Page.navigate", { url: `${APP}/#/base/${base.id}` });
  await waitFor(cdp, `document.body.innerText.includes("任务表")`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-base-table-item="${taskTable.id}"] button')?.click()`,
  });
  await waitFor(cdp, `document.body.innerText.includes("Bob 个人视图") && document.body.innerText.includes("配置已锁定")`);
  const bobRestricted = (await cdp.send("Runtime.evaluate", {
    expression: `document.body.innerText.includes("暂不支持在受限权限下编辑")`,
    returnByValue: true,
  })).result.value;
  if (bobRestricted) throw new Error("Bob should NOT see writeRestricted banner for configLocked view!");
  await new Promise((r) => setTimeout(r, 350));
  await screenshot(cdp, "02-bob-config-locked-and-personal-view.png");

  // Click Bob's personal view tab to show personal view badge.
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-view-id="${personalView.id}"]')?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-personal-view-badge]')`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "03-bob-personal-view-active.png");

  // 3. Simulated mobile viewport 390x844.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await waitFor(cdp, `!!document.querySelector('[data-base-mobile-nav]')`);
  await new Promise((r) => setTimeout(r, 400));
  await screenshot(cdp, "04-mobile-multitable.png");

  if (cdp.consoleErrors.length > 0) {
    console.warn("Console errors:", cdp.consoleErrors);
  } else {
    console.log("Zero console errors.");
  }
  cdp.close();
  console.log("CDP verification PASSED!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
