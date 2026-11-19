import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9228);
const OUT_DIR = process.env.OUT_DIR || "output/doc-table-rich-verify-20261119";
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

async function setCellValue(cdp, pos, value) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-table-cell="${pos}"]');
      if (!el) throw new Error('missing cell ${pos}');
      el.focus();
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
  await new Promise((r) => setTimeout(r, 150));
}

async function main() {
  const ts = Date.now();
  const email = `tblrich-${ts}@example.com`;
  const reg = await apiReq(null, "POST", "/api/auth/register", { email, name: "TblRich", password: "password123" });
  const cookie = reg.setCookie.split(";")[0];
  const doc = (await apiReq(cookie, "POST", "/api/docs", { title: "文档表格富文本与 CRDT 验证" })).data;

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
  await cdp.send("Page.navigate", { url: `${APP}/#/doc/${doc.id}` });
  await waitFor(cdp, `document.body.innerText.includes("文档表格富文本与 CRDT 验证") && !!document.querySelector('[data-block] [data-text]')`);

  // Insert table via "+" block menu
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const blocks = [...document.querySelectorAll('[data-block]')];
      const body = blocks.find((el) => el.getAttribute('data-block') !== '0:1');
      body?.querySelector('[data-block-controls] button')?.click();
    })()`,
  });
  await waitFor(cdp, `[...document.querySelectorAll('[data-slash-menu] button')].some((b) => b.innerText.includes('表格'))`);
  await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('[data-slash-menu] button')].find((b) => b.innerText.includes('表格'))?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-table-size-cell="3:3"]') || !!document.querySelector('[data-table-cell="1:0"]')`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-table-size-cell="3:3"]')?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-table-cell="1:0"]')`);

  // Populate cells and apply rich marks
  await setCellValue(cdp, "1:0", "核心指标");
  await new Promise((r) => setTimeout(r, 200));
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-table-rich-mark="bold"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 200));
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-table-rich-mark="color"]')?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-table-text-color="#D83931"]')`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-table-text-color="#D83931"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 200));

  // Sub-range inline code on "P99" in (1:1)
  await setCellValue(cdp, "1:1", "支持 P99 监控");
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-table-cell="1:1"]');
      el?.focus();
      el?.setSelectionRange(3, 6);
      document.querySelector('[data-table-rich-mark="code"]')?.click();
    })()`,
  });
  await new Promise((r) => setTimeout(r, 200));

  // Italic + strike on (1:2)
  await setCellValue(cdp, "1:2", "旧方案已归档");
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('[data-table-cell="1:2"]')?.focus();
      document.querySelector('[data-table-rich-mark="italic"]')?.click();
      document.querySelector('[data-table-rich-mark="strike"]')?.click();
    })()`,
  });
  await new Promise((r) => setTimeout(r, 300));

  // Blur to reveal rich overlays across all cells
  await cdp.send("Runtime.evaluate", { expression: `document.activeElement?.blur?.()` });
  await waitFor(cdp, `document.querySelectorAll('[data-table-rich-overlay]').length === 3`);
  await screenshot(cdp, "01-doc-table-rich-editor.png");

  // Reload to verify persistence
  await new Promise((r) => setTimeout(r, 800));
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, `document.querySelectorAll('[data-table-rich-overlay]').length === 3`);
  await screenshot(cdp, "02-doc-table-rich-reloaded.png");

  // Share publicly and verify ReadOnlyTable rendering
  const share = (await apiReq(cookie, "PUT", `/api/docs/${doc.id}/link`, { role: "anon" })).data;
  const token = share.token;
  await cdp.send("Page.navigate", { url: `${APP}/#/p/${token}` });
  await waitFor(cdp, `document.querySelectorAll('[data-table-block] strong').length >= 1 && document.querySelectorAll('[data-table-block] code').length >= 1 && document.querySelectorAll('[data-table-block] s').length >= 1`);
  await screenshot(cdp, "03-doc-table-rich-readonly.png");

  if (cdp.consoleErrors.length) {
    console.error("Console errors:", cdp.consoleErrors);
    process.exitCode = 1;
  } else {
    console.log("ALL TABLE RICH TEXT CDP CHECKS PASSED (0 console errors)");
  }
  cdp.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
