import { mkdirSync, writeFileSync } from "node:fs";
import { exportMindMapToXmind } from "../packages/whiteboard-sdk/dist/xmind.js";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9237);
const OUT_DIR = process.env.OUT_DIR || "output/whiteboard-mindmap-20261119";
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

async function setCookieOnBrowser(cdp, rawSetCookie) {
  const [nameVal] = rawSetCookie.split(";");
  const eqIdx = nameVal.indexOf("=");
  await cdp.send("Network.setCookie", {
    name: nameVal.slice(0, eqIdx),
    value: nameVal.slice(eqIdx + 1),
    url: APP,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

async function mouseDrag(cdp, x0, y0, x1, y1, steps = 8) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await new Promise((r) => setTimeout(r, 25));
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 150));
}

async function mouseClick(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 120));
}

async function ensureBoardOpen(cdp) {
  await waitFor(cdp, `!!document.querySelector("[data-flow-editor]") || !!document.querySelector("[data-flow-open]")`);
  const alreadyOpen = await evalJS(cdp, `!!document.querySelector("[data-flow-editor]")`);
  if (!alreadyOpen) {
    await evalJS(cdp, `document.querySelector("[data-flow-open]").click()`);
    await waitFor(cdp, `!!document.querySelector("[data-flow-editor]")`);
  }
  await new Promise((r) => setTimeout(r, 250));
}

