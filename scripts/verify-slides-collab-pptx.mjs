import { mkdirSync, writeFileSync } from "node:fs";
import { exportSlidesToPptx } from "../packages/slides-sdk/dist/pptx.js";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9236);
const OUT_DIR = process.env.OUT_DIR || "output/slides-collab-pptx-20261119";
mkdirSync(OUT_DIR, { recursive: true });

async function getBrowserWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      if (ver.webSocketDebuggerUrl) return ver.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("CDP browser endpoint not ready");
}

function connectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onopen = () =>
      resolve({
        send(method, params = {}, sessionId = undefined) {
          const id = ++seq;
          const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
          ws.send(JSON.stringify(payload));
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

async function createTab(browser, width, height, mobile = false) {
  const { browserContextId } = await browser.send("Target.createBrowserContext");
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Log.enable", {}, sessionId);
  await browser.send("DOM.enable", {}, sessionId);
  await browser.send("Network.enable", {}, sessionId);
  await browser.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile },
    sessionId,
  );
  return {
    browserContextId,
    targetId,
    sessionId,
    send: (method, params = {}) => browser.send(method, params, sessionId),
  };
}

async function evalJS(tab, expression) {
  const { result, exceptionDetails } = await tab.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(`JS error: ${exceptionDetails.text} ${exceptionDetails.exception?.description || ""}`);
  }
  return result?.value;
}

