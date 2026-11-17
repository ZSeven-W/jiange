import fs from "node:fs/promises";
import path from "node:path";

// This creates throwaway accounts and documents. Point it only at disposable services.
const appUrl = process.env.JIANGE_TITLE_TEST_URL, cdpUrl = process.env.JIANGE_TITLE_CDP_URL;
if (!appUrl || !cdpUrl || ![appUrl, cdpUrl].every((value) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname))) throw new Error("Set local disposable JIANGE_TITLE_TEST_URL and JIANGE_TITLE_CDP_URL");
const out = process.env.JIANGE_TITLE_SCREENSHOT_DIR || process.cwd();
await fs.mkdir(out, { recursive: true });
async function browser() {
  const page = await (await fetch(new URL("/json/new?about:blank", cdpUrl), { method: "PUT" })).json(), ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0; const pending = new Map();
  ws.onmessage = (event) => { const message = JSON.parse(event.data); if (!message.id) return; const job = pending.get(message.id); pending.delete(message.id); message.error ? job.reject(message.error) : job.resolve(message.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const run = async (expression) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const wait = async (expression) => { for (let i = 0; i < 250; i++) { if (await run(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timeout: ${expression}\n${(await run("document.body.innerText")).slice(0, 500)}`); };
  const screenshot = async (name) => { const { data } = await send("Page.captureScreenshot", { format: "png" }); await fs.writeFile(path.join(out, name), Buffer.from(data, "base64")); };
  await send("Page.enable"); await send("Runtime.enable"); return { send, run, wait, screenshot, ws };
}
async function scenario(mobile) {
  const page = await browser();
  await page.send("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1440, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile });
  await page.send("Page.navigate", { url: new URL("/", appUrl).href }); await page.wait('document.readyState === "complete"');
  const id = await page.run(`(async()=>{const req=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw Error(p+' '+r.status);return r.json()};await req('/api/auth/register',{email:'title-recovery-${Date.now()}-${mobile}@example.test',name:'小简',password:'isolated-test-only'});return (await req('/api/docs',{title:'原有文档标题'})).id})()`);
  await page.send("Page.navigate", { url: new URL(`/#/doc/${id}`, appUrl).href }); await new Promise((resolve) => setTimeout(resolve, 400)); await page.send("Page.reload"); await new Promise((resolve) => setTimeout(resolve, 500));
  await page.wait('!!document.querySelector("[data-status=synced]") && !!document.querySelector("textarea[placeholder=请输入标题]")');
  await page.run(`window.__originalFetch=window.fetch;window.fetch=(input,init)=>String(input).includes('/title-consistency') && init?.method==='POST' ? new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})) : window.__originalFetch(input,init)`);
  await page.run('document.querySelector("textarea[placeholder=请输入标题]").select()');
  await page.send("Input.insertText", { text: mobile ? "手机刷新后的标题" : "刷新后恢复的文档标题" });
  const expected = mobile ? "手机刷新后的标题" : "刷新后恢复的文档标题";
  await page.wait(`Array.from({length:sessionStorage.length},(_,i)=>sessionStorage.key(i)).some(k=>k.startsWith('jiange:title-sync:v1:') && JSON.parse(sessionStorage.getItem(k)).pending.target===${JSON.stringify(expected)} && !!JSON.parse(sessionStorage.getItem(k)).pending.uncertain)`);
  await page.wait(`(async()=> (await (await fetch('/api/docs/${id}/title-consistency')).json()).documentTitle===${JSON.stringify(expected)})()`);
  const before = await page.run(`(async()=>await (await fetch('/api/docs/${id}/title-consistency')).json())()`);
  if (before.directoryTitle !== "原有文档标题") throw new Error("Directory changed before the simulated interruption");
  await page.screenshot(`jiange-title-recovery-${mobile ? "mobile" : "desktop"}-before-20261117.png`);
  await page.send("Page.reload"); await new Promise((resolve) => setTimeout(resolve, 500));
  await page.wait(`document.querySelector('textarea[placeholder=请输入标题]')?.value===${JSON.stringify(expected)}`);
  await page.wait(`(async()=> (await (await fetch('/api/docs/${id}/title-consistency')).json()).directoryTitle===${JSON.stringify(expected)})()`);
  await page.wait(`!Array.from({length:sessionStorage.length},(_,i)=>sessionStorage.key(i)).some(k=>k.startsWith('jiange:title-sync:v1:') && k.endsWith(':${id}'))`);
  await page.screenshot(`jiange-title-recovery-${mobile ? "mobile" : "desktop"}-after-20261117.png`);
  console.log(`${mobile ? "mobile" : "desktop"}: document title, recovered directory title and cleared intent verified`);
  await page.send("Page.close"); page.ws.close();
}
await scenario(false); await scenario(true);
