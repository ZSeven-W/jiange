import fs from "node:fs/promises";
import path from "node:path";

const APP = process.env.JIANGE_SHEET_TEST_URL || "http://127.0.0.1:5174";
const CDP = process.env.JIANGE_SHEET_CDP_URL || "http://127.0.0.1:9226";
const OUT = process.env.JIANGE_SHEET_SCREENSHOT_DIR || process.cwd();
if (![APP, CDP].every((url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))) {
  throw new Error("Only local disposable URLs allowed");
}
await fs.mkdir(OUT, { recursive: true });

// Connect to browser-level CDP endpoint so we can spin up TWO isolated BrowserContexts
// (Alice in context 1, Bob in context 2) with independent cookies and live WebSockets!
const versionInfo = await (await fetch(new URL("/json/version", CDP))).json();
const browserWs = new WebSocket(versionInfo.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  browserWs.onopen = res;
  browserWs.onerror = rej;
});

let bSeq = 0;
const bJobs = new Map();
browserWs.onmessage = (ev) => {
  const item = JSON.parse(ev.data);
  if (!item.id) return;
  const job = bJobs.get(item.id);
  if (!job) return;
  bJobs.delete(item.id);
  item.error ? job.reject(new Error(item.error.message)) : job.resolve(item.result);
};
const bSend = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++bSeq;
    bJobs.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, method, params }));
  });

