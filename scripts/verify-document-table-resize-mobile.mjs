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
const id = await a.run(`(async()=>{const req=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw Error(p+' '+r.status);return r.json()};await req('/api/auth/register',{email:'resize-${Date.now()}@example.test',name:'小简',password:'isolated-test-only'});return (await req('/api/docs',{title:'手机调整表格列宽'})).id})()`);
await a.send('Page.navigate', { url: new URL(`/#/doc/${id}`, base).href }); await new Promise((resolve) => setTimeout(resolve, 500)); await a.send('Page.reload'); await new Promise((resolve) => setTimeout(resolve, 500)); await a.wait(`location.hash==="#/doc/${id}" && !!document.querySelector('[data-status=synced]') && !!document.querySelector('[data-more-menu]')`);
await a.run(`document.querySelector('[data-more-menu]').click()`); await a.wait(`!!document.querySelector('[data-import-docx] input')`); const { root } = await a.send('DOM.getDocument'); const { nodeId } = await a.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-import-docx] input' }); await a.send('DOM.setFileInputFiles', { nodeId, files: [fixture] }); await a.wait('document.querySelectorAll("[data-table-block]").length===2 && !!document.querySelector("[data-status=synced]")');

await a.send('Page.bringToFront'); await a.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await a.send('Emulation.setTouchEmulationEnabled', { enabled: true }); await new Promise((resolve) => setTimeout(resolve, 300));
const handle = await a.run(`(()=>{const r=document.querySelectorAll('[data-table-block]')[1].querySelector('[data-table-resize="0"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width}})()`);
if (handle.width < 16 || handle.x < 0 || handle.x > 390 || handle.y < 0 || handle.y > 844) throw Error('touch handle not usable: '+JSON.stringify(handle));
const touch = (type, x) => a.send('Input.dispatchTouchEvent', { type, touchPoints: (type === 'touchEnd' || type === 'touchCancel') ? [] : [{ x, y: handle.y, id: 0, radiusX: 2, radiusY: 2, force: 1 }] });
await touch('touchStart',handle.x); await touch('touchMove',handle.x+20); await a.wait(`parseFloat(document.querySelectorAll('[data-table-block]')[1].querySelector('col').style.width)===160`); await touch('touchCancel',handle.x+20); await a.wait(`parseFloat(document.querySelectorAll('[data-table-block]')[1].querySelector('col').style.width)===140`); await touch('touchStart',handle.x); await touch('touchMove',handle.x+30); await a.wait(`parseFloat(document.querySelectorAll('[data-table-block]')[1].querySelector('col').style.width)===170`); await a.shot('jiange-document-table-resize-mobile-clean-20261116.png'); await touch('touchEnd',handle.x+30); await a.wait('!!document.querySelector("[data-status=synced]")'); await a.send('Page.reload'); await new Promise((resolve)=>setTimeout(resolve,500)); await a.wait(`parseFloat(document.querySelectorAll('[data-table-block]')[1].querySelector('col').style.width)===170`); console.log('isolated touch resize persisted'); await a.send('Page.close'); a.ws.close();
