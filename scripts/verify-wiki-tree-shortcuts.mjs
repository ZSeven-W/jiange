import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9239);
const OUT_DIR = process.env.OUT_DIR || "/tmp/wiki-tree-shortcuts-20261120";
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
        consoleErrors.push(`EXCEPTION: ${msg.params?.exceptionDetails?.text || "exception"}`);
      } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        consoleErrors.push(`LOG: ${msg.params.entry.text} (${msg.params.entry.url || ""})`);
      }
    };
  });
}

async function apiReq(cookie, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") || "" };
}

async function registerUser(email, name) {
  const res = await apiReq("", "POST", "/api/auth/register", { email, name, password: "password123" });
  if (res.status !== 201) throw new Error(`register ${email}: ${res.status} ${res.text}`);
  const cookie = res.setCookie.split(";")[0];
  return { user: res.json.user, workspace: res.json.workspaces[0], cookie };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJS(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(`evalJS error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception)}`);
  }
  return res.result?.value;
}

async function waitFor(cdp, label, fnSource, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await evalJS(cdp, `(${fnSource})()`);
    if (val) return val;
    await sleep(150);
  }
  const debug = await evalJS(cdp, `({ url: location.href, text: document.body.innerText.slice(0, 700) })`);
  throw new Error(`Timed out waiting for ${label}; debug=${JSON.stringify(debug)}`);
}

async function screenshot(cdp, filename) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const outPath = `${OUT_DIR}/${filename}`;
  writeFileSync(outPath, Buffer.from(data, "base64"));
  return outPath;
}

async function setCookieOnBrowser(cdp, cookie) {
  const [name, ...rest] = cookie.split("=");
  const value = rest.join("=");
  await cdp.send("Network.setCookie", { name, value, url: APP, path: "/" });
  await cdp.send("Network.setCookie", { name, value, url: API, path: "/" });
}

async function dragWikiRow(cdp, sourceId, targetId, zone) {
  return evalJS(cdp, `(() => {
    const src = document.querySelector('[data-wiki-tree-row="${sourceId}"]');
    const dst = document.querySelector('[data-wiki-tree-row="${targetId}"]');
    if (!src || !dst) return { ok: false, reason: 'missing row' };
    const rect = dst.getBoundingClientRect();
    const ratio = "${zone}" === "before" ? 0.12 : "${zone}" === "after" ? 0.88 : 0.5;
    const clientY = rect.top + rect.height * ratio;
    const clientX = rect.left + rect.width * 0.5;
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
    const indicator = dst.getAttribute('data-wiki-drop-indicator');
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return { ok: true, indicator };
  })()`);
}