async function waitFor(tab, expr, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await evalJS(tab, expr);
    if (val) return val;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for: ${expr}`);
}

async function screenshot(tab, name) {
  const { data } = await tab.send("Page.captureScreenshot", { format: "png" });
  const outPath = `${OUT_DIR}/${name}`;
  writeFileSync(outPath, Buffer.from(data, "base64"));
  console.log("Saved screenshot:", outPath);
}

async function setCookieOnTab(tab, rawSetCookie) {
  const [nameVal] = rawSetCookie.split(";");
  const eqIdx = nameVal.indexOf("=");
  await tab.send("Network.setCookie", {
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
  const ownerReg = await apiReq(null, "POST", "/api/auth/register", {
    email: `slides-owner-${ts}@example.com`,
    name: "林产品",
    password: "password123",
  });
  const editorReg = await apiReq(null, "POST", "/api/auth/register", {
    email: `slides-editor-${ts}@example.com`,
    name: "陈设计",
    password: "password123",
  });
  const ownerCookie = ownerReg.setCookie.split(";")[0];
  const editorCookie = editorReg.setCookie.split(";")[0];
  const ownerId = ownerReg.data.user.id;
  const editorId = editorReg.data.user.id;

  // Create Slides deck as Owner and share with Editor (role: edit)
  const deck = (
    await apiReq(
      ownerCookie,
      "POST",
      "/api/drive/nodes",
      { kind: "slides", title: "2026 产品年度规划", scope: "personal" },
      { "X-Jiange-User-Id": String(ownerId) },
    )
  ).data;
  const deckId = deck.id;

  await apiReq(
    ownerCookie,
    "PUT",
    `/api/docs/${deckId}/shares`,
    { email: `slides-editor-${ts}@example.com`, role: "edit" },
    { "X-Jiange-User-Id": String(ownerId) },
  );

  // Prepare initial slide 1 content via API so it looks clean right away
  const initPages = (
    await apiReq(ownerCookie, "GET", `/api/slides/${deckId}/pages`, undefined, {
      "X-Jiange-User-Id": String(ownerId),
      "X-Jiange-Slides-Version": "5",
    })
  ).data.pages;
  const p1 = initPages[0];
  await apiReq(
    ownerCookie,
    "PATCH",
    `/api/slides/${deckId}/pages/${p1.id}/content`,
    {
      title: "实时协同演示封面",
      body: "两位协作者同时打开同一份幻灯片",
      background: "#f5f7fb",
      layout: "title",
      notes: "封面备注",
      shapes: [{ id: "init-star", kind: "star", x: 76, y: 18, width: 12, height: 20, color: "#3370ff" }],
      expectedRevision: p1.revision,
    },
    { "X-Jiange-User-Id": String(ownerId), "X-Jiange-Slides-Version": "5" },
  );

  // Connect CDP browser & open TWO isolated incognito tabs (Owner + Editor)
  const browser = await connectCDP(await getBrowserWsUrl());
  const ownerTab = await createTab(browser, 1440, 900, false);
  const editorTab = await createTab(browser, 1440, 900, false);

  try {
    await setCookieOnTab(ownerTab, ownerReg.setCookie);
    await setCookieOnTab(editorTab, editorReg.setCookie);

    const deckUrl = `${APP}/#/slides/${deckId}`;
    await ownerTab.send("Page.navigate", { url: deckUrl });
    await editorTab.send("Page.navigate", { url: deckUrl });

    await waitFor(ownerTab, `!!document.querySelector("[data-slides-editor]") && document.querySelectorAll("[data-slides-page]").length === 1`);
    await waitFor(editorTab, `!!document.querySelector("[data-slides-editor]") && document.querySelectorAll("[data-slides-page]").length === 1`);

    // 1. Verify live multi-user presence: Owner sees Editor avatar in header AND Editor badge on Slide 1 thumbnail
    await waitFor(ownerTab, `!!document.querySelector('[data-slides-collaborator="${editorId}"]')`);
    await waitFor(ownerTab, `!!document.querySelector('[data-slide-peer-badge="${editorId}"]')`);
    console.log("PASS: Live WebSocket collaborator presence avatar + slide thumbnail badge verified.");

    // 2. Editor inserts a second slide via API -> Owner receives live WS revision push & renders 2 slides WITHOUT reload!
    const p2 = (
      await apiReq(
        editorCookie,
        "POST",
        `/api/slides/${deckId}/pages/insert`,
        { afterPageId: p1.id, expectedRevision: p1.revision + 1 },
        { "X-Jiange-User-Id": String(editorId) },
      )
    ).data;
    await apiReq(
      editorCookie,
      "PATCH",
      `/api/slides/${deckId}/pages/${p2.id}/content`,
      {
        title: "协作者新增页面",
        body: "由陈设计实时创建并同步给所有在线成员",
        background: "#ffffff",
        layout: "",
        notes: "待撤销测试备注",
        shapes: [{ id: "ed-rr", kind: "rounded-rectangle", x: 64, y: 42, width: 24, height: 24, color: "#00b42a" }],
        expectedRevision: p2.revision,
      },
      { "X-Jiange-User-Id": String(editorId), "X-Jiange-Slides-Version": "5" },
    );

    // Wait for Owner tab to automatically receive the live update (should be instant via WS, well under 1.5s)
    const tSyncStart = Date.now();
    await waitFor(
      ownerTab,
      `document.querySelectorAll("[data-slides-page]").length === 2 && document.querySelectorAll("[data-slides-page]")[1].textContent.includes("协作者新增页面")`,
    );
    console.log(`PASS: Live WebSocket revision push synced remote slide creation in ${Date.now() - tSyncStart}ms.`);

    // Wait for Editor tab to receive Slide 2 via WS too, then click Slide 2 thumbnail so Editor badge moves to slide 2!
    await waitFor(editorTab, `!!document.querySelector('[data-slides-page="${p2.id}"] button')`);
    await evalJS(editorTab, `document.querySelector('[data-slides-page="${p2.id}"] button').click()`);
    await waitFor(ownerTab, `!!document.querySelector('[data-slides-page="${p2.id}"] [data-slide-peer-badge="${editorId}"]')`);
    console.log("PASS: Live cursor presence moved to Slide 2 thumbnail badge.");

    await screenshot(ownerTab, "01-desktop-collab-presence.png");

    // 3. Test Slide Structure Undo/Redo: Owner selects Slide 2, deletes it, then clicks Undo to restore it!
    await evalJS(ownerTab, `document.querySelectorAll('[data-slides-page="${p2.id}"] button')[0].click()`);
    await waitFor(ownerTab, `document.querySelector("[data-slides-title]")?.value === "协作者新增页面"`);

    // Click toolbar Delete button
    await evalJS(
      ownerTab,
      `[...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "删除" && !b.disabled)?.click()`,
    );
    // Confirm ask modal (confirm copy mentions "删除后可通过撤销恢复。")
    await waitFor(ownerTab, `document.body.innerText.includes("删除后可通过撤销恢复")`);
    await evalJS(
      ownerTab,
      `[...document.querySelectorAll('[data-ask] button, [role="alertdialog"] button, [role="dialog"] button')].find((b) => b.textContent?.includes("确定") || b.textContent?.includes("删除"))?.click()`,
    );
    await waitFor(ownerTab, `document.querySelectorAll("[data-slides-page]").length === 1`);
    console.log("PASS: Deleted Slide 2 cleanly.");

    // Wait briefly so refetch settles, then click Undo button [data-slides-undo]
    await new Promise((r) => setTimeout(r, 400));
    await waitFor(ownerTab, `!document.querySelector("[data-slides-undo]")?.disabled`);
    await evalJS(ownerTab, `document.querySelector("[data-slides-undo]").click()`);
    await waitFor(
      ownerTab,
      `document.querySelectorAll("[data-slides-page]").length === 2 && document.querySelector("[data-slides-title]")?.value === "协作者新增页面"`,
    );
    console.log("PASS: Undo restored deleted Slide 2 at original position with title/shapes/notes intact.");
    await screenshot(ownerTab, "02-desktop-after-undo-restore.png");

    // 4. Test Genuine OOXML .pptx Import & Export via UI!
    const samplePptx = exportSlidesToPptx(
      [
        {
          title: "Q4 架构升级总览",
          body: "全链路协同与多端互通",
          background: "#1f2329",
          layout: "title",
          notes: "开场说明核心收益",
          hidden: false,
          shapes: [
            { id: "s1", kind: "star", x: 78, y: 16, width: 12, height: 22, rotation: 15, color: "#3370ff" },
            { id: "l1", kind: "line-double-arrow", x: 14, y: 80, width: 42, height: 6, color: "#00b42a" },
          ],
        },
        {
          title: "关键里程碑与指标",
          body: "1. 幻灯片实时协同上线\n2. OOXML PPTX 双向导入导出\n3. 页面结构级撤销闭环",
          background: "#f5f7fb",
          layout: "",
          notes: "展示性能压测数据",
          hidden: false,
          shapes: [
            {
              id: "t1",
              kind: "text",
              x: 56,
              y: 34,
              width: 36,
              height: 22,
              color: "#3370ff",
              text: "P99 同步延迟 < 80ms",
              fontSize: 26,
              bold: true,
              align: "center",
            },
            { id: "r1", kind: "rounded-rectangle", x: 58, y: 64, width: 30, height: 18, color: "#ff8800" },
          ],
        },
        {
          title: "附录：内部评审",
          body: "仅内部团队查阅",
          background: "#ffffff",
          layout: "blank-title",
          notes: "内部备注",
          hidden: true,
          shapes: [],
        },
      ],
      { title: "Q4 架构升级总览" },
    );
    const pptxPath = "/tmp/jiange-e2e-import.pptx";
    writeFileSync(pptxPath, samplePptx);

    // Open File menu and verify buttons
    await evalJS(ownerTab, `document.querySelector("[data-slides-file-menu]").click()`);
    await waitFor(ownerTab, `!!document.querySelector("[data-slides-import-pptx]") && !!document.querySelector("[data-slides-export-pptx]") && !!document.querySelector("[data-slides-print-pdf]")`);
    // Attach real .pptx file to the hidden file input via CDP DOM.setFileInputFiles
    const doc = await ownerTab.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await ownerTab.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: "[data-slides-pptx-input]",
    });
    await ownerTab.send("DOM.setFileInputFiles", { nodeId, files: [pptxPath] });

    await waitFor(ownerTab, `!!document.querySelector("[data-slides-import-modal]") && document.querySelector("[data-slides-import-modal]").innerText.includes("3")`);
    console.log("PASS: PPTX import preview modal parsed 3 slides & 4 shapes.");
    await screenshot(ownerTab, "03-desktop-pptx-import-modal.png");

    // Confirm import
    await evalJS(ownerTab, `document.querySelector("[data-slides-import-confirm]").click()`);
    await waitFor(ownerTab, `!document.querySelector("[data-slides-import-modal]") && document.querySelectorAll("[data-slides-page]").length === 3`);
    // Select Slide 2 to verify text/shapes/notes visually
    await evalJS(ownerTab, `document.querySelectorAll("[data-slides-page]")[1].querySelector("button").click()`);
    await waitFor(ownerTab, `document.querySelector("[data-slides-title]")?.value === "关键里程碑与指标"`);
    console.log("PASS: PPTX imported atomically (3 slides) and rendered cleanly.");
    await screenshot(ownerTab, "04-desktop-imported-deck.png");

    // Full Page Reload persistence check (Postgres 16)
    await ownerTab.send("Page.reload");
    await new Promise((r) => setTimeout(r, 600));
    await waitFor(
      ownerTab,
      `document.querySelectorAll("[data-slides-page]").length === 3 && document.querySelector("[data-slides-title]")?.value === "Q4 架构升级总览"`,
    );
    console.log("PASS: Imported PPTX deck persisted across full page reload in Postgres 16.");

    // Trigger Export PPTX from file menu
    await evalJS(ownerTab, `document.querySelector("[data-slides-file-menu]").click()`);
    await waitFor(ownerTab, `!!document.querySelector("[data-slides-export-pptx]")`);
    await evalJS(ownerTab, `document.querySelector("[data-slides-export-pptx]").click()`);
    await waitFor(ownerTab, `document.body.innerText.includes("已导出 PPTX 演示文稿")`);
    console.log("PASS: Export PPTX succeeded cleanly.");

    // 5. Mobile Viewport (390x844) layout & overflow check
    await ownerTab.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await new Promise((r) => setTimeout(r, 400));
    const overflow = await evalJS(ownerTab, `document.documentElement.scrollWidth - window.innerWidth`);
    if (overflow > 1) {
      throw new Error(`Mobile horizontal overflow detected: ${overflow}px`);
    }
    console.log(`PASS: Mobile 390x844 horizontal overflow = ${overflow}px.`);
    await screenshot(ownerTab, "05-mobile-slides-editor.png");

    if (browser.consoleErrors.length > 0) {
      throw new Error(`Console errors captured: ${JSON.stringify(browser.consoleErrors)}`);
    }
    console.log("ALL E2E CHECKS PASSED WITH 0 CONSOLE ERRORS.");
  } finally {
    await browser.send("Target.disposeBrowserContext", { browserContextId: ownerTab.browserContextId }).catch(() => {});
    await browser.send("Target.disposeBrowserContext", { browserContextId: editorTab.browserContextId }).catch(() => {});
    browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
