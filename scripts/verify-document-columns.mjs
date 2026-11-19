import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9227);
const OUT_DIR = process.env.OUT_DIR || "output/doc-columns-verify-20261119";
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
  const email = `cols-${ts}@example.com`;
  const reg = await apiReq(null, "POST", "/api/auth/register", { email, name: "ColsUser", password: "password123" });
  const cookie = reg.setCookie.split(";")[0];
  const doc = (await apiReq(cookie, "POST", "/api/docs", { title: "多块分栏与取消分栏验证" })).data;

  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const [cname, cval] = cookie.split("=");
  await cdp.send("Network.setCookie", { name: cname, value: cval, url: APP, path: "/" });
  await cdp.send("Page.navigate", { url: `${APP}/#/doc/${doc.id}` });
  await waitFor(cdp, `document.body.innerText.includes("多块分栏与取消分栏验证") && !!document.querySelector('[data-block] [data-text]')`);

  // Click the "+" insert button on the first body block to open the slash menu, then pick "分栏" -> "2 栏".
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const blocks = [...document.querySelectorAll('[data-block]')];
      const body = blocks.find((el) => el.getAttribute('data-block') !== '0:1');
      const plus = body?.querySelector('[data-block-controls] button');
      plus?.click();
    })()`,
  });
  await waitFor(cdp, `[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === '分栏')`);
  await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '分栏')?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-column-count="2"]') || document.querySelectorAll('[data-column]').length === 2`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-column-count="2"]')?.click()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-column]').length === 2`);

  // Type into Column 1 and Column 2.
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('[data-column] [data-text]')[0]?.focus()`,
  });
  await cdp.send("Input.insertText", { text: "第一栏主段落内容" });
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('[data-column] [data-text]')[1]?.focus()`,
  });
  await cdp.send("Input.insertText", { text: "第二栏主段落内容" });
  await new Promise((r) => setTimeout(r, 300));

  // Add a nested H2 and a nested Todo inside Column 1 using "+ 添加块".
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('[data-add-column-block]')[0]?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-add-column-block-type="h2"]')`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-add-column-block-type="h2"]')?.click()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-column-child-type="h2"]').length === 1`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const ed = document.querySelector('[data-column-child-type="h2"] [data-column-child-editor]');
      if (ed) { ed.focus(); ed.innerText = "栏内二级标题"; ed.blur(); }
    })()`,
  });

  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelectorAll('[data-add-column-block]')[0]?.click()`,
  });
  await waitFor(cdp, `!!document.querySelector('[data-add-column-block-type="todo"]')`);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-add-column-block-type="todo"]')?.click()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-column-child-type="todo"]').length === 1`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const ed = document.querySelector('[data-column-child-type="todo"] [data-column-child-editor]');
      if (ed) { ed.focus(); ed.innerText = "完成多块分栏与服务端 10 栏上限"; ed.blur(); }
      document.querySelector('[data-column-child-type="todo"] input[type="checkbox"]')?.click();
    })()`,
  });

  // Add a 3rd column via "+ 添加一栏" (conditional commit).
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-add-column]')?.click()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-column]').length === 3`);
  await new Promise((r) => setTimeout(r, 400));
  await screenshot(cdp, "01-multiblock-columns-desktop.png");

  // Click "取消分栏" (ungroup) and verify columns AND nested blocks dissolve cleanly into root blocks.
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-column-ungroup]')?.click()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-columns]').length === 0 && document.body.innerText.includes("第一栏主段落内容") && document.body.innerText.includes("栏内二级标题") && document.body.innerText.includes("完成多块分栏与服务端 10 栏上限") && document.body.innerText.includes("第二栏主段落内容")`);
  await new Promise((r) => setTimeout(r, 400));
  await screenshot(cdp, "02-after-ungroup-desktop.png");

  if (cdp.consoleErrors.length > 0) {
    console.warn("Console errors:", cdp.consoleErrors);
  } else {
    console.log("Zero console errors.");
  }
  cdp.close();
  console.log("CDP document columns verification PASSED!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
