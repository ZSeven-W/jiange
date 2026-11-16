import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// This test changes a database epoch: require loopback services and a labelled disposable container.
const base = process.env.JIANGE_EPOCH_TEST_URL, cdp = process.env.JIANGE_EPOCH_CDP_URL, container = process.env.JIANGE_EPOCH_TEST_CONTAINER;
if (!base || !cdp || !container || ![base, cdp].every((url) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) || !/^jiange-epoch-[a-z0-9-]+$/.test(container)) throw new Error('Set isolated loopback services and labelled JIANGE_EPOCH_TEST_CONTAINER');
const label = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "io.jiange.visual-test"}}', container], { encoding: 'utf8' }).trim();
if (label !== 'epoch-quarantine-v1') throw new Error('Database container is not labelled as disposable');
const output = process.env.JIANGE_EPOCH_SCREENSHOT_DIR || process.cwd(), downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'jiange-epoch-download-')); await fs.mkdir(output, { recursive: true });
async function connect(url) {
  const target = await (await fetch(new URL('/json/new?about:blank', cdp), { method: 'PUT' })).json(), ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); let serial = 0; const jobs = new Map();
  ws.onmessage = (event) => { const message = JSON.parse(event.data), job = jobs.get(message.id); if (!job) return; jobs.delete(message.id); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; jobs.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const run = async (expression) => { const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result.value; };
  const wait = async (expression) => { for (let i = 0; i < 250; i++) { if (await run(expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('Timed out: ' + expression + ': ' + (await run('document.body.innerText')).slice(0, 600)); };
  const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(output, name), Buffer.from(data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable'); await send('Page.navigate', { url }); return { send, run, wait, shot, ws };
}
const a = await connect(new URL('/', base).href); await a.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await a.wait('document.readyState==="complete"');
const identity = await a.run(`(async()=>{const req=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)throw Error(p+' '+r.status);return r.json()};const me=await req('/api/auth/register',{email:'epoch-${Date.now()}@example.test',name:'小简',password:'isolated-test-only'});const doc=await req('/api/docs',{title:'同代离线草稿恢复'});return {user:me.user.id,doc:doc.id}})()`);
if (![identity.user, identity.doc].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid local identity');
const sql = (query) => execFileSync('docker', ['exec', container, 'psql', '-X', '-q', '-A', '-t', '-U', 'jiange', '-d', 'jiange_visual', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim();
await a.send('Page.navigate', { url: new URL(`/#/doc/${identity.doc}`, base).href }); await new Promise(r => setTimeout(r, 500)); await a.send('Page.reload'); await new Promise(r => setTimeout(r, 500)); await a.wait(`location.hash==="#/doc/${identity.doc}" && !!document.querySelector('[data-editor]') && !!document.querySelector('[data-status=synced]')`);
const focusEnd = () => a.run(`(()=>{const e=document.querySelector('[data-type="paragraph"] [data-text]'), root=document.querySelector('[data-editor]');root.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'))})()`);
await focusEnd(); await a.send('Input.insertText', { text: '云端正文' }); await a.wait('document.body.innerText.includes("云端正文") && !!document.querySelector("[data-status=synced]")');

await a.send('Network.enable');await a.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await a.run('window.dispatchEvent(new Event("offline"))');await a.wait('!!document.querySelector("[data-status=offline]")');await focusEnd();await a.send('Input.insertText',{text:'离线可同步'});await a.wait(`Object.keys(localStorage).some(k=>k.startsWith('jiange:pending:v3:${identity.user}:${identity.doc}:') && localStorage.getItem(k).includes('离线可同步') && JSON.parse(localStorage.getItem(k)).historyEpoch===1)`);await a.send('Page.close');a.ws.close();await new Promise(r=>setTimeout(r,250));
const b=await connect(new URL('/',base).href);await b.wait('document.readyState==="complete" && location.origin==='+JSON.stringify(new URL(base).origin));await b.wait(`(async()=>!(await navigator.locks.query()).held.some(x=>x.name.startsWith('jiange:pending:v3:${identity.user}:${identity.doc}:')))()`);await b.send('Page.navigate',{url:new URL(`/#/doc/${identity.doc}`,base).href});await b.wait('document.body.innerText.includes("云端正文离线可同步") && !!document.querySelector("[data-status=synced]")');if(await b.run('!!document.querySelector("[data-status=blocked]")'))throw Error('same epoch draft incorrectly quarantined');await b.send('Page.reload');await new Promise(r=>setTimeout(r,500));await b.wait('document.body.innerText.includes("云端正文离线可同步") && !!document.querySelector("[data-status=synced]")');console.log('same-epoch draft survived offline close and synchronized');await b.send('Page.close');b.ws.close();
