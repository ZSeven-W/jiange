import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9242);
const OUT_DIR = process.env.OUT_DIR || "/tmp/find-replace-undo-20261120";
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
  const debug = await evalJS(cdp, `({ url: location.href, text: document.body.innerText.slice(0, 900) })`);
  throw new Error(`Timed out waiting for ${label}; debug=${JSON.stringify(debug)}`);
}

async function screenshot(cdp, filename) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const outPath = `${OUT_DIR}/${filename}`;
  writeFileSync(outPath, Buffer.from(data, "base64"));
  return outPath;
}

async function setReactInput(cdp, selector, value) {
  await evalJS(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("missing input " + ${JSON.stringify(selector)});
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      el.focus();
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`,
  );
  await sleep(120);
}

async function sendShortcut(cdp, key, { meta = false, ctrl = true, shift = false } = {}) {
  const modifiers = (meta ? 4 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const code = `Key${key.toUpperCase()}`;
  const vk = key.toUpperCase().charCodeAt(0);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: shift ? key.toUpperCase() : key.toLowerCase(),
    code,
    windowsVirtualKeyCode: vk,
    modifiers,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: shift ? key.toUpperCase() : key.toLowerCase(),
    code,
    windowsVirtualKeyCode: vk,
    modifiers,
  });
  await sleep(220);
}

async function main() {
  const mdPath = `${OUT_DIR}/seed.md`;
  writeFileSync(
    mdPath,
    [
      "# 查找替换与持久化撤销验证",
      "",
      "主指标 alpha 需要校验，大小写对比 Alpha 保持独立。",
      "",
      "$$\\frac{alpha}{2} + alpha$$",
      "",
      "| 模块 | 指标说明 |",
      "| --- | --- |",
      "| 核心引擎 | alpha 指标 |",
      "",
    ].join("\n"),
  );

  const suffix = Date.now();
  const reg = await apiReq("", "POST", "/api/auth/register", {
    email: `find-undo-${suffix}@test.dev`,
    name: "林架构",
    password: "password123",
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.text}`);
  const cookie = reg.setCookie.split(";")[0];
  const user = reg.json.user;
  const workspace = reg.json.workspaces[0];

  const created = await apiReq(
    cookie,
    "POST",
    "/api/docs",
    { title: "公式与表格查找替换验证", workspaceId: workspace.id },
    { "X-Jiange-User-Id": String(user.id) },
  );
  if (created.status !== 201) throw new Error(`create doc failed: ${created.status} ${created.text}`);
  const docId = created.json.id;
  console.log(`Created live doc #${docId}`);

  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

    const [cookieName, ...cookieRest] = cookie.split("=");
    const cookieVal = cookieRest.join("=");
    await cdp.send("Network.setCookie", { name: cookieName, value: cookieVal, url: APP, path: "/" });
    await cdp.send("Network.setCookie", { name: cookieName, value: cookieVal, url: API, path: "/" });

    await cdp.send("Page.navigate", { url: `${APP}/#/doc/${docId}` });
    await waitFor(cdp, "doc synced", () => !!document.querySelector('[data-status="synced"]') && !!document.querySelector("[data-more-menu]"));

    // 1. Import markdown seed (heading, paragraph with alpha/Alpha, math block, 2x2 table)
    await evalJS(cdp, `document.querySelector("[data-more-menu]").click()`);
    await waitFor(cdp, "import md input", () => !!document.querySelector('[data-import-md] input[type="file"]'));
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-import-md] input[type="file"]' });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [mdPath] });

    await waitFor(
      cdp,
      "imported seed rendered",
      () =>
        document.body.innerText.includes("主指标 alpha") &&
        !!document.querySelector("[data-math]") &&
        document.querySelectorAll("table tr").length === 2,
      15000,
    );
    await waitFor(cdp, "synced after md import", () => !!document.querySelector('[data-status="synced"]'));

    // Also type an inline formula $$alpha+1$$ into the first editable paragraph so BOTH inline + block math are tested!
    await evalJS(cdp, `(() => {
      const blocks = [...document.querySelectorAll('[data-editor] [data-block]')];
      const para = blocks.find((el) => el.innerText.includes("主指标 alpha"));
      if (!para) throw new Error("para not found");
      const textHost = para.querySelector("[data-text]") || para;
      const range = document.createRange();
      range.selectNodeContents(textHost);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.querySelector("[data-editor]").focus();
    })()`);
    await cdp.send("Input.insertText", { text: " 行内 $$alpha + 1$$" });
    await waitFor(
      cdp,
      "inline math rendered",
      () => !!document.querySelector('[data-inline-math][title="$alpha + 1$"]'),
      10000,
    );
    await waitFor(cdp, "synced after inline math", () => !!document.querySelector('[data-status="synced"]'));
    console.log("Inline formula $$alpha + 1$$ + block formula + table seeded live.");

    // 2. Open Find & Replace and verify default vs caseSensitive vs includeMath
    await evalJS(cdp, `document.querySelector("[data-more-menu]").click()`);
    await waitFor(cdp, "find-replace menu item", () => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("查找和替换")));
    await evalJS(cdp, `[...document.querySelectorAll("button")].find((b) => b.textContent?.includes("查找和替换")).click()`);
    await waitFor(cdp, "find panel visible", () => !!document.querySelector("[data-find-replace-panel]"));

    await setReactInput(cdp, '[data-find-replace-panel] input[placeholder="在文档内查找"]', "alpha");
    await waitFor(
      cdp,
      "default match count = 3 (body alpha, Alpha, table alpha; formulas excluded)",
      () => document.querySelector("[data-find-replace-panel]")?.innerText.includes("1 / 3"),
      10000,
    );

    // Toggle Aa (caseSensitive) -> drops from 3 to 2 (excludes Alpha)
    await evalJS(cdp, `document.querySelector("[data-find-case-sensitive]").click()`);
    await waitFor(
      cdp,
      "case-sensitive match count = 2",
      () => document.querySelector("[data-find-replace-panel]")?.innerText.includes("1 / 2"),
      10000,
    );

    // Toggle Σ 包含公式 -> jumps from 2 to 5 (body alpha + inline alpha + 2 block math alphas + table alpha)
    await evalJS(cdp, `document.querySelector("[data-find-include-math]").click()`);
    await waitFor(
      cdp,
      "include-math match count = 5",
      () => document.querySelector("[data-find-replace-panel]")?.innerText.includes("1 / 5"),
      10000,
    );

    // Click 下一处 twice to highlight the block formula and inspect [data-math-find-source]
    await evalJS(cdp, `[...document.querySelectorAll("[data-find-replace-panel] button")].find((b) => b.textContent?.trim() === "下一处").click()`);
    await sleep(150);
    await evalJS(cdp, `[...document.querySelectorAll("[data-find-replace-panel] button")].find((b) => b.textContent?.trim() === "下一处").click()`);
    await waitFor(
      cdp,
      "math block active highlight + LaTeX source bar",
      () =>
        !!document.querySelector('[data-math][data-find-active="true"]') &&
        !!document.querySelector("[data-math-find-source] mark"),
      10000,
    );
    await screenshot(cdp, "01-find-math-highlight-desktop.png");
    console.log("Formula highlight & case-sensitive toggles verified!");

    // 3. Perform a real structural table edit (append a new row -> 3 rows) + type "alpha 新行" into row 2 col 1
    await evalJS(cdp, `document.querySelector("[data-table-add-row]").click()`);
    await waitFor(cdp, "table has 3 rows after structural append", () => document.querySelectorAll("table tr").length === 3, 10000);
    await waitFor(cdp, "synced after add row", () => !!document.querySelector('[data-status="synced"]'));

    // Edit newly added cell (row 2, col 1)
    await evalJS(cdp, `(() => {
      const cell = document.querySelector('[data-table-cell="2:1"]');
      if (!cell) throw new Error("cell 2:1 missing");
      cell.focus();
    })()`);
    await cdp.send("Input.insertText", { text: "alpha 新行" });
    await waitFor(
      cdp,
      "cell 2:1 has alpha 新行",
      () => document.querySelector('[data-table-cell="2:1"]')?.value === "alpha 新行",
      10000,
    );
    await waitFor(cdp, "synced after cell edit", () => !!document.querySelector('[data-status="synced"]'));

    // Wait for find count to refresh to 6 matches (body + inline math + 2 block math + 2 table cells)
    await waitFor(
      cdp,
      "match count updated to 6 with new table row",
      () => document.querySelector("[data-find-replace-panel]")?.innerText.includes("/ 6"),
      10000,
    );

    // Replace All: alpha -> omega (with caseSensitive=true, includeMath=true)
    await setReactInput(cdp, '[data-find-replace-panel] input[placeholder="请输入文字"]', "omega");
    await evalJS(cdp, `[...document.querySelectorAll("[data-find-replace-panel] button")].find((b) => b.textContent?.trim() === "全部替换").click()`);
    await waitFor(
      cdp,
      "all 6 matches replaced across body, inline math, block math, and table",
      () =>
        document.body.innerText.includes("主指标 omega") &&
        document.body.innerText.includes("大小写对比 Alpha") &&
        !!document.querySelector('[data-inline-math][title="$omega + 1$"]') &&
        document.querySelector('[data-table-cell="1:1"]')?.value === "omega 指标" &&
        document.querySelector('[data-table-cell="2:1"]')?.value === "omega 新行",
      15000,
    );
    await waitFor(cdp, "synced after Replace All", () => !!document.querySelector('[data-status="synced"]'));
    await sleep(300); // allow debounced sessionStorage persist
    await screenshot(cdp, "02-replaced-all-desktop.png");

    // Verify sessionStorage persisted local undo snapshot before reload
    const storedBeforeReload = await evalJS(cdp, `Object.keys(sessionStorage).filter((k) => k.startsWith("jiange:undo-history:v1:"))`);
    console.log("Persisted undo keys before reload:", JSON.stringify(storedBeforeReload));
    if (!storedBeforeReload.length) throw new Error("Expected sessionStorage undo history key before reload");

    // 4. REAL HARD PAGE RELOAD + Undo Replace All -> Undo cell edit -> Undo structural row insert!
    await evalJS(cdp, `window.__beforeReload = 1`);
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(
      cdp,
      "reloaded page synced with restored undo stack",
      () =>
        !window.__beforeReload &&
        !!document.querySelector('[data-status="synced"]') &&
        document.querySelector("[data-editor]")?.getAttribute("data-undo-ready") === "true" &&
        document.body.innerText.includes("主指标 omega") &&
        document.querySelectorAll("table tr").length === 3,
      20000,
    );
    console.log("Reload complete — local undo stack automatically restored!");

    // Focus editor & press Ctrl+Z #1 -> undo Replace All (reverts body + inline math + block math + table cells!)
    await evalJS(cdp, `document.querySelector("[data-editor]").focus()`);
    await sendShortcut(cdp, "z", { ctrl: true });
    await waitFor(
      cdp,
      "post-reload Undo #1 reverted Replace All across body, formulas, and table",
      () =>
        document.body.innerText.includes("主指标 alpha") &&
        !!document.querySelector('[data-inline-math][title="$alpha + 1$"]') &&
        document.querySelector('[data-table-cell="1:1"]')?.value === "alpha 指标" &&
        document.querySelector('[data-table-cell="2:1"]')?.value === "alpha 新行",
      15000,
    );
    await waitFor(cdp, "synced after post-reload undo #1", () => !!document.querySelector('[data-status="synced"]'));

    // Press Ctrl+Z #2 -> undo cell 2:1 typing
    await evalJS(cdp, `document.querySelector("[data-editor]").focus()`);
    await sendShortcut(cdp, "z", { ctrl: true });
    await waitFor(
      cdp,
      "post-reload Undo #2 reverted cell 2:1 typing",
      () => document.querySelector('[data-table-cell="2:1"]')?.value === "",
      15000,
    );
    await waitFor(cdp, "synced after post-reload undo #2", () => !!document.querySelector('[data-status="synced"]'));

    // Press Ctrl+Z #3 -> undo structural row append (3 rows -> 2 rows, ZERO conflict!)
    await evalJS(cdp, `document.querySelector("[data-editor]").focus()`);
    await sendShortcut(cdp, "z", { ctrl: true });
    await waitFor(
      cdp,
      "post-reload Undo #3 reverted structural table row insertion (3 -> 2 rows)",
      () => document.querySelectorAll("table tr").length === 2,
      15000,
    );
    await waitFor(cdp, "synced after post-reload undo #3", () => !!document.querySelector('[data-status="synced"]'));
    await screenshot(cdp, "03-undo-after-reload-desktop.png");
    console.log("Post-reload 3-step Undo (Replace All -> cell edit -> structural row insert) succeeded with 0 conflicts!");

    // Verify 3-step Redo (Ctrl+Shift+Z x 3) restores structure -> cell -> Replace All!
    await evalJS(cdp, `document.querySelector("[data-editor]").focus()`);
    await sendShortcut(cdp, "z", { ctrl: true, shift: true });
    await waitFor(cdp, "Redo #1 restored 3rd row", () => document.querySelectorAll("table tr").length === 3, 15000);
    await waitFor(cdp, "synced after redo #1", () => !!document.querySelector('[data-status="synced"]'));

    await evalJS(cdp, `document.querySelector("[data-editor]").focus()`);
    await sendShortcut(cdp, "z", { ctrl: true, shift: true });
    await waitFor(cdp, "Redo #2 restored cell 2:1 text", () => document.querySelector('[data-table-cell="2:1"]')?.value === "alpha 新行", 15000);
    await waitFor(cdp, "synced after redo #2", () => !!document.querySelector('[data-status="synced"]'));

    await evalJS(cdp, `document.querySelector("[data-editor]").focus()`);
    await sendShortcut(cdp, "z", { ctrl: true, shift: true });
    await waitFor(
      cdp,
      "Redo #3 restored mixed Replace All (omega across body, formulas, and table)",
      () =>
        document.body.innerText.includes("主指标 omega") &&
        !!document.querySelector('[data-inline-math][title="$omega + 1$"]') &&
        document.querySelector('[data-table-cell="2:1"]')?.value === "omega 新行",
      15000,
    );
    console.log("Post-reload 3-step Redo succeeded cleanly!");

    // 5. Mobile 390x844 responsive check with Find/Replace panel open
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await evalJS(cdp, `document.querySelector("[data-more-menu]").click()`);
    await waitFor(cdp, "mobile find button", () => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("查找和替换")));
    await evalJS(cdp, `[...document.querySelectorAll("button")].find((b) => b.textContent?.includes("查找和替换")).click()`);
    await waitFor(cdp, "mobile find panel", () => !!document.querySelector("[data-find-replace-panel]"));
    await setReactInput(cdp, '[data-find-replace-panel] input[placeholder="在文档内查找"]', "omega");
    await evalJS(cdp, `document.querySelector("[data-find-include-math]").click()`);
    await waitFor(cdp, "mobile matches computed", () => document.querySelector("[data-find-replace-panel]")?.innerText.includes("/ 6"), 10000);
    await sleep(200);
    const mobileOverflow = await evalJS(cdp, `document.documentElement.scrollWidth - window.innerWidth`);
    console.log("Mobile find panel overflow px:", mobileOverflow);
    if (mobileOverflow > 1) throw new Error(`Mobile overflow: ${mobileOverflow}px`);
    await screenshot(cdp, "04-find-panel-mobile.png");

    if (cdp.consoleErrors.length) {
      throw new Error(`Console errors recorded: ${cdp.consoleErrors.join(" | ")}`);
    }
    console.log("ALL FIND-REPLACE FORMULA + TABLE STRUCTURE + RELOAD UNDO E2E CHECKS PASSED WITH 0 CONSOLE ERRORS!");
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