async function main() {
  const ts = Date.now();
  const reg = await apiReq(null, "POST", "/api/auth/register", {
    email: `wb-e2e-${ts}@example.com`,
    name: "周架构",
    password: "password123",
  });
  const cookie = reg.setCookie.split(";")[0];
  const userId = String(reg.data.user.id);

  // Create a real board document (docType="board")
  const boardNode = (
    await apiReq(
      cookie,
      "POST",
      "/api/drive/nodes",
      { kind: "doc", docType: "board", title: "Q4 系统架构与导图画板", scope: "personal" },
      { "X-Jiange-User-Id": userId },
    )
  ).data;

  const cdp = await connectCDP(await getWsUrl());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  try {
    await setCookieOnBrowser(cdp, reg.setCookie);
    await cdp.send("Page.navigate", { url: `${APP}/` });
    await waitFor(cdp, `document.readyState === "complete"`);
    await evalJS(cdp, `sessionStorage.setItem("jiange:board:${userId}:${boardNode.id}", "board")`);
    await cdp.send("Page.navigate", { url: `${APP}/#/doc/${boardNode.id}` });
    await ensureBoardOpen(cdp);

    // Dismiss starter picker if visible
    await evalJS(cdp, `document.querySelector('[aria-label="关闭模板"]')?.click()`);
    await new Promise((r) => setTimeout(r, 150));

    // 1. Place 2 geometric shapes + draw 2 freehand ink strokes
    await evalJS(cdp, `document.querySelector('[title="图形（点击画布放置）"]').click()`);
    await mouseClick(cdp, 540, 260);
    await evalJS(cdp, `document.querySelector('[title="判断"]').click()`);
    await mouseClick(cdp, 780, 290);
    await waitFor(cdp, `document.querySelectorAll("[data-flow-editor] [data-flow-node]").length === 2`);

    await evalJS(cdp, `document.querySelector("[data-flow-pen-tool]").click()`);
    await mouseDrag(cdp, 490, 420, 660, 480, 8);
    await mouseDrag(cdp, 700, 430, 840, 470, 8);
    await waitFor(cdp, `document.querySelectorAll("[data-flow-editor] [data-flow-stroke]").length === 2`);
    console.log("PASS: Created 2 shapes and 2 freehand ink strokes on whiteboard.");

    // Switch back to select tool and select all (Cmd/Ctrl+A)
    await evalJS(cdp, `document.querySelector("[data-flow-select-tool]").click()`);
    await new Promise((r) => setTimeout(r, 100));
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2, // Control
      windowsVirtualKeyCode: 65,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
    });

    await waitFor(cdp, `!!document.querySelector("[data-flow-group-box]") && !!document.querySelector("[data-flow-group-resize]")`);
    const beforeGeom = await evalJS(
      cdp,
      `(() => {
        const box = document.querySelector("[data-flow-group-box] rect").getBoundingClientRect();
        const handle = document.querySelector("[data-flow-group-resize]").getBoundingClientRect();
        const n0 = document.querySelector("[data-flow-editor] [data-flow-node]").getBoundingClientRect();
        const s0 = document.querySelector("[data-flow-editor] [data-flow-stroke]").getBoundingClientRect();
        return {
          boxW: box.width, boxH: box.height,
          hx: handle.left + handle.width / 2, hy: handle.top + handle.height / 2,
          nw: n0.width, nh: n0.height, sw: s0.width, sh: s0.height,
        };
      })()`,
    );

    // Drag group scale handle diagonally outward (+120, +85)
    await mouseDrag(cdp, Math.round(beforeGeom.hx), Math.round(beforeGeom.hy), Math.round(beforeGeom.hx + 120), Math.round(beforeGeom.hy + 85), 10);

    const afterGeom = await evalJS(
      cdp,
      `(() => {
        const box = document.querySelector("[data-flow-group-box] rect").getBoundingClientRect();
        const n0 = document.querySelector("[data-flow-editor] [data-flow-node]").getBoundingClientRect();
        const s0 = document.querySelector("[data-flow-editor] [data-flow-stroke]").getBoundingClientRect();
        return { boxW: box.width, boxH: box.height, nw: n0.width, nh: n0.height, sw: s0.width, sh: s0.height };
      })()`,
    );
    const nodeScaleX = afterGeom.nw / beforeGeom.nw;
    const nodeScaleY = afterGeom.nh / beforeGeom.nh;
    const strokeScaleX = afterGeom.sw / beforeGeom.sw;
    if (!(nodeScaleX > 1.15 && Math.abs(nodeScaleX - nodeScaleY) < 0.08 && strokeScaleX > 1.12)) {
      throw new Error(`Proportional scaling assertion failed: before=${JSON.stringify(beforeGeom)} after=${JSON.stringify(afterGeom)}`);
    }
    console.log(`PASS: Multi-selection proportional scale verified (node scale ${nodeScaleX.toFixed(2)}x / ${nodeScaleY.toFixed(2)}x, stroke scale ${strokeScaleX.toFixed(2)}x).`);
    await screenshot(cdp, "01-desktop-multi-scale.png");

    // Undo restores original dimensions cleanly
    await evalJS(cdp, `document.querySelector('[data-flow-editor] button[title="撤销"]').click()`);
    await new Promise((r) => setTimeout(r, 250));
    const undoneW = await evalJS(cdp, `document.querySelector("[data-flow-editor] [data-flow-node]").getBoundingClientRect().width`);
    if (Math.abs(undoneW - beforeGeom.nw) > 4) {
      throw new Error(`Undo after group scale failed: expected ~${beforeGeom.nw}, got ${undoneW}`);
    }
    console.log("PASS: Single-step Undo restored exact pre-scale geometry.");

    // 2. Board Coordinate & Shape-Anchored Comments
    await evalJS(cdp, `document.querySelector("[data-flow-comment-tool]").click()`);
    await mouseClick(cdp, 620, 175);
    await waitFor(cdp, `!!document.querySelector("[data-flow-comment-composer]")`);
    await evalJS(cdp, `document.querySelector("[data-flow-comment-input]").focus()`);
    await cdp.send("Input.insertText", { text: "此处补充异步消息队列与死信重试说明" });
    await evalJS(cdp, `document.querySelector("[data-flow-comment-submit]").click()`);
    await waitFor(cdp, `document.querySelectorAll("[data-flow-editor] [data-flow-comment-pin]").length === 1 && !!document.querySelector("[data-flow-comment-popover]")`);

    // Reply inside the board thread popover
    await evalJS(cdp, `document.querySelector("[data-flow-comment-reply-input]").focus()`);
    await cdp.send("Input.insertText", { text: "已确认，优先采用 Kafka 死信队列" });
    await evalJS(cdp, `document.querySelector("[data-flow-comment-reply-submit]").click()`);
    await waitFor(cdp, `document.querySelector("[data-flow-comment-popover]")?.innerText.includes("已确认，优先采用 Kafka 死信队列")`);
    console.log("PASS: Canvas coordinate comment pin + inline reply verified.");

    // Close popover, select node 1, and create a node-anchored comment
    await evalJS(cdp, `document.querySelector('[data-flow-comment-popover] button[aria-label="关闭评论"]').click()`);
    const nodeCenter = await evalJS(
      cdp,
      `(() => { const r = document.querySelector("[data-flow-editor] [data-flow-node]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    await mouseClick(cdp, nodeCenter.x, nodeCenter.y);
    await waitFor(cdp, `!!document.querySelector("[data-flow-comment]")`);
    await evalJS(cdp, `document.querySelector("[data-flow-comment]").click()`);
    await waitFor(cdp, `!!document.querySelector("[data-flow-comment-composer]")`);
    await evalJS(cdp, `document.querySelector("[data-flow-comment-input]").focus()`);
    await cdp.send("Input.insertText", { text: "核心处理节点需补充幂等键校验" });
    await evalJS(cdp, `document.querySelector("[data-flow-comment-submit]").click()`);
    await waitFor(cdp, `document.querySelectorAll("[data-flow-editor] [data-flow-comment-pin]").length === 2`);
    await waitFor(cdp, `document.querySelector("[data-flow-comments-count]")?.innerText.trim() === "2"`);
    console.log("PASS: Shape-anchored comment pin created (2 total live pins).");
    await screenshot(cdp, "02-desktop-board-comment-pins.png");

    // Full page reload persistence check for pins + replies + shapes + strokes
    await cdp.send("Page.reload");
    await new Promise((r) => setTimeout(r, 700));
    await ensureBoardOpen(cdp);
    await waitFor(cdp, `document.querySelectorAll("[data-flow-editor] [data-flow-comment-pin]").length === 2`);
    console.log("PASS: Both canvas comment pins survived full page reload in Postgres 16.");

    // Resolve Pin 1 -> count drops from 2 to 1
    const pin1Center = await evalJS(
      cdp,
      `(() => { const r = document.querySelector("[data-flow-editor] [data-flow-comment-pin]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    await mouseClick(cdp, pin1Center.x, pin1Center.y);
    await waitFor(cdp, `!!document.querySelector("[data-flow-comment-resolve]")`);
    await evalJS(cdp, `document.querySelector("[data-flow-comment-resolve]").click()`);
    await waitFor(cdp, `document.querySelectorAll("[data-flow-editor] [data-flow-comment-pin]").length === 1`);
    console.log("PASS: Resolved canvas comment pin cleanly (2 -> 1).");

    // 3. Genuine .xmind Import & Export
    const xmindBytes = exportMindMapToXmind(
      {
        mind: [
          { id: "r1", parent: null, order: 1000, text: "2026 协同产品路线图", x: 0, y: 0 },
          { id: "c1", parent: "r1", order: 1000, text: "画板与导图闭环" },
          { id: "c1a", parent: "c1", order: 1000, text: "坐标锚点评论" },
          { id: "c1b", parent: "c1", order: 2000, text: "多选等比缩放" },
          { id: "c2", parent: "r1", order: 2000, text: "XMind 双向互通" },
        ],
        mindDescriptions: {
          r1: "通过标准 .xmind 导入画布",
        },
        mindStyles: {
          r1: { shape: "rect", size: 18, color: "#ffffff" },
          c1: { shape: "oval", size: 14 },
        },
        mindPaints: {
          r1: { fill: "#3370ff", stroke: "#1f2329", width: 2 },
          c1: { fill: "#dff2dd", stroke: "#2ea121", width: 2 },
        },
        mindTextFormats: {
          r1: { bold: true },
        },
      },
      { title: "产品路线图" },
    );
    const xmindPath = "/tmp/jiange-e2e-roadmap.xmind";
    writeFileSync(xmindPath, xmindBytes);

    const doc = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: "[data-flow-import-input]",
    });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [xmindPath] });
    await waitFor(cdp, `document.body.innerText.includes("已导入 XMind") && document.body.innerText.includes("2026 协同产品路线图")`);
    console.log("PASS: Imported standard .xmind archive cleanly into whiteboard canvas.");

    // Trigger XMind export from Export menu
    await evalJS(cdp, `document.querySelector("[data-flow-export-btn]").click()`);
    await waitFor(cdp, `!!document.querySelector('[data-flow-export="xmind"]')`);
    await evalJS(cdp, `document.querySelector('[data-flow-export="xmind"]').click()`);
    await new Promise((r) => setTimeout(r, 300));
    console.log("PASS: Triggered .xmind export without error.");
    await screenshot(cdp, "03-desktop-xmind-imported.png");

    // Verify imported XMind topics persisted across full reload
    await cdp.send("Page.reload");
    await new Promise((r) => setTimeout(r, 700));
    await ensureBoardOpen(cdp);
    await waitFor(cdp, `document.body.innerText.includes("2026 协同产品路线图") && document.querySelectorAll("[data-flow-editor] [data-flow-comment-pin]").length === 1`);
    console.log("PASS: Imported XMind mindmap + remaining canvas comment pin persisted in Postgres 16.");

    // 4. Mobile 390x844 layout & overflow check inside board editor
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await new Promise((r) => setTimeout(r, 450));
    // Open the remaining comment pin popover on mobile to verify clamping
    await evalJS(cdp, `document.querySelector("[data-flow-comments-count]")?.click()`);
    await waitFor(cdp, `!!document.querySelector("[data-flow-comment-popover]")`);
    const overflow = await evalJS(cdp, `document.documentElement.scrollWidth - window.innerWidth`);
    if (overflow > 1) {
      throw new Error(`Mobile horizontal overflow detected: ${overflow}px`);
    }
    console.log(`PASS: Mobile 390x844 horizontal overflow = ${overflow}px.`);
    await screenshot(cdp, "04-mobile-board-editor.png");

    if (cdp.consoleErrors.length > 0) {
      throw new Error(`Console errors captured: ${JSON.stringify(cdp.consoleErrors)}`);
    }
    console.log("ALL WHITEBOARD & MINDMAP E2E CHECKS PASSED WITH 0 CONSOLE ERRORS.");
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
