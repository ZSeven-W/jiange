import fs from "node:fs/promises";
import path from "node:path";

const APP = process.env.JIANGE_BASE_TEST_URL || "http://127.0.0.1:5174";
const CDP = process.env.JIANGE_BASE_CDP_URL || "http://127.0.0.1:9228";
const OUT = process.env.JIANGE_BASE_SCREENSHOT_DIR || process.cwd();
if (![APP, CDP].every((url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))) {
  throw new Error("Only local disposable URLs allowed");
}
await fs.mkdir(OUT, { recursive: true });

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
  throw new Error(`Timeout waiting for: ${expression}\nBody: ${(await run("document.body.innerText")).slice(0, 700)}`);
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
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

try {
  // 1. Register user and seed a realistic project schedule Base.
  await send("Page.navigate", { url: `${APP}/` });
  await wait(`!!document.querySelector('form')`);
  const suffix = Date.now();
  const me = await run(`fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'base-sched-${suffix}@example.test', name: 'PM', password: 'password123' })
  }).then(async (r) => { if (!r.ok) throw new Error('register ' + r.status); return r.json(); })`);

  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const todayKey = `${y}-${m}-${d}`;
  const ganttStartDay = `${y}-${m}-10`;
  const ganttEndDay = `${y}-${m}-16`;

  const createdBase = await run(`fetch('/api/bases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '2026 项目排期与小时日程' })
  }).then(r => r.json())`);
  const baseId = createdBase.id;

  const snap0 = await run(`fetch('/api/bases/${baseId}').then(r => r.json())`);
  const titleField = snap0.fields[0];

  const startField = await run(`fetch('/api/bases/${baseId}/fields', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '开始时间', type: 'date' })
  }).then(r => r.json())`);
  const endField = await run(`fetch('/api/bases/${baseId}/fields', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '结束时间', type: 'date' })
  }).then(r => r.json())`);
  const noteField = await run(`fetch('/api/bases/${baseId}/fields', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '负责人备注', type: 'text' })
  }).then(r => r.json())`);

  // Delete starter blank records so the schedule views stay super clean.
  for (const r of snap0.records) {
    await run(`fetch('/api/bases/${baseId}/records/${r.id}', { method: 'DELETE' })`);
  }

  const rec1 = await run(`fetch('/api/bases/${baseId}/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cells: {
      '${titleField.id}': '架构评审会',
      '${startField.id}': '${todayKey} 09:00',
      '${endField.id}': '${todayKey} 10:30',
      '${noteField.id}': '架构组全员'
    }})
  }).then(r => r.json())`);

  const rec2 = await run(`fetch('/api/bases/${baseId}/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cells: {
      '${titleField.id}': '前后端联调',
      '${startField.id}': '${todayKey} 13:30',
      '${endField.id}': '${todayKey} 15:00',
      '${noteField.id}': 'API 验收'
    }})
  }).then(r => r.json())`);

  const rec3 = await run(`fetch('/api/bases/${baseId}/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cells: {
      '${titleField.id}': '版本灰度排期',
      '${startField.id}': '${ganttStartDay}',
      '${endField.id}': '${ganttEndDay}',
      '${noteField.id}': '发布负责人'
    }})
  }).then(r => r.json())`);

  // Add Calendar and Gantt views bound to startField + endField.
  await run(`fetch('/api/bases/${baseId}/views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'calendar', name: '小时排程日历', config: { group: ${startField.id}, endField: ${endField.id} } })
  }).then(r => r.json())`);
  await run(`fetch('/api/bases/${baseId}/views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'gantt', name: '项目甘特图', config: { group: ${startField.id}, endField: ${endField.id} } })
  }).then(r => r.json())`);

  // Reload to hydrate session and open the Base.
  await send("Page.reload", { ignoreCache: true });
  await wait(`!document.querySelector('input[type="password"]')`);
  await run(`location.hash = '#/base/${baseId}'`);
  await wait(`document.body.innerText.includes('架构组全员')`);
  await assertNoOverflow("desktop-grid-initial");

  // 2. Test Field Delete -> Atomic Lossless Undo -> Redo -> Undo!
  await run(`(() => {
    const ths = Array.from(document.querySelectorAll('th'));
    const targetTh = ths.find(th => th.textContent.includes('负责人备注'));
    if (!targetTh) throw new Error('missing 负责人备注 column');
    const btn = targetTh.querySelector('button[aria-label*="菜单"], button');
    btn.click();
  })()`);
  await wait(`!!Array.from(document.querySelectorAll('[role="menuitem"], button')).find(b => b.textContent.trim().includes('删除字段'))`);
  await run(`Array.from(document.querySelectorAll('[role="menuitem"], button')).find(b => b.textContent.trim().includes('删除字段')).click()`);
  await wait(`!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '删除' || b.textContent.trim() === '确定')`);
  await run(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '删除' || b.textContent.trim() === '确定').click()`);
  await wait(`!document.body.innerText.includes('架构组全员')`);

  // Undo field delete -> restores BOTH column AND "架构组全员" cell data!
  await wait(`!document.querySelector('[data-base-undo]').disabled`);
  await run(`document.querySelector('[data-base-undo]').click()`);
  await wait(`document.body.innerText.includes('负责人备注') && document.body.innerText.includes('架构组全员')`);

  // Redo -> deletes column again; Undo -> restores it again!
  await wait(`!document.querySelector('[data-base-redo]').disabled`);
  await run(`document.querySelector('[data-base-redo]').click()`);
  await wait(`!document.body.innerText.includes('架构组全员')`);
  await run(`document.querySelector('[data-base-undo]').click()`);
  await wait(`document.body.innerText.includes('架构组全员')`);

  // 3. Test View Rename -> Undo!
  await run(`document.querySelector('button[aria-label="小时排程日历视图菜单"]').click()`);
  await wait(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find(b => b.textContent.trim() === '重命名')`);
  await run(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(b => b.textContent.trim() === '重命名').click()`);
  await wait(`!!document.querySelector('[data-ask-input]')`);
  await run(`(() => {
    const inp = document.querySelector('[data-ask-input]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '研发排程日历');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await run(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '确定').click()`);
  await wait(`document.querySelector('[data-view-tab="calendar"]')?.textContent?.includes('研发排程日历')`);
  // Undo view rename!
  await run(`document.querySelector('[data-base-undo]').click()`);
  await wait(`document.querySelector('[data-view-tab="calendar"]')?.textContent?.includes('小时排程日历')`);

  // 4. Calendar Hourly Scheduling (Week View): pointer drag-move, bottom resize, click-to-schedule + Undo!
  await run(`document.querySelector('[data-view-tab="calendar"]').click()`);
  await wait(`!!document.querySelector('[data-calendar]')`);
  await run(`document.querySelector('[data-calendar-scale-btn="week"]').click()`);
  await wait(`!!document.querySelector('[data-calendar-hourly-grid]') && !!document.querySelector('[data-calendar-timed-event="${rec1.id}"]')`);

  // Move rec1 (09:00–10:30) down by +96px (+2h -> 11:00–12:30).
  const ev1Box = await run(`(() => {
    const el = document.querySelector('[data-calendar-timed-event="${rec1.id}"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 10 };
  })()`);
  await run(`(() => {
    const el = document.querySelector('[data-calendar-timed-event="${rec1.id}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${ev1Box.x}, clientY: ${ev1Box.y}, button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${ev1Box.x}, clientY: ${ev1Box.y + 96}, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${ev1Box.x}, clientY: ${ev1Box.y + 96} }));
  })()`);
  await wait(`document.querySelector('[data-calendar-timed-event="${rec1.id}"]')?.getAttribute('data-calendar-time-range') === '11:00–12:30'`);

  // Resize rec1 bottom edge down by +48px (+1h -> 11:00–13:30).
  const ev1ResizeBox = await run(`(() => {
    const el = document.querySelector('[data-calendar-event-resize="${rec1.id}"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await run(`(() => {
    const el = document.querySelector('[data-calendar-event-resize="${rec1.id}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${ev1ResizeBox.x}, clientY: ${ev1ResizeBox.y}, button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${ev1ResizeBox.x}, clientY: ${ev1ResizeBox.y + 48}, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${ev1ResizeBox.x}, clientY: ${ev1ResizeBox.y + 48} }));
  })()`);
  await wait(`document.querySelector('[data-calendar-timed-event="${rec1.id}"]')?.getAttribute('data-calendar-time-range') === '11:00–13:30'`);

  // Click empty 16:00 slot to create a new hourly record (16:00–17:00)!
  await run(`document.querySelector('[data-calendar-slot="${todayKey}:16"]').click()`);
  await wait(`document.querySelectorAll('[data-calendar-timed-event]').length === 3`);

  await assertNoOverflow("desktop-calendar-hourly");
  await screenshot("base-calendar-hourly-desktop.png");

  // Undo the click-created hourly event -> back to 2 timed events!
  await run(`document.querySelector('[data-base-undo]').click()`);
  await wait(`document.querySelectorAll('[data-calendar-timed-event]').length === 2`);

  // 5. Gantt View Real Pointer Resize + Move + Undo!
  await run(`document.querySelector('[data-view-tab="gantt"]').click()`);
  await wait(`!!document.querySelector('[data-gantt-bar="${rec3.id}"]')`);

  const ganttTimelinePx = await run(`(() => {
    const tl = document.querySelector('[data-gantt-timeline="${rec3.id}"]');
    const daysCount = tl.querySelectorAll('[data-gantt-day]').length;
    return tl.getBoundingClientRect().width / daysCount;
  })()`);

  // Drag right resize handle rightward by +3 days (10..16 -> 10..19).
  const resizeRightBox = await run(`(() => {
    const el = document.querySelector('[data-gantt-resize-right="${rec3.id}"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const dx3 = Math.round(ganttTimelinePx * 3);
  await run(`(() => {
    const el = document.querySelector('[data-gantt-resize-right="${rec3.id}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${resizeRightBox.x}, clientY: ${resizeRightBox.y}, button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${resizeRightBox.x + dx3}, clientY: ${resizeRightBox.y}, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${resizeRightBox.x + dx3}, clientY: ${resizeRightBox.y} }));
  })()`);
  const expectedResizedRange = `${y}-${m}-10 – ${y}-${m}-19`;
  await wait(`document.querySelector('[data-gantt-bar="${rec3.id}"]')?.getAttribute('data-gantt-range') === ${JSON.stringify(expectedResizedRange)}`);

  // Drag bar body leftward by -2 days (10..19 -> 08..17).
  const barBox = await run(`(() => {
    const el = document.querySelector('[data-gantt-bar="${rec3.id}"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const dxNeg2 = Math.round(ganttTimelinePx * -2);
  await run(`(() => {
    const el = document.querySelector('[data-gantt-bar="${rec3.id}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${barBox.x}, clientY: ${barBox.y}, button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${barBox.x + dxNeg2}, clientY: ${barBox.y}, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ${barBox.x + dxNeg2}, clientY: ${barBox.y} }));
  })()`);
  const expectedMovedRange = `${y}-${m}-08 – ${y}-${m}-17`;
  await wait(`document.querySelector('[data-gantt-bar="${rec3.id}"]')?.getAttribute('data-gantt-range') === ${JSON.stringify(expectedMovedRange)}`);

  await assertNoOverflow("desktop-gantt");
  await screenshot("base-gantt-drag-desktop.png");

  // Undo Gantt move -> snaps cleanly back to 10..19!
  await run(`document.querySelector('[data-base-undo]').click()`);
  await wait(`document.querySelector('[data-gantt-bar="${rec3.id}"]')?.getAttribute('data-gantt-range') === ${JSON.stringify(expectedResizedRange)}`);

  // 6. Reload and confirm PostgreSQL persistence of Gantt bar, Calendar hourly schedule, and restored field!
  await send("Page.reload", { ignoreCache: true });
  await wait(`document.body.innerText.includes('架构组全员')`);
  await run(`document.querySelector('[data-view-tab="gantt"]').click()`);
  await wait(`document.querySelector('[data-gantt-bar="${rec3.id}"]')?.getAttribute('data-gantt-range') === ${JSON.stringify(expectedResizedRange)}`);

  // 7. Mobile 390x844 responsive checks!
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 300));
  await assertNoOverflow("mobile-390-gantt");
  await screenshot("base-gantt-mobile.png");

  await run(`document.querySelector('[data-view-tab="calendar"]').click()`);
  await wait(`!!document.querySelector('[data-calendar]')`);
  await run(`document.querySelector('[data-calendar-scale-btn="day"]').click()`);
  await wait(`document.querySelector('[data-calendar-timed-event="${rec1.id}"]')?.getAttribute('data-calendar-time-range') === '11:00–13:30'`);
  await assertNoOverflow("mobile-390-calendar-day");
  await screenshot("base-calendar-mobile.png");

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(`Browser errors detected: console=${JSON.stringify(consoleErrors)} page=${JSON.stringify(pageErrors)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    baseId,
    rec1Range: "11:00–13:30",
    ganttPersistedRange: expectedResizedRange,
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
  }, null, 2));
} finally {
  ws.close();
  await bSend("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  browserWs.close();
}
