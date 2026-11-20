import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9240);
const OUT_DIR = process.env.OUT_DIR || "/tmp/reference-index-graph-20261120";
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
      "X-Jiange-Sheet-Version": "1",
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

async function typeKeys(cdp, text) {
  await cdp.send("Input.insertText", { text });
  await sleep(100);
}

async function pressKey(cdp, key, code = key, windowsVirtualKeyCode = 13) {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
  await sleep(90);
}

async function main() {
  const suffix = Date.now();
  const owner = await registerUser(`refgraph-owner-${suffix}@test.dev`, "林架构");
  const bob = await registerUser(`refgraph-bob-${suffix}@test.dev`, "陈访客");
  const ownerHeaders = { "X-Jiange-User-Id": String(owner.user.id) };

  const createDoc = async (title) => {
    const r = await apiReq(owner.cookie, "POST", "/api/docs", { title, workspaceId: owner.workspace.id }, ownerHeaders);
    if (r.status !== 201) throw new Error(`createDoc ${title}: ${r.status} ${r.text}`);
    return r.json;
  };
  const createNode = async (kind, title) => {
    const r = await apiReq(owner.cookie, "POST", "/api/drive/nodes", { kind, title, scope: "shared" }, ownerHeaders);
    if (r.status !== 201) throw new Error(`createNode ${kind} ${title}: ${r.status} ${r.text}`);
    return r.json;
  };

  // Multi-hop chain: Doc A -> Doc B -> Doc C (private!) -> Doc D (shared with Bob, but unreachable via private C!)
  const docA = await createDoc("项目总纲");
  const docB = await createDoc("系统架构设计");
  const docC = await createDoc("核心机密网关");
  const docD = await createDoc("下游履约服务");
  const sheet = await createNode("sheet", "Q4 预算排期表");
  const base = await createNode("base", "迭代需求多维表");
  const slides = await createNode("slides", "季度评审演示");
  const survey = await createNode("survey", "上线满意度问卷");

  // Seed Slides note -> Doc A
  const pagesRes = await apiReq(owner.cookie, "GET", `/api/slides/${slides.id}/pages`, undefined, ownerHeaders);
  const firstSlide = pagesRes.json.pages[0];
  const patchSlide = await apiReq(owner.cookie, "PATCH", `/api/slides/pages/${firstSlide.id}`, {
    title: firstSlide.title,
    body: firstSlide.body,
    background: firstSlide.background,
    notes: `汇报参考 #/doc/${docA.id} 核心结论`,
    expectedRevision: firstSlide.revision,
  }, ownerHeaders);
  if (patchSlide.status !== 200) throw new Error(`patchSlide: ${patchSlide.status} ${patchSlide.text}`);

  // Seed Sheet cell -> Doc A
  const snapRes = await apiReq(owner.cookie, "GET", `/api/sheets/${sheet.id}`, undefined, ownerHeaders);
  const ws0 = snapRes.json.sheets[0];
  const writeCell = await apiReq(owner.cookie, "POST", `/api/sheets/${sheet.id}/cells`, {
    mutationId: "22222222222222222222222222222222",
    worksheetId: ws0.id,
    cells: [{ rowId: ws0.rows[0].id, columnId: ws0.columns[0].id, expectedRevision: 0, raw: `总纲链接 #/doc/${docA.id}` }],
  }, ownerHeaders);
  if (writeCell.status !== 200) throw new Error(`writeCell: ${writeCell.status} ${writeCell.text}`);

  // Seed Survey description -> Doc A
  const svRes = await apiReq(owner.cookie, "GET", `/api/surveys/${survey.id}`, undefined, ownerHeaders);
  const saveSv = await apiReq(owner.cookie, "PUT", `/api/surveys/${survey.id}`, {
    description: `详见 #/doc/${docA.id} 说明`,
    questions: svRes.json.survey.questions,
    expectedRevision: svRes.json.survey.revision,
  }, ownerHeaders);
  if (saveSv.status !== 200) throw new Error(`saveSv: ${saveSv.status} ${saveSv.text}`);

  // Share Doc A, Doc B, Doc D with Bob (NOT Doc C, NOT Sheet, NOT Base, NOT Slides, NOT Survey).
  for (const d of [docA, docB, docD]) {
    const sh = await apiReq(owner.cookie, "PUT", `/api/docs/${d.id}/shares`, { email: bob.user.email, role: "view" }, ownerHeaders);
    if (sh.status !== 200) throw new Error(`share ${d.id}: ${sh.status} ${sh.text}`);
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

    // Helper: open doc and insert @mention to target title via real editor UI!
    const focusLastBlock = async () => {
      await evalJS(cdp, `(() => {
        const blocks = [...document.querySelectorAll('[data-block] [data-text]')];
        const text = blocks[blocks.length - 1];
        const range = document.createRange();
        range.selectNodeContents(text);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.querySelector('[contenteditable="true"]').focus();
        document.dispatchEvent(new Event('selectionchange'));
        return true;
      })()`);
      await sleep(150);
    };

    const insertMentionInDoc = async (sourceId, targetTitle) => {
      await cdp.send("Page.navigate", { url: `${APP}/#/doc/${sourceId}` });
      await waitFor(cdp, `editor ready for doc ${sourceId}`, () => !!document.querySelector('[contenteditable="true"]') && !!document.querySelector('[data-block] [data-text]'));
      await sleep(350);
      await focusLastBlock();
      await typeKeys(cdp, "引用 ");
      await typeKeys(cdp, "@");
      await sleep(120);
      await typeKeys(cdp, targetTitle.slice(0, 4));
      await waitFor(cdp, `mention menu for ${targetTitle}`, new Function(`
        const opts = [...document.querySelectorAll('[data-slash-menu] button')];
        return opts.some((b) => b.textContent?.includes(${JSON.stringify(targetTitle)}));
      `));
      await evalJS(cdp, `(() => {
        const opts = [...document.querySelectorAll('[data-slash-menu] button')];
        const hit = opts.find((b) => b.textContent?.includes(${JSON.stringify(targetTitle)}));
        hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        hit.click();
        return true;
      })()`);
      await sleep(150);
      await pressKey(cdp, "Enter", "Enter", 13);
      await sleep(700);
    };

    // Build real multi-hop chain + multi-resource links via the real editor!
    // Doc C -> Doc D
    await insertMentionInDoc(docC.id, "下游履约服务");
    // Doc B -> Doc C
    await insertMentionInDoc(docB.id, "核心机密网关");
    // Doc A -> Doc B, Doc A -> Base, AND embed Sheet via /嵌入电子表格!
    await insertMentionInDoc(docA.id, "系统架构设计");
    await focusLastBlock();
    await typeKeys(cdp, "@");
    await sleep(120);
    await typeKeys(cdp, "迭代需求");
    await waitFor(cdp, "base mention option", () => [...document.querySelectorAll('[data-slash-menu] button')].some((b) => b.textContent?.includes("迭代需求多维表")));
    await evalJS(cdp, `(() => {
      const hit = [...document.querySelectorAll('[data-slash-menu] button')].find((b) => b.textContent?.includes('迭代需求多维表'));
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      hit.click();
      return true;
    })()`);
    await sleep(150);
    await pressKey(cdp, "Enter", "Enter", 13);
    await sleep(200);

    // Insert real embedded Sheet block in Doc A via /嵌入电子表格!
    await typeKeys(cdp, "/");
    await sleep(120);
    await typeKeys(cdp, "嵌入电子表格");
    await waitFor(cdp, "slash embed sheet option", () => !!document.querySelector('[data-slash-menu] [data-value="embed-sheet"]'));
    await evalJS(cdp, `(() => {
      const hit = document.querySelector('[data-slash-menu] [data-value="embed-sheet"]');
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      hit.click();
      return true;
    })()`);
    await waitFor(cdp, "embed picker option for sheet", new Function(`return !!document.querySelector('[data-embed-option="${sheet.id}"]')`));
    await evalJS(cdp, `(() => { document.querySelector('[data-embed-option="${sheet.id}"]').click(); return true; })()`);
    await sleep(900);

    // 1. Scroll down to DocumentReferencesPanel on Doc A & verify both tabs!
    await evalJS(cdp, `(() => { document.querySelector('[data-document-references]')?.scrollIntoView({ behavior: 'instant', block: 'center' }); return true; })()`);
    await waitFor(cdp, "incoming references loaded on Doc A", new Function(`
      return !!document.querySelector('[data-reference-incoming-item="${slides.id}"]') &&
             !!document.querySelector('[data-reference-incoming-item="${sheet.id}"]') &&
             !!document.querySelector('[data-reference-incoming-item="${survey.id}"]');
    `));
    // Switch to 本文引用 tab and inspect outgoing multi-resource items (Doc B, Base, Sheet with 内嵌 badge)!
    await evalJS(cdp, `(() => {
      const tabs = [...document.querySelectorAll('[data-document-references] [role="tab"]')];
      tabs[1].click();
      return true;
    })()`);
    const outgoingCheck = await waitFor(cdp, "outgoing multi-resource items rendered", new Function(`
      const b = document.querySelector('[data-reference-outgoing-item="${docB.id}"]');
      const baseEl = document.querySelector('[data-reference-outgoing-item="${base.id}"]');
      const sheetEl = document.querySelector('[data-reference-outgoing-item="${sheet.id}"]');
      if (!b || !baseEl || !sheetEl) return null;
      return {
        baseText: baseEl.textContent.trim(),
        sheetText: sheetEl.textContent.trim(),
        hasEmbedBadge: sheetEl.textContent.includes('内嵌'),
      };
    `));
    if (!outgoingCheck.hasEmbedBadge) throw new Error(`Missing embed badge on sheet outgoing: ${JSON.stringify(outgoingCheck)}`);
    await sleep(250);
    const shot1 = await screenshot(cdp, "01-doc-references-panel-desktop.png");

    // 2. Open interactive Multi-Hop Reference Graph from Doc A!
    await evalJS(cdp, `(() => { document.querySelector('[data-open-reference-graph]').click(); return true; })()`);
    await waitFor(cdp, "2-hop graph shows Doc C at depth 2", new Function(`
      return !!document.querySelector('[data-reference-graph-center="${docA.id}"]') &&
             !!document.querySelector('[data-reference-graph-node="${docB.id}"][data-reference-graph-depth="1"]') &&
             !!document.querySelector('[data-reference-graph-node="${sheet.id}"][data-reference-graph-depth="1"]') &&
             !!document.querySelector('[data-reference-graph-node="${docC.id}"][data-reference-graph-depth="2"]');
    `));
    // Switch to 3 跳 -> verify Doc D appears at depth 3!
    await evalJS(cdp, `(() => { document.querySelector('[data-graph-depth="3"]').click(); return true; })()`);
    const hop3Stats = await waitFor(cdp, "3-hop graph shows Doc D at depth 3", new Function(`
      const d = document.querySelector('[data-reference-graph-node="${docD.id}"][data-reference-graph-depth="3"]');
      const stats = document.querySelector('[data-reference-graph-stats]')?.textContent?.trim();
      return d && stats ? { stats } : null;
    `));
    await sleep(300);
    const shot2 = await screenshot(cdp, "02-multihop-graph-3hop-desktop.png");

    // 3. Navigate to Sheet page and verify ResourceReferencesButton drawer shows Doc A with 内嵌!
    await cdp.send("Page.navigate", { url: `${APP}/#/sheet/${sheet.id}` });
    await waitFor(cdp, "sheet references button visible", () => !!document.querySelector("[data-resource-references-btn]"));
    await evalJS(cdp, `(() => { document.querySelector('[data-resource-references-btn]').click(); return true; })()`);
    const sheetDrawerCheck = await waitFor(cdp, "sheet drawer shows incoming Doc A embed", new Function(`
      const item = document.querySelector('[data-resource-references-drawer] [data-reference-incoming-item="${docA.id}"]');
      return item ? { text: item.textContent.trim(), hasEmbed: item.textContent.includes('内嵌') } : null;
    `));
    if (!sheetDrawerCheck.hasEmbed) throw new Error(`Sheet drawer missing embed badge: ${JSON.stringify(sheetDrawerCheck)}`);

    // 4. Switch cleanly to Bob (unload previous session tab first) -> verify multi-hop private fencing!
    await cdp.send("Page.navigate", { url: "about:blank" });
    await sleep(250);
    await setCookieOnBrowser(cdp, bob.cookie);
    await cdp.send("Page.navigate", { url: `${APP}/#/doc/${docA.id}` });
    await waitFor(cdp, "bob doc A loaded", () => !!document.querySelector("[data-document-references]"));
    await evalJS(cdp, `(() => { document.querySelector('[data-document-references]')?.scrollIntoView({ behavior: 'instant', block: 'center' }); return true; })()`);
    await waitFor(cdp, "bob graph button enabled", () => {
      const btn = document.querySelector("[data-open-reference-graph]");
      return !!btn && !btn.disabled;
    });
    await evalJS(cdp, `(() => { document.querySelector('[data-open-reference-graph]').click(); return true; })()`);
    await waitFor(cdp, "bob 2-hop graph loaded", new Function(`return !!document.querySelector('[data-reference-graph-node="${docB.id}"]')`));
    await evalJS(cdp, `(() => { document.querySelector('[data-graph-depth="3"]').click(); return true; })()`);
    await sleep(500);
    const bobFence = await evalJS(cdp, `(() => {
      const nodes = [...document.querySelectorAll('[data-reference-graph-node]')].map((n) => Number(n.getAttribute('data-reference-graph-node')));
      const text = document.querySelector('[data-reference-graph]')?.textContent || '';
      return {
        nodes,
        hasB: nodes.includes(${docB.id}),
        leakedC: nodes.includes(${docC.id}) || text.includes('核心机密网关'),
        leakedD: nodes.includes(${docD.id}) || text.includes('下游履约服务'),
        stats: document.querySelector('[data-reference-graph-stats]')?.textContent?.trim(),
      };
    })()`);
    if (!bobFence.hasB || bobFence.leakedC || bobFence.leakedD) {
      throw new Error(`Multi-hop fencing failed for Bob: ${JSON.stringify(bobFence)}`);
    }
    const shot3 = await screenshot(cdp, "03-multihop-graph-fencing-desktop.png");

    // 5. Switch cleanly back to Owner at Mobile 390x844 -> check 0px horizontal overflow & mobile graph UI!
    await cdp.send("Page.navigate", { url: "about:blank" });
    await sleep(250);
    await setCookieOnBrowser(cdp, owner.cookie);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send("Page.navigate", { url: `${APP}/#/doc/${docA.id}` });
    await waitFor(cdp, "mobile doc A references ready", () => !!document.querySelector("[data-document-references]"));
    await evalJS(cdp, `(() => { document.querySelector('[data-document-references]')?.scrollIntoView({ behavior: 'instant', block: 'center' }); return true; })()`);
    await waitFor(cdp, "mobile graph btn enabled", () => {
      const btn = document.querySelector("[data-open-reference-graph]");
      return !!btn && !btn.disabled;
    });
    await evalJS(cdp, `(() => { document.querySelector('[data-open-reference-graph]').click(); return true; })()`);
    await waitFor(cdp, "mobile 2-hop graph rendered", new Function(`return !!document.querySelector('[data-reference-graph-node="${docC.id}"][data-reference-graph-depth="2"]')`));
    await sleep(300);
    const mobileMetrics = await evalJS(cdp, `({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })`);
    const shot4 = await screenshot(cdp, "04-multihop-graph-mobile.png");

    // Expected 404 when Bob loads Doc A containing Owner's private embedded Sheet (fenced into lock card).
    const unexpectedErrors = cdp.consoleErrors.filter((e) => !e.includes(`/api/sheets/${sheet.id}`) || !e.includes("404"));
    const summary = {
      outgoingCheck,
      hop3Stats,
      sheetDrawerCheck,
      bobFence,
      mobileMetrics,
      shots: [shot1, shot2, shot3, shot4],
      unexpectedErrors,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (mobileMetrics.overflow > 0) throw new Error(`Mobile horizontal overflow: ${mobileMetrics.overflow}px`);
    if (unexpectedErrors.length > 0) throw new Error(`Console errors: ${JSON.stringify(unexpectedErrors)}`);
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
