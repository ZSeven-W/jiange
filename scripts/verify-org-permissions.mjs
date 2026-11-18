import fs from "node:fs/promises";
import path from "node:path";

const app = process.env.JIANGE_ORG_TEST_URL;
const cdp = process.env.JIANGE_ORG_CDP_URL;
if (!app || !cdp || ![app, cdp].every((url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))) {
  throw new Error("Set local disposable JIANGE_ORG_TEST_URL and JIANGE_ORG_CDP_URL");
}
const out = process.env.JIANGE_ORG_SCREENSHOT_DIR || process.cwd();
await fs.mkdir(out, { recursive: true });

const target = await (await fetch(new URL("/json/new?about:blank", cdp), { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const jobs = new Map();
ws.onmessage = (event) => {
  const item = JSON.parse(event.data);
  if (!item.id) return;
  const job = jobs.get(item.id);
  jobs.delete(item.id);
  item.error ? job.reject(item.error) : job.resolve(item.result);
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

const wait = async (expression) => {
  for (let i = 0; i < 200; i++) {
    try {
      if (await run(expression)) return;
    } catch (err) {
      if (err?.code !== -32000) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for: ${expression}\nBody: ${(await run("document.body.innerText")).slice(0, 800)}`);
};

const setInput = async (selector, value) => {
  await run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
};

const setSelect = async (selector, value) => {
  await run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing select: ' + ${JSON.stringify(selector)});
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
};

const submitPrompt = async (value) => {
  await wait(`!!document.querySelector('[data-ask] [data-ask-input]')`);
  await setInput("[data-ask] [data-ask-input]", value);
  await run(`(() => {
    const btns = [...document.querySelectorAll('[data-ask] button')];
    const ok = btns.find((b) => b.textContent.trim() === '确定');
    if (!ok) throw new Error('Missing ask OK button');
    ok.click();
  })()`);
  await wait(`!document.querySelector('[data-ask]')`);
};

const screenshot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const filePath = path.join(out, name);
  await fs.writeFile(filePath, Buffer.from(data, "base64"));
  return filePath;
};

const assertNoOverflow = async (label) => {
  const rect = await run(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`);
  if (rect.scrollWidth > rect.innerWidth) {
    throw new Error(`${label} horizontal overflow: scrollWidth=${rect.scrollWidth} > innerWidth=${rect.innerWidth}`);
  }
};

const registerAccount = async (email, name) => {
  const res = await fetch(`${app}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name, password: "password123" }),
  });
  if (!res.ok) throw new Error(`Register ${email} failed: ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { me: await res.json(), cookie };
};

// Joining requires consent: the invitee accepts their pending invitation.
const acceptInvitation = async (account) => {
  const list = await (await fetch(`${app}/api/invitations`, { headers: { Cookie: account.cookie } })).json();
  if (list.invitations?.length !== 1) throw new Error(`Expected 1 invitation, got ${JSON.stringify(list)}`);
  const res = await fetch(`${app}/api/invitations/${list.invitations[0].id}/accept`, { method: "POST", headers: { Cookie: account.cookie } });
  if (res.status !== 204) throw new Error(`Accept failed: ${res.status}`);
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${app}/` });
await wait(`!!document.querySelector('form')`);

// Pre-register Alice and Bob in isolated API calls, register Owner in the UI.
const suffix = Date.now();
const ownerEmail = `org-owner-${suffix}@example.test`;
const aliceEmail = `org-alice-${suffix}@example.test`;
const bobEmail = `org-bob-${suffix}@example.test`;
const aliceAccount = await registerAccount(aliceEmail, "Alice Dev");
const bobAccount = await registerAccount(bobEmail, "Bob Mkt");

await run(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('免费注册') || b.textContent.includes('注册'));
  if (btn) btn.click();
})()`);
await setInput('input[type="email"]', ownerEmail);
await run(`(() => {
  const nameInput = [...document.querySelectorAll('input')].find((el) => el.type !== 'email' && el.type !== 'password');
  if (nameInput) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(nameInput, 'Owner Admin');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
})()`);
await setInput('input[type="password"]', "password123");
await run(`document.querySelector('form button[type="submit"]').click()`);
await wait(`document.body.innerText.includes('主页') && document.body.innerText.includes('组织架构')`);

// Navigate to 组织架构
await run(`(() => {
  const nav = [...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes('组织架构'));
  if (!nav) throw new Error('Missing 组织架构 nav button');
  nav.click();
})()`);
await wait(`!!document.querySelector('[data-org-page]') && !!document.querySelector('[data-org-tab="members"]')`);

// Invite Alice and Bob to Owner's workspace
await wait(`!document.body.innerText.includes('正在加载组织架构')`);
await run(`document.querySelector('[data-org-tab="members"]').click()`);
await wait(`!!document.querySelector('[data-org-page] input[type="email"]')`);
for (const email of [aliceEmail, bobEmail]) {
  await setInput('[data-org-page] input[type="email"]', email);
  await run(`document.querySelector('[data-org-page] form button[type="submit"]').click()`);
  await wait(`document.body.innerText.includes('已发送邀请') && [...document.querySelectorAll('[data-org-invitation]')].some((el) => el.textContent.includes(${JSON.stringify(email)}))`);
}
await screenshot("org-invitations-desktop.png");
await acceptInvitation(aliceAccount);
await acceptInvitation(bobAccount);
// Reload so the owner's org snapshot shows Alice and Bob as members.
await send("Page.reload");
await wait(`!!document.querySelector('[data-org-tab="members"]') && !document.body.innerText.includes('正在加载组织架构')`);
await run(`document.querySelector('[data-org-tab="members"]').click()`);
await wait(`document.body.innerText.includes('Alice Dev') && document.body.innerText.includes('Bob Mkt') && !document.querySelector('[data-org-invitation]')`);

// Create department hierarchy: 研发中心 -> 前端组 (Alice leader) and 市场部 (Bob)
await run(`document.querySelector('[data-org-tab="departments"]').click()`);
await wait(`!!document.querySelector('[data-new-root-dept]')`);
await run(`document.querySelector('[data-new-root-dept]').click()`);
await submitPrompt("研发中心");
await wait(`document.body.innerText.includes('研发中心')`);

await run(`(() => {
  const btn = [...document.querySelectorAll('[data-org-page] button')].find((b) => b.textContent.includes('新建子部门'));
  if (!btn) throw new Error('Missing 新建子部门 button');
  btn.click();
})()`);
await submitPrompt("前端组");
await wait(`document.body.innerText.includes('前端组') && document.body.innerText.includes('向部门授权')`);

await run(`(() => {
  const chk = document.querySelector('[data-org-page] input[type="checkbox"]');
  if (chk && !chk.checked) chk.click();
})()`);
await run(`document.querySelector('[data-add-dept-member]').click()`);
await wait(`document.body.innerText.includes('已添加部门成员') && !document.querySelector('[data-new-root-dept]').disabled`);

// Add 市场部 and add Bob
await run(`document.querySelector('[data-new-root-dept]').click()`);
await submitPrompt("市场部");
await wait(`document.body.innerText.includes('市场部') && !document.querySelector('[data-new-root-dept]').disabled`);
await run(`(() => {
  const sel = document.querySelector('select[aria-label="选择部门成员"]');
  const opt = [...sel.options].find((o) => o.textContent.includes('Bob Mkt'));
  if (!opt) throw new Error('Missing Bob Mkt option');
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await run(`document.querySelector('[data-add-dept-member]').click()`);
await wait(`document.body.innerText.includes('已添加部门成员') && document.body.innerText.includes('移出')`);

// Select 前端组 again so tree & detail show full hierarchy cleanly for desktop screenshot
await run(`(() => {
  const btn = [...document.querySelectorAll('[data-org-dept-row] button')].find((b) => b.textContent.includes('前端组'));
  if (btn) btn.click();
})()`);
await wait(`document.body.innerText.includes('取消负责人')`);
await assertNoOverflow("org-desktop");
await screenshot("org-desktop.png");

// Simulated mobile viewport (390x844) on #/org
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await new Promise((r) => setTimeout(r, 250));
await assertNoOverflow("org-mobile");
await screenshot("org-mobile.png");

// Restore desktop 1440x900 and test restricted doc + department share
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
const docRes = await run(`(async () => {
  const r = await fetch('/api/drive/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'doc', title: 'Q4核心架构与薪酬方案', scope: 'shared' })
  });
  return r.json();
})()`);
const docId = docRes.id;
await send("Page.navigate", { url: `${app}/#/doc/${docId}` });
await wait(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '分享' || b.getAttribute('aria-label') === '分享');
  return document.body.innerText.includes('Q4核心架构与薪酬方案') && !!btn && !btn.disabled;
})()`);
await run(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '分享' || b.getAttribute('aria-label') === '分享');
  if (!btn) throw new Error('Missing share button');
  btn.click();
})()`);
await wait(`!!document.querySelector('[data-share-inherit-toggle]')`);

// Turn OFF inheritParentAcl
await run(`document.querySelector('[data-share-inherit-toggle]').click()`);
await wait(`document.querySelector('[data-share-inherit-toggle]')?.getAttribute('aria-checked') === 'false'`);

// Switch to subject mode, grant 研发中心 (parent dept) edit access
await run(`document.querySelector('[data-share-target-mode="subject"]').click()`);
await wait(`!!document.querySelector('select[aria-label="选择部门或用户组"] option') && !document.querySelector('select[aria-label="选择部门或用户组"]').disabled`);
await run(`(() => {
  const sel = document.querySelector('select[aria-label="选择部门或用户组"]');
  const opt = [...sel.options].find((o) => o.textContent.includes('研发中心'));
  if (!opt) throw new Error('Missing 研发中心 option');
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await run(`document.querySelector('[aria-label="添加部门或用户组"]').click()`);
await wait(`document.body.innerText.includes('部门 · 含下级') && document.body.innerText.includes('研发中心')`);
await screenshot("share-dept-desktop.png");

// Verify in real browser cookies for Alice (member of 前端组, sub-dept of 研发中心 -> HAS access) and Bob (市场部 -> NO access)
await run(`(async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(aliceEmail)}, password: 'password123' })
  });
})()`);
await send("Page.navigate", { url: `${app}/` });
await wait(`document.body.innerText.includes('Alice Dev')`);
await send("Page.navigate", { url: `${app}/#/doc/${docId}` });
await wait(`!!document.querySelector('[data-doc-scroll]') && document.body.innerText.includes('Q4核心架构与薪酬方案') && !document.body.innerText.includes('只读')`);

await run(`(async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(bobEmail)}, password: 'password123' })
  });
})()`);
await send("Page.navigate", { url: `${app}/` });
await wait(`document.body.innerText.includes('Bob Mkt')`);
const bobHasDocOnHome = await run(`document.body.innerText.includes('Q4核心架构与薪酬方案')`);
if (bobHasDocOnHome) {
  throw new Error("Restricted doc leaked to non-granted workspace member Bob on Home page!");
}
const bobDocStatus = await run(`(async () => (await fetch('/api/docs/' + ${docId})).status)()`);
if (bobDocStatus !== 404) {
  throw new Error(`Expected 404 for Bob on restricted doc, got ${bobDocStatus}`);
}

await send("Target.closeTarget", { targetId: target.id });
ws.close();
console.log(JSON.stringify({ ok: true, docId, bobDocStatus, bobHasDocOnHome }));