async function main() {
  const suffix = Date.now();
  const owner = await registerUser(`wiki-e2e-owner-${suffix}@test.dev`, "周架构");
  const bob = await registerUser(`wiki-e2e-bob-${suffix}@test.dev`, "王产品");
  const ownerHeaders = { "X-Jiange-User-Id": String(owner.user.id) };
  const bobHeaders = { "X-Jiange-User-Id": String(bob.user.id) };

  // Invite & accept Bob into Owner's workspace.
  const inv = await apiReq(owner.cookie, "POST", `/api/workspaces/${owner.workspace.id}/members`, {
    email: bob.user.email, role: "member",
  }, ownerHeaders);
  if (inv.status !== 200) throw new Error(`invite bob: ${inv.status} ${inv.text}`);
  const acc = await apiReq(bob.cookie, "POST", `/api/invitations/${inv.json.invitation.id}/accept`, undefined, bobHeaders);
  if (acc.status !== 204) throw new Error(`accept invite: ${acc.status} ${acc.text}`);

  // Create 3 Wiki spaces: Space A (workspace), Space B (workspace), Space Priv (private).
  const createSpace = async (name, description, icon, visibility) => {
    const r = await apiReq(owner.cookie, "POST", `/api/workspaces/${owner.workspace.id}/wiki-spaces`, {
      name, description, icon, visibility,
    }, ownerHeaders);
    if (r.status !== 201) throw new Error(`create space ${name}: ${r.status} ${r.text}`);
    return r.json;
  };
  const spaceA = await createSpace("研发架构知识库", "核心系统设计与目录演进", "🏛️", "workspace");
  const spaceB = await createSpace("产品设计中心", "统一组件与交互规范", "🎨", "workspace");
  const spacePriv = await createSpace("高管机密战略库", "内部保密", "🔒", "private");

  const createWikiNode = async (spaceId, kind, title, parentId = null) => {
    const r = await apiReq(owner.cookie, "POST", `/api/wiki/spaces/${spaceId}/nodes`, {
      kind, title, parentId,
    }, ownerHeaders);
    if (r.status !== 201) throw new Error(`create node ${title}: ${r.status} ${r.text}`);
    return r.json;
  };
  const nodeA = await createWikiNode(spaceA.id, "doc", "A：系统总览");
  const nodeB = await createWikiNode(spaceA.id, "doc", "B：API 网关规范");
  const nodeC = await createWikiNode(spaceA.id, "doc", "C：存储与分片方案");
  const folderF = await createWikiNode(spaceA.id, "folder", "F：运维发布手册");

  const designDoc = await createWikiNode(spaceB.id, "doc", "设计语言 2.0 规范");
  const secretDoc = await createWikiNode(spacePriv.id, "doc", "2027 绝密营收规划");

  // Create shared Drive Sheet to reference via shortcut.
  const sheetRes = await apiReq(owner.cookie, "POST", "/api/drive/nodes", {
    kind: "sheet", title: "云盘季度排期表", scope: "shared",
  }, ownerHeaders);
  if (sheetRes.status !== 201) throw new Error(`create drive sheet: ${sheetRes.status} ${sheetRes.text}`);
  const driveSheet = sheetRes.json;

  // Seed one shortcut pointing to the Private Space page (to test live permission masking for Bob).
  const scPrivRes = await apiReq(owner.cookie, "POST", `/api/wiki/spaces/${spaceA.id}/shortcuts`, {
    parentId: null, targetNodeId: secretDoc.id, title: "绝密营收入口",
  }, ownerHeaders);
  if (scPrivRes.status !== 201) throw new Error(`create private shortcut: ${scPrivRes.status} ${scPrivRes.text}`);
  const scPriv = scPrivRes.json;

  const cdp = await connectCDP(await getWsUrl());
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Log.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
    });

    await setCookieOnBrowser(cdp, owner.cookie);
    await cdp.send("Page.navigate", { url: `${APP}/#/wiki/${spaceA.id}` });

    await waitFor(cdp, "initial tree rows rendered", new Function(`
      const rows = [...document.querySelectorAll('[data-wiki-tree-row]')].map((el) => Number(el.getAttribute('data-wiki-tree-row')));
      return rows.length === 4 && rows[0] === ${nodeA.id} && rows[2] === ${nodeC.id};
    `));
    await sleep(250);

    // 1. Drag C BEFORE A -> order should become [C, A, B, F].
    const d1 = await dragWikiRow(cdp, nodeC.id, nodeA.id, "before");
    if (!d1.ok) throw new Error(`drag1 failed: ${JSON.stringify(d1)}`);
    await waitFor(cdp, "order [C, A, B, F] after drag before", new Function(`
      const rows = [...document.querySelectorAll('[data-wiki-tree-row]')].map((el) => Number(el.getAttribute('data-wiki-tree-row')));
      return rows.length === 4 && rows[0] === ${nodeC.id} && rows[1] === ${nodeA.id} && rows[2] === ${nodeB.id} && rows[3] === ${folderF.id};
    `));

    // 2. Drag B INSIDE C -> B becomes indented child under C!
    const d2 = await dragWikiRow(cdp, nodeB.id, nodeC.id, "inside");
    if (!d2.ok) throw new Error(`drag2 failed: ${JSON.stringify(d2)}`);
    await waitFor(cdp, "B nested inside C", new Function(`
      const cRow = document.querySelector('[data-wiki-tree-row="${nodeC.id}"]');
      const bRow = document.querySelector('[data-wiki-tree-row="${nodeB.id}"]');
      if (!cRow || !bRow) return false;
      const cPad = parseInt(cRow.style.paddingLeft || '0', 10);
      const bPad = parseInt(bRow.style.paddingLeft || '0', 10);
      const rows = [...document.querySelectorAll('[data-wiki-tree-row]')].map((el) => Number(el.getAttribute('data-wiki-tree-row')));
      return bPad > cPad && rows[0] === ${nodeC.id} && rows[1] === ${nodeB.id};
    `));

    // 3. Add Cross-Space Shortcut via UI Dialog (Space B -> 设计语言 2.0 规范).
    await evalJS(cdp, `(() => { document.querySelector('[data-wiki-overview-add-shortcut]').click(); return true; })()`);
    await waitFor(cdp, "shortcut dialog open", () => !!document.querySelector("[data-wiki-shortcut-dialog]"));
    // Select Space B if not already selected, then pick designDoc.
    await evalJS(cdp, `(() => {
      const sel = document.querySelector('[data-wiki-shortcut-space-select]');
      if (sel) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, '${spaceB.id}');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`);
    await waitFor(cdp, "cross-space option ready", new Function(`return !!document.querySelector('[data-wiki-shortcut-option="${designDoc.id}"]')`));
    await evalJS(cdp, `(() => {
      document.querySelector('[data-wiki-shortcut-option="${designDoc.id}"]').click();
      const input = document.querySelector('[data-wiki-shortcut-title]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '跨库：设计语言规范');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(100);
    await evalJS(cdp, `(() => { document.querySelector('[data-wiki-shortcut-submit]').click(); return true; })()`);
    await waitFor(cdp, "cross-space shortcut in sidebar", () => {
      const rows = [...document.querySelectorAll("[data-wiki-shortcut-row]")];
      return rows.some((r) => r.textContent?.includes("跨库：设计语言规范") && r.textContent?.includes("产品设计中心"));
    });

    // 4. Add Drive Sheet Shortcut nested inside Folder F via UI Dialog.
    await evalJS(cdp, `(() => { document.querySelector('[data-wiki-overview-add-shortcut]').click(); return true; })()`);
    await waitFor(cdp, "shortcut dialog open 2", () => !!document.querySelector("[data-wiki-shortcut-dialog]"));
    await evalJS(cdp, `(() => { document.querySelector('[data-wiki-shortcut-tab="drive"]').click(); return true; })()`);
    await waitFor(cdp, "drive sheet option ready", new Function(`return !!document.querySelector('[data-wiki-shortcut-option="${driveSheet.id}"]')`));
    await evalJS(cdp, `(() => {
      document.querySelector('[data-wiki-shortcut-option="${driveSheet.id}"]').click();
      const sel = document.querySelector('[data-wiki-shortcut-parent]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, '${folderF.id}');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(100);
    await evalJS(cdp, `(() => { document.querySelector('[data-wiki-shortcut-submit]').click(); return true; })()`);
    // Expand Folder F to display nested Drive shortcut!
    await waitFor(cdp, "folder F expand toggle visible", new Function(`
      const row = document.querySelector('[data-wiki-tree-row="${folderF.id}"]');
      return !!row && !!row.querySelector('button[aria-expanded]');
    `));
    await evalJS(cdp, `(() => {
      const btn = document.querySelector('[data-wiki-tree-row="${folderF.id}"] button[aria-expanded]');
      if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
      return true;
    })()`);
    await waitFor(cdp, "nested drive shortcut visible under folder F", () => {
      const rows = [...document.querySelectorAll("[data-wiki-shortcut-row]")];
      return rows.some((r) => r.textContent?.includes("云盘季度排期表") && r.textContent?.includes("云盘"));
    });

    await sleep(300);
    const shot1 = await screenshot(cdp, "01-wiki-dnd-shortcuts-desktop.png");

    // 5. Click Cross-Space Shortcut -> verify smooth cross-space navigation into Space B!
    await evalJS(cdp, `(() => {
      const row = [...document.querySelectorAll('[data-wiki-shortcut-row]')].find((r) => r.textContent?.includes('跨库：设计语言规范'));
      row.querySelector('button').click();
      return true;
    })()`);
    await waitFor(cdp, "navigated to cross-space target", new Function(`
      return location.hash === '#/wiki/${spaceB.id}/node/${designDoc.id}' && document.body.innerText.includes('产品设计中心');
    `));

    // 6. Return to Space A and RELOAD against Postgres 16 -> verify persisted tree order & shortcuts!
    await cdp.send("Page.navigate", { url: `${APP}/#/wiki/${spaceA.id}` });
    await sleep(300);
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(600);
    await waitFor(cdp, "persisted order and shortcuts after reload", new Function(`
      const rows = [...document.querySelectorAll('[data-wiki-tree-row]')].map((el) => Number(el.getAttribute('data-wiki-tree-row')));
      const hasCross = [...document.querySelectorAll('[data-wiki-shortcut-row]')].some((r) => r.textContent?.includes('跨库：设计语言规范'));
      return rows[0] === ${nodeC.id} && rows[1] === ${nodeA.id} && rows[2] === ${folderF.id} && hasCross;
    `));

    // 7. Switch to Bob (workspace member, NO access to Private Space C) -> verify live shortcut permission masking!
    await setCookieOnBrowser(cdp, bob.cookie);
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(600);
    const fencingCheck = await waitFor(cdp, "bob sees reordered tree + accessible cross shortcut + masked private shortcut", new Function(`
      const rows = [...document.querySelectorAll('[data-wiki-tree-row]')].map((el) => Number(el.getAttribute('data-wiki-tree-row')));
      const hasCross = [...document.querySelectorAll('[data-wiki-shortcut-row]')].some((r) => r.textContent?.includes('跨库：设计语言规范'));
      const locked = document.querySelector('[data-wiki-shortcut-locked="${scPriv.id}"]');
      const leaked = document.body.innerText.includes('绝密营收');
      if (rows[0] !== ${nodeC.id} || !hasCross || !locked) return null;
      return { order: rows, lockedText: locked.textContent.trim(), leaked };
    `));
    if (fencingCheck.leaked) throw new Error("Private shortcut title leaked to unauthorized viewer Bob!");
    await sleep(250);
    const shot2 = await screenshot(cdp, "02-wiki-viewer-fencing-desktop.png");

    // 8. Switch back to Owner at Mobile 390x844 -> check 0px overflow & mobile tree drawer!
    await setCookieOnBrowser(cdp, owner.cookie);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(600);
    await waitFor(cdp, "mobile overview rendered", () => !!document.querySelector("[data-wiki-open-tree]") && !!document.querySelector("[data-wiki-overview]"));
    const mobileMetrics = await evalJS(cdp, `({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    await evalJS(cdp, `(() => { document.querySelector('[data-wiki-open-tree]').click(); return true; })()`);
    await waitFor(cdp, "mobile wiki sidebar drawer open", () => !!document.querySelector("[data-wiki-sidebar]"));
    await sleep(250);
    const shot3 = await screenshot(cdp, "03-wiki-tree-mobile-drawer.png");

    const summary = {
      spaceAId: spaceA.id,
      spaceBId: spaceB.id,
      spacePrivId: spacePriv.id,
      dragIndicators: { before: d1.indicator, inside: d2.indicator },
      fencingCheck,
      mobileMetrics,
      shots: [shot1, shot2, shot3],
      consoleErrors: cdp.consoleErrors,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (mobileMetrics.overflow > 0) throw new Error(`Mobile horizontal overflow: ${mobileMetrics.overflow}px`);
    if (cdp.consoleErrors.length > 0) throw new Error(`Console errors: ${JSON.stringify(cdp.consoleErrors)}`);
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
