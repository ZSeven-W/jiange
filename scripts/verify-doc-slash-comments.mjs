import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9238);
const OUT_DIR = process.env.OUT_DIR || "output/doc-slash-comments-20261119";
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
  if (res.status !== 201) throw new Error(`register ${email} failed: ${res.status} ${res.text}`);
  const cookie = res.setCookie.split(";")[0];
  return { user: res.json.user, cookie };
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
  const debug = await evalJS(cdp, `({ url: location.href, text: document.body.innerText.slice(0, 600) })`);
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

async function typeText(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await sleep(80);
}

async function pressKey(cdp, key, code = key, windowsVirtualKeyCode = 0) {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
  await sleep(80);
}

async function typeSlash(cdp, query) {
  await cdp.send("Input.insertText", { text: "/" });
  await sleep(120);
  if (query) {
    await cdp.send("Input.insertText", { text: query });
    await sleep(120);
  }
}

async function main() {
  const suffix = Date.now();
  const owner = await registerUser(`doc-slash-owner-${suffix}@test.dev`, "林产品");
  const viewer = await registerUser(`doc-slash-viewer-${suffix}@test.dev`, "周审阅");
  const ownerSheetHeaders = { "X-Jiange-User-Id": String(owner.user.id), "X-Jiange-Sheet-Version": "1" };

  // 1. Seed real Sheet, Base, Survey, and Private Sheet via API.
  const sheetRes = await apiReq(owner.cookie, "POST", "/api/drive/nodes", {
    kind: "sheet", title: "Q4 运营预算表", scope: "personal",
  }, { "X-Jiange-User-Id": String(owner.user.id) });
  if (sheetRes.status !== 201) throw new Error(`create sheet: ${sheetRes.status} ${sheetRes.text}`);
  const sheetId = sheetRes.json.id;
  const sheetSnap = await apiReq(owner.cookie, "GET", `/api/sheets/${sheetId}`, undefined, ownerSheetHeaders);
  const ws = sheetSnap.json.sheets[0];
  const r0 = ws.rows[0].id, r1 = ws.rows[1].id, r2 = ws.rows[2].id;
  const c0 = ws.columns[0].id, c1 = ws.columns[1].id, c2 = ws.columns[2].id;
  const revOf = (rowId, columnId) => ws.cells.find((c) => c.rowId === rowId && c.columnId === columnId)?.revision ?? 0;
  const writeRes = await apiReq(owner.cookie, "POST", `/api/sheets/${sheetId}/cells`, {
    mutationId: randomUUID().replace(/-/g, ""),
    worksheetId: ws.id,
    cells: [
      { rowId: r0, columnId: c0, expectedRevision: revOf(r0, c0), raw: "预算项" },
      { rowId: r0, columnId: c1, expectedRevision: revOf(r0, c1), raw: "金额(元)" },
      { rowId: r0, columnId: c2, expectedRevision: revOf(r0, c2), raw: "负责人" },
      { rowId: r1, columnId: c0, expectedRevision: revOf(r1, c0), raw: "云基础设施" },
      { rowId: r1, columnId: c1, expectedRevision: revOf(r1, c1), raw: "120000" },
      { rowId: r1, columnId: c2, expectedRevision: revOf(r1, c2), raw: "林产品" },
      { rowId: r2, columnId: c0, expectedRevision: revOf(r2, c0), raw: "AI 算力" },
      { rowId: r2, columnId: c1, expectedRevision: revOf(r2, c1), raw: "85000" },
      { rowId: r2, columnId: c2, expectedRevision: revOf(r2, c2), raw: "周审阅" },
    ],
  }, ownerSheetHeaders);
  if (writeRes.status !== 200) throw new Error(`write sheet cells: ${writeRes.status} ${writeRes.text}`);

  const baseRes = await apiReq(owner.cookie, "POST", "/api/bases", { title: "产品需求排期库" });
  if (baseRes.status !== 201) throw new Error(`create base: ${baseRes.status} ${baseRes.text}`);
  const baseId = baseRes.json.id;
  const baseSnap = await apiReq(owner.cookie, "GET", `/api/bases/${baseId}`);
  const titleField = baseSnap.json.fields[0];
  const recRes = await apiReq(owner.cookie, "POST", `/api/bases/${baseId}/records`, {
    tableId: baseSnap.json.activeTableId,
    cells: { [String(titleField.id)]: "跨段落划词评论闭环" },
  });
  if (recRes.status !== 201) throw new Error(`create base record: ${recRes.status} ${recRes.text}`);

  const surveyRes = await apiReq(owner.cookie, "POST", "/api/drive/nodes", {
    kind: "survey", title: "2026 用户满意度调研", scope: "personal",
  }, { "X-Jiange-User-Id": String(owner.user.id) });
  if (surveyRes.status !== 201) throw new Error(`create survey: ${surveyRes.status} ${surveyRes.text}`);
  const surveyId = surveyRes.json.id;
  await apiReq(owner.cookie, "PUT", `/api/surveys/${surveyId}`, {
    description: "收集文档协同体验反馈",
    questions: [
      { id: "q1", type: "single", title: "您对斜杠命令效率的满意度？", required: true, options: ["非常满意", "满意", "一般"] },
      { id: "q2", type: "text", title: "最希望优先补齐的能力", required: false },
    ],
    allowAnonymous: true,
  });
  const pubRes = await apiReq(owner.cookie, "POST", `/api/surveys/${surveyId}/status`, {
    status: "published", allowAnonymous: true,
  });
  if (pubRes.status !== 200) throw new Error(`publish survey: ${pubRes.status} ${pubRes.text}`);

  // Private Sheet NOT shared with viewer (to prove permission fencing in Viewer session)
  const privSheetRes = await apiReq(owner.cookie, "POST", "/api/drive/nodes", {
    kind: "sheet", title: "机密薪酬测算表", scope: "personal",
  }, { "X-Jiange-User-Id": String(owner.user.id) });
  const privateSheetId = privSheetRes.json.id;

  // Create target Document and share it + public-previewable sheet/base/survey with Viewer (NOT privateSheetId!)
  const docRes = await apiReq(owner.cookie, "POST", "/api/docs", { title: "Q4 产品对齐方案与斜杠资源验收" });
  if (docRes.status !== 201) throw new Error(`create doc: ${docRes.status} ${docRes.text}`);
  const docId = docRes.json.id;
  for (const id of [docId, sheetId, baseId, surveyId]) {
    const s = await apiReq(owner.cookie, "PUT", `/api/docs/${id}/shares`, { email: viewer.user.email, role: "view" });
    if (s.status !== 200 && s.status !== 204) throw new Error(`share ${id}: ${s.status} ${s.text}`);
  }

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
    await cdp.send("Page.navigate", { url: `${APP}/#/doc/${docId}` });

    await waitFor(cdp, "editor ready", () => {
      const ed = document.querySelector('[contenteditable="true"]');
      return !!ed && !!document.querySelector('[data-block]');
    });
    await sleep(400);

    // Focus the initial paragraph block inside the editor
    await evalJS(cdp, `(() => {
      const text = document.querySelector('[data-block] [data-text]');
      const range = document.createRange();
      range.selectNodeContents(text);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.querySelector('[contenteditable="true"]').focus();
      return true;
    })()`);
    await sleep(150);

    // 2. Test H7 heading via Markdown shortcut `####### `
    await typeText(cdp, "####### ");
    await typeText(cdp, "七级标题：斜杠命令与资源内嵌规范");
    await pressKey(cdp, "Enter", "Enter", 13);

    const hasH7 = await waitFor(cdp, "h7 heading block", () => {
      return [...document.querySelectorAll("[data-block]")].some(
        (b) => b.getAttribute("data-type") === "h7" && b.textContent?.includes("七级标题"),
      );
    });
    if (!hasH7) throw new Error("H7 heading not created");

    // 3. Type 3 paragraphs for cross-paragraph commenting
    await typeText(cdp, "第一段核心结论：协同文档已补齐七到九级标题与安全拆段能力。");
    await pressKey(cdp, "Enter", "Enter", 13);
    await typeText(cdp, "第二段数据支撑：内嵌电子表格、多维表格与问卷卡片均实时校验权限。");
    await pressKey(cdp, "Enter", "Enter", 13);
    await typeText(cdp, "第三段行动方案：跨段落划词评论支持连续三段高亮并在刷新后持久还原。");
    await pressKey(cdp, "Enter", "Enter", 13);

    // 4. Test SAFE MID-PARAGRAPH SPLITTING with `/日期提醒`!
    await typeText(cdp, "前半句内容 后半句内容");
    // Move caret right after "前半句内容 " (offset 6)
    await evalJS(cdp, `(() => {
      const blocks = [...document.querySelectorAll('[data-block]')];
      const target = blocks.find((b) => b.textContent?.includes('前半句内容 后半句内容'));
      const walker = document.createTreeWalker(target.querySelector('[data-text]'), NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const range = document.createRange();
      range.setStart(node, 6);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    })()`);
    await sleep(150);
    await typeSlash(cdp, "日期提醒");
    await waitFor(cdp, "slash menu reminder item", () => !!document.querySelector('[data-slash-menu] [data-value="reminder"]'));
    await evalJS(cdp, `(() => { document.querySelector('[data-slash-menu] [data-value="reminder"]').click(); return true; })()`);
    await waitFor(cdp, "mid-paragraph split reminder block", () => {
      const blocks = [...document.querySelectorAll("[data-block]")];
      const remIdx = blocks.findIndex((b) => b.getAttribute("data-type") === "reminder");
      if (remIdx <= 0 || remIdx >= blocks.length - 1) return false;
      const before = blocks[remIdx - 1].textContent?.trim() || "";
      const after = blocks[remIdx + 1].textContent?.trim() || "";
      return before.includes("前半句内容") && after.includes("后半句内容");
    });

    // Configure reminder label and time
    await evalJS(cdp, `(() => {
      const input = document.querySelector('[data-reminder-label]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '提交发布评审报告');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    })()`);
    await evalJS(cdp, `(() => { document.querySelector('[data-reminder-edit-time]').click(); return true; })()`);
    await waitFor(cdp, "reminder time input", () => !!document.querySelector('[data-reminder-time]'));
    await evalJS(cdp, `(() => {
      const t = document.querySelector('[data-reminder-time]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(t, '16:30');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-reminder-edit-time]').click();
      return true;
    })()`);
    await sleep(200);

    // Helper to move caret to end of last paragraph and insert an embed via slash command
    async function insertEmbedViaSlash(slashCmd, valueId, resourceId, expectedSelector, expectedText) {
      await evalJS(cdp, `(() => {
        const blocks = [...document.querySelectorAll('[data-block]')];
        const last = blocks[blocks.length - 1];
        const textEl = last.querySelector('[data-text]');
        const range = document.createRange();
        range.selectNodeContents(textEl);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.querySelector('[contenteditable="true"]').focus();
        document.dispatchEvent(new Event('selectionchange'));
        return true;
      })()`);
      await sleep(100);
      await pressKey(cdp, "Enter", "Enter", 13);
      await typeSlash(cdp, slashCmd.replace(/^\//, ""));
      await waitFor(cdp, `slash item ${valueId}`, new Function(`return !!document.querySelector('[data-slash-menu] [data-value="${valueId}"]')`));
      await evalJS(cdp, `(() => { document.querySelector('[data-slash-menu] [data-value="${valueId}"]').click(); return true; })()`);
      await waitFor(cdp, `embed option ${resourceId}`, new Function(`return !!document.querySelector('[data-embed-option="${resourceId}"]')`));
      await evalJS(cdp, `(() => { document.querySelector('[data-embed-option="${resourceId}"]').click(); return true; })()`);
      await waitFor(cdp, `embed preview ${expectedSelector}`, new Function(`
        const el = document.querySelector('${expectedSelector}');
        return !!el && el.textContent.includes('${expectedText}');
      `));
    }

    // 5. Insert live embedded Sheet, Base, Survey, and Private Sheet!
    await insertEmbedViaSlash("/嵌入电子表格", "embed-sheet", sheetId, "[data-embed-sheet-preview]", "云基础设施");
    await insertEmbedViaSlash("/嵌入多维表格", "embed-base", baseId, "[data-embed-base-preview]", "跨段落划词评论闭环");
    await insertEmbedViaSlash("/嵌入问卷", "embed-survey", surveyId, "[data-embed-survey-preview]", "收集中");
    await insertEmbedViaSlash("/嵌入电子表格", "embed-sheet", privateSheetId, `[data-embed-id="${privateSheetId}"]`, "机密薪酬测算表");

    // Scroll to show H7 + Reminder + Embeds nicely and capture Screenshot 1
    await evalJS(cdp, `(() => {
      document.querySelector('[data-reminder-block]')?.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    await sleep(300);
    const shot1 = await screenshot(cdp, "01-slash-embeds-reminder-desktop.png");

    // 6. Test Cross-Paragraph Selection Commenting across the 3 paragraphs!
    await evalJS(cdp, `(() => {
      const blocks = [...document.querySelectorAll('[data-block]')];
      const p1 = blocks.find((b) => b.textContent?.includes('第一段核心结论'));
      const p3 = blocks.find((b) => b.textContent?.includes('第三段行动方案'));
      p1.scrollIntoView({ block: 'center' });
      const w1 = document.createTreeWalker(p1.querySelector('[data-text]'), NodeFilter.SHOW_TEXT);
      const w3 = document.createTreeWalker(p3.querySelector('[data-text]'), NodeFilter.SHOW_TEXT);
      const n1 = w1.nextNode();
      const n3 = w3.nextNode();
      const range = document.createRange();
      range.setStart(n1, 4);
      range.setEnd(n3, 12);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return { selected: sel.toString() };
    })()`);

    await waitFor(cdp, "format toolbar with comment button", () => !!document.querySelector('[data-format-toolbar] [data-comment-btn]'));
    await evalJS(cdp, `(() => { document.querySelector('[data-format-toolbar] [data-comment-btn]').click(); return true; })()`);

    await waitFor(cdp, "comment composer with cross-block badge", () => {
      const comp = document.querySelector("[data-comment-composer]");
      return !!comp && comp.textContent?.includes("跨段落");
    });

    await evalJS(cdp, `(() => {
      const ta = document.querySelector('[data-comment-composer] textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '请三段统一口径并补充验收指标');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(100);
    await evalJS(cdp, `(() => {
      const btn = [...document.querySelectorAll('[data-comment-composer] button')].find((b) => b.textContent?.includes('发送'));
      btn.click();
      return true;
    })()`);

    // Verify highlight spans ALL 3 paragraphs & single comment bubble!
    const anchorStats = await waitFor(cdp, "3-paragraph comment highlights", () => {
      const thread = document.querySelector('[data-cross-block-thread="true"]');
      if (!thread) return null;
      const threadEl = thread.closest("[data-thread]");
      const tid = threadEl?.getAttribute("data-thread");
      const anchors = [...document.querySelectorAll(`[data-comment-anchor="${tid}"]`)];
      const blocks = new Set(anchors.map((a) => a.closest("[data-block]")?.getAttribute("data-block")));
      const bubbles = document.querySelectorAll("[data-comment-bubble]").length;
      return blocks.size === 3 && bubbles === 1 ? { tid, anchorCount: anchors.length, blockCount: blocks.size, bubbles } : null;
    });

    // Reply to the cross-paragraph comment thread (specifically targeting the inline reply composer inside [data-thread])
    await evalJS(cdp, `(() => {
      const replyBtn = [...document.querySelectorAll('[data-thread] button')].find((b) => b.textContent?.includes('回复'));
      replyBtn.click();
      return true;
    })()`);
    await waitFor(cdp, "reply textarea", () => !!document.querySelector('[data-thread] [data-comment-composer] textarea'));
    await evalJS(cdp, `(() => {
      const ta = document.querySelector('[data-thread] [data-comment-composer] textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '已确认，将在周五前对齐三段表述');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(100);
    await evalJS(cdp, `(() => {
      const btn = document.querySelector('[data-thread] [data-comment-composer] [data-comment-send]');
      btn.click();
      return true;
    })()`);
    await waitFor(cdp, "nested reply rendered inside thread", () => {
      const thread = document.querySelector('[data-cross-block-thread="true"]')?.closest('[data-thread]');
      return !!thread && thread.textContent?.includes('已确认，将在周五前对齐三段表述');
    });

    // Scroll to top so H7 + 3-paragraph highlights + comment drawer are all visible
    await evalJS(cdp, `(() => { document.querySelector('[data-type="h7"]')?.scrollIntoView({ block: 'start' }); return true; })()`);
    await sleep(300);
    const shot2 = await screenshot(cdp, "02-cross-paragraph-comment-desktop.png");

    // 7. Wait for CRDT sync then RELOAD page against real Postgres 16 and verify full persistence!
    await sleep(800);
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(700);
    await waitFor(cdp, "persisted H7 + reminder + embeds + cross-comment after reload", () => {
      const hasH7 = [...document.querySelectorAll('[data-block]')].some((b) => b.getAttribute("data-type") === "h7" && b.textContent?.includes("七级标题"));
      const remInput = document.querySelector('[data-reminder-label]');
      const hasRem = remInput?.value === "提交发布评审报告" && document.querySelector('[data-reminder-display-time]')?.textContent?.includes("16:30");
      const hasSheet = document.querySelector('[data-embed-sheet-preview]')?.textContent?.includes("云基础设施");
      const hasBase = document.querySelector('[data-embed-base-preview]')?.textContent?.includes("跨段落划词评论闭环");
      const hasSurvey = document.querySelector('[data-embed-survey-preview]')?.textContent?.includes("收集中");
      const anchors = [...document.querySelectorAll('[data-comment-anchor]')];
      const anchorBlocks = new Set(anchors.map((a) => a.closest('[data-block]')?.getAttribute('data-block')));
      return hasH7 && hasRem && hasSheet && hasBase && hasSurvey && anchorBlocks.size === 3;
    }, 20000);

    // 8. Switch to Viewer session (full reload so /api/auth/me reflects Viewer!) -> verify permission fencing on Private Sheet!
    await setCookieOnBrowser(cdp, viewer.cookie);
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(700);
    await waitFor(cdp, "viewer sees shared embeds + forbidden private sheet + 3-paragraph anchors", new Function(`
      const isViewer = document.body.innerText.includes("周审阅") && document.body.innerText.includes("只读");
      const hasSheet = document.querySelector('[data-embed-sheet-preview]')?.textContent?.includes("云基础设施");
      const hasForbidden = !!document.querySelector('[data-embed-id="${privateSheetId}"] [data-embed-forbidden]');
      const anchors = [...document.querySelectorAll('[data-comment-anchor]')];
      const anchorBlocks = new Set(anchors.map((a) => a.closest('[data-block]')?.getAttribute('data-block')));
      return isViewer && hasSheet && hasForbidden && anchorBlocks.size === 3;
    `), 20000);
    await evalJS(cdp, `(() => {
      document.querySelector('[data-embed-id="${privateSheetId}"]')?.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(300);
    const shot3 = await screenshot(cdp, "03-viewer-embed-fencing-desktop.png");

    // 9. Switch back to Owner and check Mobile 390x844 responsive layout!
    await setCookieOnBrowser(cdp, owner.cookie);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(700);
    await waitFor(cdp, "mobile doc rendered", () => !!document.querySelector("[data-embed-sheet-preview]") && !!document.querySelector("[data-reminder-block]"));
    await evalJS(cdp, `(() => { document.querySelector('[data-reminder-block]')?.scrollIntoView({ block: 'start' }); return true; })()`);
    await sleep(300);
    const mobileMetrics = await evalJS(cdp, `({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    const shot4 = await screenshot(cdp, "04-doc-slash-comments-mobile.png");

    // Filter out only the expected 403/404 log caused by Viewer opening the intentionally unshared private sheet.
    const unexpectedErrors = cdp.consoleErrors.filter(
      (e) => !((e.includes("403") || e.includes("404")) && e.includes(`/api/sheets/${privateSheetId}`)),
    );

    const summary = {
      docId,
      sheetId,
      baseId,
      surveyId,
      privateSheetId,
      anchorStats,
      mobileMetrics,
      shots: [shot1, shot2, shot3, shot4],
      expectedFencing403Count: cdp.consoleErrors.length - unexpectedErrors.length,
      unexpectedErrors,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (mobileMetrics.overflow > 0) throw new Error(`Mobile horizontal overflow detected: ${mobileMetrics.overflow}px`);
    if (unexpectedErrors.length > 0) throw new Error(`Unexpected console errors: ${JSON.stringify(unexpectedErrors)}`);
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
