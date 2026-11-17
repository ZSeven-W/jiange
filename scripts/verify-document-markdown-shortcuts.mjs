import fs from "node:fs/promises";
import path from "node:path";

// Creates a throwaway account and document on local disposable services.
const app = process.env.JIANGE_MARKDOWN_TEST_URL, cdp = process.env.JIANGE_MARKDOWN_CDP_URL;
if (!app || !cdp || ![app, cdp].every((value) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname))) throw new Error("Set local disposable JIANGE_MARKDOWN_TEST_URL and JIANGE_MARKDOWN_CDP_URL");
const out = process.env.JIANGE_MARKDOWN_SCREENSHOT_DIR || process.cwd(); await fs.mkdir(out, { recursive: true });
const page = await (await fetch(new URL("/json/new?about:blank", cdp), { method: "PUT" })).json(), ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); let seq = 0; const jobs = new Map();
ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (!msg.id) return; const job = jobs.get(msg.id); jobs.delete(msg.id); msg.error ? job.reject(msg.error) : job.resolve(msg.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; jobs.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const wait = async (expression) => { for (let i = 0; i < 250; i++) { if (await run(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timeout ${expression}: ${(await run("document.body.innerText")).slice(0, 1000)}`); };
const shot = async (name) => { const { data } = await send("Page.captureScreenshot", { format: "png" }); await fs.writeFile(path.join(out, name), Buffer.from(data, "base64")); };
const type = async (text) => { for (const ch of text) await send("Input.insertText", { text: ch }); };
const enter = async () => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }); };
await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await send("Page.navigate", { url: new URL("/", app).href }); await wait('document.readyState === "complete"');
const id = await run(`(async()=>{const req=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw Error(p+' '+r.status);return r.json()};await req('/api/auth/register',{email:'markdown-${Date.now()}@example.test',name:'小简',password:'isolated-test-only'});return (await req('/api/docs',{title:'Markdown 快捷输入'})).id})()`);
await send("Page.navigate", { url: new URL(`/#/doc/${id}`, app).href }); await new Promise((resolve) => setTimeout(resolve, 400)); await send("Page.reload"); await new Promise((resolve) => setTimeout(resolve, 500));
await wait('!!document.querySelector("[data-editor]") && !!document.querySelector("[data-status=synced]") && !!document.querySelector("[aria-label=隐藏文档引用]")');
await run(`document.querySelector('[aria-label=隐藏文档引用]').click()`); await wait('!!document.querySelector("[role=dialog][aria-labelledby=reference-hide-title]")');
await run(`[...document.querySelector('[role=dialog][aria-labelledby=reference-hide-title]').querySelectorAll('button')].find(button=>button.textContent==='隐藏').click()`); await wait('!document.querySelector("[data-document-references]")');
await run(`(()=>{const e=document.querySelector('[data-type=paragraph] [data-text]');document.querySelector('[data-editor]').focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'))})()`);
await type('**粗体**'); await wait(`document.querySelector('[data-editor]').textContent.includes('**粗体**')`); await shot('jiange-markdown-before-space-20261117.png');
await type(' '); await wait(`document.querySelector('[data-editor]').textContent.includes('粗体') && !document.querySelector('[data-editor]').textContent.includes('**粗体**')`); await type('后续普通文字'); await enter();
await type('*斜体* '); await type('后续普通文字'); await enter();
await type('~下划线~ '); await type('后续普通文字'); await enter();
await type('~~删除线~~ '); await type('后续普通文字'); await enter();
await type('`行内代码`'); await type(' 后续普通文字'); await enter();
await type('$$E=mc^2$$'); await type(' 后续普通文字');
await wait(`document.querySelector('[data-editor]').textContent.includes('后续普通文字') && !!document.querySelector('[data-inline-math]')`);
const details = await run(`Array.from(document.querySelectorAll('[data-editor] [data-type=paragraph] [data-text]')).map(e=>({text:e.innerText,markup:e.innerHTML}))`);
const expected = [["粗体", "font-semibold"], ["斜体", "italic"], ["下划线", "underline"], ["删除线", "line-through"], ["行内代码", "font-mono"], ["E=mc", "data-inline-math"]];
for (let i = 0; i < expected.length; i++) {
  if (!details[i]?.text.includes(expected[i][0]) || !details[i]?.markup.includes(expected[i][1]) || !details[i]?.markup.includes("<span> 后续普通文字</span>")) throw new Error(`Shortcut ${i} or following text is wrong: ${JSON.stringify(details[i])}`);
}
await shot('jiange-markdown-result-desktop-20261117.png');
const peer = await (await fetch(new URL(`/json/new?${encodeURIComponent(new URL(`/#/doc/${id}`, app).href)}`, cdp), { method: "PUT" })).json();
const peerWs = new WebSocket(peer.webSocketDebuggerUrl); await new Promise((resolve, reject) => { peerWs.onopen = resolve; peerWs.onerror = reject; });
let peerSeq = 0; const peerJobs = new Map(); peerWs.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id) return; const job = peerJobs.get(m.id); peerJobs.delete(m.id); m.error ? job.reject(m.error) : job.resolve(m.result); };
const peerSend = (method, params = {}) => new Promise((resolve, reject) => { const n = ++peerSeq; peerJobs.set(n, { resolve, reject }); peerWs.send(JSON.stringify({ id: n, method, params })); });
let peerReady = false;
for (let i = 0; i < 250; i++) { const r = await peerSend("Runtime.evaluate", { expression: `!!document.querySelector('[data-inline-math]') && [...document.querySelectorAll('[data-editor] .underline')].some(e=>e.textContent==='下划线')`, returnByValue: true }); if (r.result.value) { peerReady = true; break; } await new Promise((resolve) => setTimeout(resolve, 100)); }
if (!peerReady) throw new Error("Second collaborative page did not render the formatting");
await peerSend("Page.close"); peerWs.close();
await wait('!!document.querySelector("[data-status=synced]")'); await send('Page.reload'); await new Promise((resolve) => setTimeout(resolve, 500)); await wait(`document.querySelector('[data-editor]')?.textContent.includes('下划线') && !!document.querySelector('[data-inline-math]')`);
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await new Promise((resolve) => setTimeout(resolve, 300)); await shot('jiange-markdown-result-mobile-20261117.png');
const undoDoc = await run(`(async()=>{const r=await fetch('/api/docs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Markdown 撤销验证'})});return (await r.json()).id})()`);
await send('Page.navigate', { url: new URL(`/#/doc/${undoDoc}`, app).href }); await new Promise((resolve) => setTimeout(resolve, 500)); await wait('!!document.querySelector("[data-editor]") && !!document.querySelector("[data-status=synced]")');
await run(`(()=>{const e=document.querySelector('[data-type=paragraph] [data-text]');document.querySelector('[data-editor]').focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'))})()`);
await type('**验证**'); await type(' '); await wait(`!![...document.querySelectorAll('[data-editor] .font-semibold')].find(e=>e.textContent==='验证')`);
const shortcut = async (modifiers) => { await send('Input.dispatchKeyEvent', { type:'keyDown', key:'z', code:'KeyZ', windowsVirtualKeyCode:90, nativeVirtualKeyCode:90, modifiers }); await send('Input.dispatchKeyEvent', { type:'keyUp', key:'z', code:'KeyZ', windowsVirtualKeyCode:90, nativeVirtualKeyCode:90, modifiers }); };
await shortcut(4); await wait(`document.querySelector('[data-editor]').textContent.includes('**验证**')`);
await shortcut(12); await wait(`!![...document.querySelectorAll('[data-editor] .font-semibold')].find(e=>e.textContent==='验证')`);
console.log('typed shortcuts, second collaborative page, reload and undo/redo completed'); await send('Page.close'); ws.close();