async function createIsolatedTab(width = 1440, height = 900) {
  const { browserContextId } = await bSend("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await bSend("Target.createTarget", { url: "about:blank", browserContextId });
  const list = await (await fetch(new URL("/json/list", CDP))).json();
  const target = list.find((t) => t.id === targetId);
  if (!target?.webSocketDebuggerUrl) throw new Error(`Missing WS URL for target ${targetId}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let seq = 0;
  const jobs = new Map();
  const consoleErrors = [];
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const item = JSON.parse(ev.data);
    if (item.method === "Runtime.consoleAPICalled" && item.params?.type === "error") {
      consoleErrors.push((item.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (item.method === "Runtime.exceptionThrown") {
      pageErrors.push(item.params?.exceptionDetails?.text || "exception");
    }
    if (!item.id) return;
    const job = jobs.get(item.id);
    if (!job) return;
    jobs.delete(item.id);
    item.error ? job.reject(new Error(item.error.message)) : job.resolve(item.result);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      jobs.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const run = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  };
  const wait = async (expression, limit = 160) => {
    for (let i = 0; i < limit; i++) {
      try {
        if (await run(expression)) return;
      } catch (err) {
        if (err?.code !== -32000) throw err;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for: ${expression}\nBody: ${(await run("document.body.innerText")).slice(0, 600)}`);
  };
  const screenshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(OUT, name), Buffer.from(data, "base64"));
  };
  const assertNoOverflow = async (label) => {
    const rect = await run(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`);
    if (rect.scrollWidth > rect.innerWidth) {
      throw new Error(`${label} horizontal overflow: ${rect.scrollWidth} > ${rect.innerWidth}`);
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 500 });

  return {
    send,
    run,
    wait,
    screenshot,
    assertNoOverflow,
    consoleErrors,
    pageErrors,
    async close() {
      ws.close();
      await bSend("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    },
  };
}

const registerAndLogin = async (tab, email, name) => {
  await tab.send("Page.navigate", { url: `${APP}/` });
  await tab.wait(`!!document.querySelector('form')`);
  const me = await tab.run(`fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(email)}, name: ${JSON.stringify(name)}, password: 'password123' })
  }).then(async (r) => { if (!r.ok) throw new Error('register ' + r.status + ' ' + await r.text()); return r.json(); })`);
  return me;
};

const aliceTab = await createIsolatedTab(1440, 900);
const bobTab = await createIsolatedTab(1440, 900);

try {
  const suffix = Date.now();
  const aliceMe = await registerAndLogin(aliceTab, `sheet-alice-${suffix}@example.test`, "Alice");
  const bobMe = await registerAndLogin(bobTab, `sheet-bob-${suffix}@example.test`, "Bob");

  const wsId = aliceMe.workspaces[0].id;
  const aliceId = aliceMe.user.id;
  const bobId = bobMe.user.id;

  // Alice invites Bob; Bob accepts invitation.
  await aliceTab.run(`fetch('/api/workspaces/${wsId}/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Jiange-User-Id': '${aliceId}' },
    body: JSON.stringify({ email: ${JSON.stringify(bobMe.user.email)}, role: 'member' })
  }).then((r) => { if (!r.ok) throw new Error('invite failed ' + r.status); })`);

  await bobTab.run(`(async () => {
    const list = await fetch('/api/invitations', { headers: { 'X-Jiange-User-Id': '${bobId}' } }).then((r) => r.json());
    const id = list.invitations[0].id;
    const res = await fetch('/api/invitations/' + id + '/accept', { method: 'POST', headers: { 'X-Jiange-User-Id': '${bobId}' } });
    if (res.status !== 204) throw new Error('accept failed ' + res.status);
  })()`);

  // Alice creates a standalone Sheet and opens it in BOTH Chrome tabs!
  const sheetEntry = await aliceTab.run(`fetch('/api/drive/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'sheet', title: '高并发协同表格', scope: 'shared' })
  }).then((r) => r.json())`);
  const sheetId = sheetEntry.id;

  await aliceTab.run(`location.hash = '#/sheet/${sheetId}'; location.reload();`);
  await bobTab.run(`location.hash = '#/sheet/${sheetId}'; location.reload();`);
  await aliceTab.wait(`!!document.querySelector('[data-sheet-grid]')`);
  await bobTab.wait(`!!document.querySelector('[data-sheet-grid]')`);

  // 1. Live Multi-Cell Region Selection Presence + "编辑中" Badge over WebSocket!
  // Bob selects B2:D3 (click 1:1, Shift-click 2:3) and enters inline edit on B2.
  await bobTab.run(`(() => {
    const c1 = document.querySelector('[data-sheet-cell="1:1"] > div');
    const c2 = document.querySelector('[data-sheet-cell="2:3"] > div');
    c1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    c1.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    c2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true }));
    c2.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, shiftKey: true }));
  })()`);

  await aliceTab.wait(`!!document.querySelector('[data-remote-collab-badge="${bobId}"]')`);

  // Bob starts editing B2 -> Alice sees "Bob · 编辑中" badge!
  await bobTab.run(`(() => {
    const c1 = document.querySelector('[data-sheet-cell="1:1"] > div');
    c1.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await aliceTab.wait(`document.querySelector('[data-remote-collab-badge="${bobId}"]')?.textContent?.includes('编辑中')`);
  await aliceTab.screenshot("sheet-collab-presence-desktop.png");

  // 2. Live WebSocket incremental cellDelta push: Bob commits "预算 2026" to B2 -> Alice sees it live!
  await bobTab.run(`(() => {
    const inp = document.querySelector('[data-sheet-cell="1:1"] input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, '预算 2026');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await aliceTab.wait(`document.querySelector('[data-sheet-cell="1:1"]')?.textContent?.includes('预算 2026')`);

  // 3. Orthogonal Same-Cell Auto-Merge (Value vs Bold):
  // Alice opens inline edit on A1 (baseRevision=0) and starts typing "=100+250".
  // While Alice is STILL typing, Bob formats A1 Bold via API/UI (rev -> 1).
  // When Alice presses Enter (sending expectedRevision=0), server AUTO-MERGES value + bold!
  await aliceTab.run(`(() => {
    const c0 = document.querySelector('[data-sheet-cell="0:0"] > div');
    c0.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await aliceTab.wait(`!!document.querySelector('[data-sheet-cell="0:0"] input')`);

  // Bob selects A1 and clicks Bold while Alice is mid-edit!
  await bobTab.run(`(() => {
    const c0 = document.querySelector('[data-sheet-cell="0:0"] > div');
    c0.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    c0.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  })()`);
  await bobTab.wait(`document.querySelector('[data-sheet-cell="0:0"]')?.getAttribute('aria-selected') === 'true'`);
  await bobTab.run(`document.querySelector('[data-sheet-tool="bold"]').click()`);
  await bobTab.wait(`document.querySelector('[data-sheet-cell="0:0"] > div')?.style?.fontWeight === '600'`);

  // Alice commits "=100+250" on A1 -> should AUTO-MERGE cleanly (displays "350" AND fontWeight 600, ZERO conflict bar)!
  await aliceTab.run(`(() => {
    const inp = document.querySelector('[data-sheet-cell="0:0"] input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, '=100+250');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await aliceTab.wait(`document.querySelector('[data-sheet-cell="0:0"]')?.textContent?.includes('350') && document.querySelector('[data-sheet-cell="0:0"] > div')?.style?.fontWeight === '600'`);
  const conflictAfterAutoMerge = await aliceTab.run(`!!document.querySelector('[data-sheet-conflict-bar]')`);
  if (conflictAfterAutoMerge) {
    throw new Error("Expected orthogonal raw+bold edit to auto-merge without conflict bar");
  }

  // 4. True Same-Cell Value Conflict -> Interactive Conflict Resolution Bar (SheetConflictBar)!
  // Alice begins editing A3 (2:0) at baseRevision=0.
  await aliceTab.run(`(() => {
    const c = document.querySelector('[data-sheet-cell="2:0"] > div');
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await aliceTab.wait(`!!document.querySelector('[data-sheet-cell="2:0"] input')`);

  // While Alice is editing A3, Bob writes "Bob方案" to A3 and commits!
  await bobTab.run(`(() => {
    const c = document.querySelector('[data-sheet-cell="2:0"] > div');
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await bobTab.wait(`!!document.querySelector('[data-sheet-cell="2:0"] input')`);
  await bobTab.run(`(() => {
    const inp = document.querySelector('[data-sheet-cell="2:0"] input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, 'Bob方案');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await bobTab.wait(`document.querySelector('[data-sheet-cell="2:0"]')?.textContent?.includes('Bob方案')`);

  // Now Alice commits "Alice方案" at her captured baseRevision=0 -> SheetConflictBar appears!
  await aliceTab.run(`(() => {
    const inp = document.querySelector('[data-sheet-cell="2:0"] input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, 'Alice方案');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await aliceTab.wait(`!!document.querySelector('[data-sheet-conflict-item="A3"]')`);
  await aliceTab.screenshot("sheet-collab-value-conflict-desktop.png");

  // Alice clicks "保留我的" -> rebases onto Bob's revision and persists "Alice方案" to BOTH Alice & Bob!
  await aliceTab.run(`document.querySelector('[data-conflict-keep-mine="A3"]').click()`);
  await aliceTab.wait(`!document.querySelector('[data-sheet-conflict-item="A3"]') && document.querySelector('[data-sheet-cell="2:0"]')?.textContent?.includes('Alice方案')`);
  await bobTab.wait(`document.querySelector('[data-sheet-cell="2:0"]')?.textContent?.includes('Alice方案')`);

  // 5. Region-Level Concurrent Disjoint Merge Preservation + Overlapping Merge Conflict UI!
  // Alice selects A5:B6 (4:0 -> 5:1) and clicks Merge -> merges A5:B6.
  await aliceTab.run(`(() => {
    const a = document.querySelector('[data-sheet-cell="4:0"] > div');
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    a.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  })()`);
  await aliceTab.wait(`document.querySelector('[data-sheet-cell="4:0"]')?.getAttribute('aria-selected') === 'true'`);
  await aliceTab.run(`(() => {
    const b = document.querySelector('[data-sheet-cell="5:1"] > div');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true }));
    b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, shiftKey: true }));
  })()`);
  await aliceTab.wait(`document.querySelector('[data-sheet-cell="5:1"]')?.getAttribute('aria-selected') === 'true'`);
  await aliceTab.run(`document.querySelector('[data-sheet-tool="merge"]').click()`);
  await aliceTab.wait(`parseInt(document.querySelector('[data-sheet-cell="4:0"] > div')?.style?.width || '0', 10) > 150`);

  // Bob merges disjoint D5:E6 (4:3 -> 5:4) -> BOTH A5:B6 AND D5:E6 survive!
  await bobTab.run(`(() => {
    const a = document.querySelector('[data-sheet-cell="4:3"] > div');
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    a.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  })()`);
  await bobTab.wait(`document.querySelector('[data-sheet-cell="4:3"]')?.getAttribute('aria-selected') === 'true'`);
  await bobTab.run(`(() => {
    const b = document.querySelector('[data-sheet-cell="5:4"] > div');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true }));
    b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, shiftKey: true }));
  })()`);
  await bobTab.wait(`document.querySelector('[data-sheet-cell="5:4"]')?.getAttribute('aria-selected') === 'true'`);
  await bobTab.run(`document.querySelector('[data-sheet-tool="merge"]').click()`);
  await bobTab.wait(`parseInt(document.querySelector('[data-sheet-cell="4:3"] > div')?.style?.width || '0', 10) > 150`);

  const snapAfterDisjoint = await aliceTab.run(`fetch('/api/sheets/${sheetId}', { headers: { 'X-Jiange-User-Id': '${aliceId}', 'X-Jiange-Sheet-Version': '1' } }).then((r) => r.json())`);
  if (snapAfterDisjoint.sheets[0].merges.length !== 2) {
    throw new Error(`Expected 2 disjoint merges preserved, got ${JSON.stringify(snapAfterDisjoint.sheets[0].merges)}`);
  }

  // Test mobile 390x844 layout with active conflict bar (zero horizontal overflow & zero errors!).
  await aliceTab.run(`(() => {
    const c = document.querySelector('[data-sheet-cell="3:0"] > div');
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await aliceTab.wait(`!!document.querySelector('[data-sheet-cell="3:0"] input')`);
  // Bob writes A4 concurrently so Alice's A4 triggers conflict bar on mobile screenshot!
  await bobTab.run(`(() => {
    const c = document.querySelector('[data-sheet-cell="3:0"] > div');
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await bobTab.wait(`!!document.querySelector('[data-sheet-cell="3:0"] input')`);
  await bobTab.run(`(() => {
    const inp = document.querySelector('[data-sheet-cell="3:0"] input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, 'Bob移动端测试');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await bobTab.wait(`document.querySelector('[data-sheet-cell="3:0"]')?.textContent?.includes('Bob移动端测试')`);

  await aliceTab.run(`(() => {
    const inp = document.querySelector('[data-sheet-cell="3:0"] input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, 'Alice移动端测试');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await aliceTab.wait(`!!document.querySelector('[data-sheet-conflict-item="A4"]')`);
  await aliceTab.assertNoOverflow("desktop-1440");

  await aliceTab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 300));
  await aliceTab.assertNoOverflow("mobile-390");
  await aliceTab.screenshot("sheet-collab-conflict-mobile.png");

  // Reload Alice tab to verify full Postgres persistence of merged cell A1, resolved A3, and both disjoint merges!
  await aliceTab.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await aliceTab.run(`window.__preReload = true`);
  await aliceTab.send("Page.reload");
  await aliceTab.wait(`!window.__preReload && !!document.querySelector('[data-sheet-grid]') && document.querySelector('[data-sheet-cell="0:0"]')?.textContent?.includes('350') && document.querySelector('[data-sheet-cell="2:0"]')?.textContent?.includes('Alice方案')`);

  if (aliceTab.consoleErrors.length || aliceTab.pageErrors.length || bobTab.consoleErrors.length || bobTab.pageErrors.length) {
    throw new Error(`Console/page errors: alice=${JSON.stringify(aliceTab.consoleErrors)}/${JSON.stringify(aliceTab.pageErrors)} bob=${JSON.stringify(bobTab.consoleErrors)}/${JSON.stringify(bobTab.pageErrors)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    sheetId,
    mergesPreserved: snapAfterDisjoint.sheets[0].merges.length,
    screenshots: [
      "sheet-collab-presence-desktop.png",
      "sheet-collab-value-conflict-desktop.png",
      "sheet-collab-conflict-mobile.png",
    ],
  }, null, 2));
} finally {
  await aliceTab.close();
  await bobTab.close();
  browserWs.close();
}
