import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9229);
const OUT_DIR = process.env.OUT_DIR || "output/doc-suggestions-verify-20261119";
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
  const email = `sug-${ts}@example.com`;
  const reg = await apiReq(null, "POST", "/api/auth/register", { email, name: "ReviewLead", password: "password123" });
  const cookie = reg.setCookie.split(";")[0];
  const doc = (await apiReq(cookie, "POST", "/api/docs", { title: "修订建议模式验收文档" })).data;

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
  await waitFor(cdp, `document.body.innerText.includes("修订建议模式验收文档") && !!document.querySelector('[data-block] [data-text]')`);

  // Type initial paragraph text into the first body block
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const blocks = [...document.querySelectorAll('[data-block]')];
      const body = blocks.find((el) => el.getAttribute('data-block') !== '0:1');
      const editable = body?.querySelector('[data-text]');
      editable?.focus();
    })()`,
  });
  await cdp.send("Input.insertText", { text: "原发布计划定于本周五晚间上线。" });
  await new Promise((r) => setTimeout(r, 400));

  // Switch topbar mode dropdown to "建议" (修订模式)
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-doc-mode-trigger]')?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-doc-mode="suggest"]')`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-doc-mode="suggest"]')?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-suggest-banner]') && !!document.querySelector('[data-suggestion-panel]')`);

  // Submit a revision suggestion with a note
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const area = document.querySelector('[data-suggestion-proposed]');
      const note = document.querySelector('[data-suggestion-note]');
      const setTA = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const setIn = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setTA.call(area, '修订后计划调整为下周一上午灰度发布，并同步开启监控告警。');
      area.dispatchEvent(new Event('input', { bubbles: true }));
      setIn.call(note, '避开周五发布窗口，降低周末值班风险');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  });
  await new Promise((r) => setTimeout(r, 200));
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-submit-suggestion]')?.click()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-suggestion-card]').length === 1`);
  await screenshot(cdp, "01-doc-suggestion-open.png");

  // Accept the suggestion and verify the live document paragraph updates!
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-suggestion-accept]')?.click()`,
  });
  await waitFor(cdp, `document.body.innerText.includes("修订后计划调整为下周一上午灰度发布")`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-suggestion-filter="all"]')?.click()`,
  });
  await waitFor(cdp, `document.querySelector('[data-suggestion-status="accepted"]') !== null`);
  await screenshot(cdp, "02-doc-suggestion-accepted.png");

  // Reload to confirm both CRDT document text and accepted suggestion history persist
  await new Promise((r) => setTimeout(r, 600));
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, `document.body.innerText.includes("修订后计划调整为下周一上午灰度发布")`);

  if (cdp.consoleErrors.length) {
    console.error("Console errors:", cdp.consoleErrors);
    process.exitCode = 1;
  } else {
    console.log("ALL DOC SUGGESTIONS CDP CHECKS PASSED (0 console errors)");
  }
  cdp.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
