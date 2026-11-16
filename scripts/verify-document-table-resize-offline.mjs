import fs from 'node:fs/promises';
import path from 'node:path';

// Only disposable local services and an isolated Chrome may be used.
const base = process.env.JIANGE_TABLE_TEST_URL, cdp = process.env.JIANGE_TABLE_CDP_URL, fixture = process.env.JIANGE_DOCX_FIXTURE;
if (!base || !cdp || !fixture || ![base, cdp].every((value) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname))) throw new Error('Set local JIANGE_TABLE_TEST_URL, JIANGE_TABLE_CDP_URL and JIANGE_DOCX_FIXTURE');
const output = process.env.JIANGE_TABLE_SCREENSHOT_DIR || process.cwd(); await fs.mkdir(output, { recursive: true });
async function connect(url) {
  const target = await (await fetch(new URL('/json/new?about:blank', cdp), { method: 'PUT' })).json(), ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0; const requests = new Map();
  ws.onmessage = (event) => { const message = JSON.parse(event.data), request = requests.get(message.id); if (!request) return; requests.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; requests.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const run = async (expression) => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const wait = async (expression) => { for (let i = 0; i < 250; i++) { if (await run(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('Timed out: ' + expression + ': ' + (await run('document.body.innerText')).slice(0, 700)); };
  const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(output, name), Buffer.from(data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable'); await send('Page.navigate', { url });
  return { send, run, wait, shot, ws };
}
const a = await connect(new URL('/', base).href); await a.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await a.wait('document.readyState === "complete"');
const id = await a.run(`(async()=>{const req=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw Error(p+' '+r.status);return r.json()};await req('/api/auth/register',{email:'resize-${Date.now()}@example.test',name:'小简',password:'isolated-test-only'});return (await req('/api/docs',{title:'列宽离线验证'})).id})()`);
await a.send('Page.navigate', { url: new URL(`/#/doc/${id}`, base).href }); await new Promise((resolve) => setTimeout(resolve, 500)); await a.send('Page.reload'); await new Promise((resolve) => setTimeout(resolve, 500)); await a.wait(`location.hash==="#/doc/${id}" && !!document.querySelector('[data-status=synced]') && !!document.querySelector('[data-more-menu]')`);
await a.run(`document.querySelector('[data-more-menu]').click()`); await a.wait(`!!document.querySelector('[data-import-docx] input')`); const { root } = await a.send('DOM.getDocument'); const { nodeId } = await a.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-import-docx] input' }); await a.send('DOM.setFileInputFiles', { nodeId, files: [fixture] }); await a.wait('document.querySelectorAll("[data-table-block]").length===2 && !!document.querySelector("[data-status=synced]")');


await a.send('Page.bringToFront');await a.send('Network.enable');await a.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await a.run('window.dispatchEvent(new Event("offline"))');await a.wait('!!document.querySelector("[data-status=offline]")');
const has=await a.run(`!!document.querySelectorAll('[data-table-block]')[1]?.querySelector('[data-table-resize="0"]')`);if(!has){console.log('offline resize unavailable after access revalidation:',(await a.run('document.body.innerText')).slice(0,450));await a.send('Page.close');a.ws.close();process.exit(2)}
await a.run(`document.querySelectorAll('[data-table-block]')[1].querySelector('[data-table-resize="0"]').focus()`);await a.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await a.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await a.wait(`parseFloat(document.querySelectorAll('[data-table-block]')[1].querySelector('col').style.width)===150`);await a.shot('jiange-document-table-resize-offline-20261116.png');await a.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await a.run('window.dispatchEvent(new Event("online"))');await a.wait('!!document.querySelector("[data-status=synced]")');await a.send('Page.reload');await new Promise(r=>setTimeout(r,500));await a.wait(`parseFloat(document.querySelectorAll('[data-table-block]')[1].querySelector('col').style.width)===150`);console.log('offline resize queued and synchronized');await a.send('Page.close');a.ws.close();
