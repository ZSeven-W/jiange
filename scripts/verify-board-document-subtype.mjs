import fs from "node:fs/promises";
import path from "node:path";

// Uses a throwaway account and documents on local disposable servers.
const app = process.env.JIANGE_BOARD_TEST_URL;
const cdp = process.env.JIANGE_BOARD_CDP_URL;
if (!app || !cdp || ![app, cdp].every((url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))) {
  throw new Error("Set local disposable JIANGE_BOARD_TEST_URL and JIANGE_BOARD_CDP_URL");
}
const out = process.env.JIANGE_BOARD_SCREENSHOT_DIR || process.cwd();
await fs.mkdir(out, { recursive: true });

const target = await (await fetch(new URL("/json/new?about:blank", cdp), { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const jobs = new Map();
ws.onmessage = (event) => {
  const item = JSON.parse(event.data);
  if (!item.id) return;
  const job = jobs.get(item.id);
  jobs.delete(item.id);
  item.error ? job.reject(item.error) : job.resolve(item.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  jobs.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const run = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result.value;
};
const wait = async (expression) => {
  for (let i = 0; i < 250; i++) {
    try {
      if (await run(expression)) return;
    } catch (err) {
      if (err?.code !== -32000) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for: ${expression}\nBody: ${(await run("document.body.innerText")).slice(0, 800)}`);
};
const screenshot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, name), Buffer.from(data, "base64"));
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: new URL("/", app).href });
await wait('document.readyState === "complete"');

const email = `board-${Date.now()}@example.test`;
await run(`(async()=>{
  const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(email)},name:'小简',password:'isolated-test-only'})});
  if(!r.ok)throw Error('register '+r.status);
})()`);
await send("Page.reload");
await new Promise((resolve) => setTimeout(resolve, 500));
await wait('!![...document.querySelectorAll("button")].find(b=>b.textContent.includes("新建"))');

// 1. Create a board from Home -> opens full-screen board editor -> verify docType === "board".
await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('新建') && b.getAttribute('aria-haspopup')==='menu').click()`);
await wait('!!document.querySelector("[data-new-board]")');
await run(`document.querySelector("[data-new-board]").click()`);
await wait('location.hash.startsWith("#/doc/") && !!document.querySelector("[data-flow-editor]")');
const homeBoardId = Number(await run(`location.hash.match(/^#\\/doc\\/(\\d+)/)?.[1] || 0`));
if (!homeBoardId) throw new Error("Failed to navigate to created board doc");
await run(`document.querySelector("[data-flow-done]").click()`);
await wait('!document.querySelector("[data-flow-editor]") && !!document.querySelector("[data-status=synced]")');
const homeBoardMeta = await run(`fetch('/api/docs/${homeBoardId}').then(r=>r.json())`);
if (homeBoardMeta.docType !== "board") throw new Error(`Expected board docType, got ${JSON.stringify(homeBoardMeta)}`);
const hasHeaderBoardIcon = await run(`!!document.querySelector("header svg.text-\\\\[\\\\#34c759\\\\]")`);
if (!hasHeaderBoardIcon) throw new Error("Document header did not render board icon");

// 2. Create a plain document, verify sidebar icons, return to Home, verify list + card icons and filters.
await run(`fetch('/api/docs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'产品周报'})}).then(r=>{if(!r.ok)throw Error(r.status)})`);
await run(`location.hash = "#/"`);
await wait('!![...document.querySelectorAll("nav button")].find(b=>b.textContent==="我创建的")');
await run(`[...document.querySelectorAll('nav button')].find(b=>b.textContent==='我创建的').click()`);
await wait('document.querySelectorAll("[data-home-row]").length >= 2');
const sidebarIconsOk = await run(`(()=>{
  const items=[...document.querySelectorAll('aside [data-tree-depth]')];
  const boardItem=items.find(el=>el.textContent.includes('未命名画板'));
  const docItem=items.find(el=>el.textContent.includes('产品周报'));
  return !!boardItem?.querySelector('svg.text-\\\\[\\\\#34c759\\\\]') && !!docItem && !docItem.querySelector('svg.text-\\\\[\\\\#34c759\\\\]');
})()`);
if (!sidebarIconsOk) throw new Error("Sidebar did not distinguish board vs plain doc icons");
const listIconsOk = await run(`(()=>{
  const rows=[...document.querySelectorAll('[data-home-row]')];
  const boardRow=rows.find(r=>r.textContent.includes('未命名画板'));
  const docRow=rows.find(r=>r.textContent.includes('产品周报'));
  return !!boardRow?.querySelector('svg.text-\\\\[\\\\#34c759\\\\]') && !!docRow && !docRow.querySelector('svg.text-\\\\[\\\\#34c759\\\\]');
})()`);
if (!listIconsOk) throw new Error("Home list rows did not distinguish board vs plain doc icons");

await run(`document.querySelector('button[aria-label="卡片视图"]').click()`);
await wait('document.querySelectorAll("[data-home-card]").length >= 2');
await screenshot("jiange-board-subtype-home-desktop-20261118.png");

// 3. Test Home TypeFilter ("board" vs "doc") and Global Search filter ("board").
await run(`(()=>{
  const sel=document.querySelector('select');
  const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  set.call(sel,'board');
  sel.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
await wait('document.querySelectorAll("[data-home-card]").length === 1 && document.querySelector("[data-home-card]").textContent.includes("未命名画板")');

await run(`(()=>{
  const sel=document.querySelector('select');
  const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  set.call(sel,'doc');
  sel.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
await wait('document.querySelectorAll("[data-home-card]").length === 1 && document.querySelector("[data-home-card]").textContent.includes("产品周报")');

await run(`document.querySelector("[data-search]").click()`);
await wait('!!document.querySelector("[role=dialog][aria-label=全局搜索]")');
await run(`[...document.querySelector("[role=dialog][aria-label=全局搜索]").querySelectorAll("button")].find(b=>b.textContent.includes("高级搜索")).click()`);
await wait('!!document.querySelector("[aria-label=文档类型筛选]")');
await run(`(()=>{
  const sel=document.querySelector('[aria-label="文档类型筛选"]');
  const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  set.call(sel,'board');
  sel.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
await wait('document.querySelector("[role=listbox]").textContent.includes("未命名画板") && !document.querySelector("[role=listbox]").textContent.includes("产品周报")');
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await new Promise((resolve) => setTimeout(resolve, 250));
await screenshot("jiange-board-subtype-filter-mobile-20261118.png");
await run(`document.querySelector('[aria-label="关闭搜索"]').click()`);
await wait('!document.querySelector("[role=dialog][aria-label=全局搜索]")');

// 4. Duplicate board on Home, verify copy preserves docType === "board".
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await run(`(()=>{
  const sel=document.querySelector('select');
  const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  set.call(sel,'all');
  sel.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
await wait('!!document.querySelector("[aria-label=\\"未命名画板 更多操作\\"]")');
await run(`document.querySelector('[aria-label="未命名画板 更多操作"]').click()`);
await wait('!![...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.includes("创建副本"))');
await run(`[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes('创建副本')).click()`);
await wait('document.body.innerText.includes("副本已创建")');
const duplicatedMeta = await run(`fetch('/api/docs').then(r=>r.json()).then(d=>d.docs.find(item=>item.title==='未命名画板 副本'))`);
if (!duplicatedMeta || duplicatedMeta.docType !== "board") {
  throw new Error(`Duplicated board missing docType: ${JSON.stringify(duplicatedMeta)}`);
}

// 5. Create board in Drive -> rename -> trash -> verify Trash badge -> restore.
await run(`location.hash = "#/drive/mine"`);
await wait('!!document.querySelector("[data-drive-page]")');
await run(`[...document.querySelectorAll('[data-drive-page] button')].find(b=>b.textContent.includes('新建') && b.hasAttribute('aria-expanded')).click()`);
await wait('!!document.querySelector("[data-new-kind=board]")');
await run(`document.querySelector("[data-new-kind=board]").click()`);
await wait('!!document.querySelector("[data-ask-input]")');
await run(`(()=>{
  const input=document.querySelector('[data-ask-input]');
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  set.call(input,'研发画板');
  input.dispatchEvent(new Event('input',{bubbles:true}));
})()`);
await run(`[...document.querySelector('[data-ask]').querySelectorAll('button')].find(b=>b.textContent==='确定').click()`);
await wait(`location.hash.startsWith("#/doc/") && !location.hash.endsWith("/${homeBoardId}") && !!document.querySelector("[data-flow-editor]")`);
const driveBoardId = Number(await run(`location.hash.match(/^#\\/doc\\/(\\d+)/)?.[1] || 0`));
await run(`document.querySelector("[data-flow-done]").click()`);
await wait('!document.querySelector("[data-flow-editor]")');

await run(`location.hash = "#/drive/mine"`);
await wait(`!!document.querySelector('[data-drive-row="${driveBoardId}"]')`);
await run(`document.querySelector('[aria-label="研发画板更多操作"]').click()`);
await wait(`!![...document.querySelectorAll('[data-drive-row="${driveBoardId}"] button')].find(b=>b.textContent==="重命名")`);
await run(`[...document.querySelectorAll('[data-drive-row="${driveBoardId}"] button')].find(b=>b.textContent==='重命名').click()`);
await wait('!!document.querySelector("[data-ask-input]")');
await run(`(()=>{
  const input=document.querySelector('[data-ask-input]');
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  set.call(input,'研发架构画板');
  input.dispatchEvent(new Event('input',{bubbles:true}));
})()`);
await run(`[...document.querySelector('[data-ask]').querySelectorAll('button')].find(b=>b.textContent==='确定').click()`);
await wait(`document.querySelector('[data-drive-row="${driveBoardId}"]').textContent.includes('研发架构画板')`);
const renamedMeta = await run(`fetch('/api/docs/${driveBoardId}').then(r=>r.json())`);
if (renamedMeta.docType !== "board") throw new Error(`Renamed drive board lost docType: ${JSON.stringify(renamedMeta)}`);

await run(`document.querySelector('[aria-label="研发架构画板更多操作"]').click()`);
await wait(`!![...document.querySelectorAll('[data-drive-row="${driveBoardId}"] button')].find(b=>b.textContent==='移到回收站')`);
await run(`[...document.querySelectorAll('[data-drive-row="${driveBoardId}"] button')].find(b=>b.textContent==='移到回收站').click()`);
await wait('!!document.querySelector("[data-ask-ok]")');
await run(`document.querySelector("[data-ask-ok]").click()`);
await wait(`!document.querySelector('[data-drive-row="${driveBoardId}"]')`);

await run(`location.hash = "#/trash"`);
await wait(`!!document.querySelector('[data-trash-row="${driveBoardId}"]')`);
const trashOk = await run(`(()=>{
  const row=document.querySelector('[data-trash-row="${driveBoardId}"]');
  return !!row.querySelector('[data-board-tag]') && !!row.querySelector('svg.text-\\\\[\\\\#34c759\\\\]');
})()`);
if (!trashOk) throw new Error("Trash row missing board tag or icon");
await screenshot("jiange-board-subtype-drive-trash-20261118.png");

await run(`[...document.querySelectorAll('[data-trash-row="${driveBoardId}"] button')].find(b=>b.textContent==='还原').click()`);
await wait(`!document.querySelector('[data-trash-row="${driveBoardId}"]')`);
const restoredMeta = await run(`fetch('/api/docs/${driveBoardId}').then(r=>r.json())`);
if (restoredMeta.docType !== "board") throw new Error(`Restored drive board lost docType: ${JSON.stringify(restoredMeta)}`);

console.log(JSON.stringify({ homeBoardId, duplicatedCopyId: duplicatedMeta.id, driveBoardId, restoredDocType: restoredMeta.docType }));
await send("Page.close");
ws.close();
