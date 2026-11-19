import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9230);
const OUT_DIR = process.env.OUT_DIR || "output/synced-subpages-verify-20261119";
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
  const email = `syncsub-${ts}@example.com`;
  const reg = await apiReq(null, "POST", "/api/auth/register", { email, name: "SyncLead", password: "password123" });
  const cookie = reg.setCookie.split(";")[0];

  // Create Doc A (source), Child Doc A1, and Doc B (target for cross-doc synced block)
  const docA = (await apiReq(cookie, "POST", "/api/docs", { title: "项目主文档 A" })).data;
  await apiReq(cookie, "POST", "/api/docs", { title: "需求规格子页 A1", parentId: docA.id });
  const docB = (await apiReq(cookie, "POST", "/api/docs", { title: "关联文档 B" })).data;

  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Page.bringToFront");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const [cname, cval] = cookie.split("=");
  await cdp.send("Network.setCookie", { name: cname, value: cval, url: APP, path: "/" });
  await cdp.send("Page.navigate", { url: `${APP}/#/doc/${docA.id}` });
  await waitFor(cdp, `document.body.innerText.includes("项目主文档 A") && !!document.querySelector('[data-block] [data-text]')`);

  // 1. Insert "同步块" via "+" menu on Doc A
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const blocks = [...document.querySelectorAll('[data-block]')];
      const body = blocks.find((el) => el.getAttribute('data-block') !== '0:1');
      body?.querySelector('[data-block-controls] button')?.click();
    })()`,
  });
  await waitFor(cdp, `[...document.querySelectorAll('[data-slash-menu] button')].some((b) => b.innerText.includes('同步块'))`);
  await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('[data-slash-menu] button')].find((b) => b.innerText.includes('同步块'))?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-create-synced-block]')`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-create-synced-block]')?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-synced-textarea]')`);

  const syncId = (await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-synced-block]')?.getAttribute('data-synced-block')`,
    returnByValue: true,
  })).result.value;

  // Type content in Synced Block on Doc A and blur to flush save
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-synced-textarea]');
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, '【全员同步】Q4 里程碑统一锁定为 11 月 25 日。');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
    })()`,
  });
  await waitFor(cdp, `document.body.innerText.includes('已跨文档同步')`);

  // 2. Insert "子页面列表" on Doc A and verify child doc A1 is listed!
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const blocks = [...document.querySelectorAll('[data-block]')];
      const last = blocks[blocks.length - 1];
      last?.querySelector('[data-block-controls] button')?.click();
    })()`,
  });
  await waitFor(cdp, `[...document.querySelectorAll('[data-slash-menu] button')].some((b) => b.innerText.includes('子页面列表'))`);
  await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('[data-slash-menu] button')].find((b) => b.innerText.includes('子页面列表'))?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-subpages-block]') && document.body.innerText.includes('需求规格子页 A1')`);
  await screenshot(cdp, "01-doc-a-synced-and-subpages.png");

  // 3. Navigate to Doc B, insert a Synced Block, link the SAME syncId, and verify live content!
  await cdp.send("Page.navigate", { url: `${APP}/#/doc/${docB.id}` });
  await waitFor(cdp, `document.body.innerText.includes("关联文档 B") && !!document.querySelector('[data-block] [data-text]')`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const blocks = [...document.querySelectorAll('[data-block]')];
      const body = blocks.find((el) => el.getAttribute('data-block') !== '0:1');
      body?.querySelector('[data-block-controls] button')?.click();
    })()`,
  });
  await waitFor(cdp, `[...document.querySelectorAll('[data-slash-menu] button')].some((b) => b.innerText.includes('同步块'))`);
  await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('[data-slash-menu] button')].find((b) => b.innerText.includes('同步块'))?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-link-synced-input]')`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('[data-link-synced-input]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(syncId)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
  await new Promise((r) => setTimeout(r, 150));
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-link-synced-submit]')?.click()`,
  });
  await waitFor(cdp, `document.querySelector('[data-synced-textarea]')?.value?.includes('Q4 里程碑统一锁定为 11 月 25 日')`);
  await screenshot(cdp, "02-doc-b-linked-synced-block.png");

  if (cdp.consoleErrors.length) {
    console.error("Console errors:", cdp.consoleErrors);
    process.exitCode = 1;
  } else {
    console.log("ALL SYNCED BLOCK & SUBPAGES CDP CHECKS PASSED (0 console errors)");
  }
  cdp.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
