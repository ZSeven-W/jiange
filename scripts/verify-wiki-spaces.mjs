import fs from "node:fs/promises";
import path from "node:path";

const app = process.env.JIANGE_WIKI_TEST_URL;
const cdp = process.env.JIANGE_WIKI_CDP_URL;
if (!app || !cdp || ![app, cdp].every((url) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))) {
  throw new Error("Set local disposable JIANGE_WIKI_TEST_URL and JIANGE_WIKI_CDP_URL");
}
const out = process.env.JIANGE_WIKI_SCREENSHOT_DIR || process.cwd();
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
  for (let i = 0; i < 220; i++) {
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
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
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

const suffix = Date.now();
const ownerEmail = `wiki-owner-${suffix}@example.test`;
const aliceEmail = `wiki-alice-${suffix}@example.test`;
const bobEmail = `wiki-bob-${suffix}@example.test`;

const aliceAcc = await registerAccount(aliceEmail, "Alice Dev");
const bobAcc = await registerAccount(bobEmail, "Bob Mkt");

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${app}/` });
await wait(`!!document.querySelector('form')`);

// Register Owner in UI
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
await wait(`document.body.innerText.includes('主页') && document.body.innerText.includes('知识库')`);

// Setup workspace org (研发中心 -> 前端组 for Alice, 市场部 for Bob) & a Drive doc via API
const setup = await run(`(async () => {
  const me = await (await fetch('/api/me')).json();
  const wsId = me.workspaces[0].id;
  for (const email of [${JSON.stringify(aliceEmail)}, ${JSON.stringify(bobEmail)}]) {
    await fetch('/api/workspaces/' + wsId + '/members', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role: 'member' })
    });
  }
  const rnd = await (await fetch('/api/workspaces/' + wsId + '/departments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '研发中心' })
  })).json();
  const fe = await (await fetch('/api/workspaces/' + wsId + '/departments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '前端组', parentId: rnd.id })
  })).json();
  const driveDoc = await (await fetch('/api/drive/nodes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'doc', title: '存量云盘规范', scope: 'shared' })
  })).json();
  return { wsId, rndId: rnd.id, feId: fe.id, driveDocId: driveDoc.id };
})()`);

for (const acc of [aliceAcc, bobAcc]) {
  const list = await (await fetch(`${app}/api/invitations`, { headers: { Cookie: acc.cookie } })).json();
  await fetch(`${app}/api/invitations/${list.invitations[0].id}/accept`, { method: "POST", headers: { Cookie: acc.cookie } });
}
await run(`(async () => {
  await fetch('/api/workspaces/${setup.wsId}/departments/${setup.feId}/members', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: ${aliceAcc.me.user.id}, present: true, isLeader: true })
  });
})()`);

// Open 知识库 from sidebar
await run(`(() => {
  const nav = [...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes('知识库'));
  if (!nav) throw new Error('Missing 知识库 nav button');
  nav.click();
})()`);
await wait(`!!document.querySelector('[data-wiki-spaces-page]') && !!document.querySelector('[data-new-wiki-space]')`);

// Create Wiki space via UI
await run(`document.querySelector('[data-new-wiki-space]').click()`);
await wait(`!!document.querySelector('[data-create-wiki-dialog]')`);
await setInput("#wiki-space-name", "产品与研发知识库");
await setInput("#wiki-space-desc", "统一沉淀架构方案、排期表与评审规范");
await run(`document.querySelector('[data-create-wiki-dialog] button[type="submit"]').click()`);
await wait(`!!document.querySelector('[data-wiki-space-page]') && document.body.innerText.includes('产品与研发知识库')`);

const spaceId = await run(`Number(location.hash.match(/#\\/wiki\\/(\\d+)/)?.[1] || 0)`);
if (!spaceId) throw new Error("Failed to resolve created spaceId from hash");

// Open Wiki Space Settings & grant 研发中心 edit access
await run(`document.querySelector('[data-wiki-space-settings]').click()`);
await wait(`!!document.querySelector('[data-wiki-settings-dialog]') && !document.querySelector('[data-wiki-grant-subject]').disabled`);
await run(`(() => {
  const sel = document.querySelector('[data-wiki-grant-subject]');
  const opt = [...sel.options].find((o) => o.textContent.includes('研发中心'));
  if (!opt) throw new Error('Missing 研发中心 option');
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await run(`document.querySelector('[data-wiki-grant-add]').click()`);
await wait(`document.body.innerText.includes('空间权限已更新') && !!document.querySelector('[data-wiki-grant-row]')`);
await screenshot("wiki-settings-desktop.png");
await run(`document.querySelector('[data-wiki-settings-dialog] button[aria-label="关闭"]').click()`);
await wait(`!document.querySelector('[data-wiki-settings-dialog]')`);

// Create hierarchical Wiki nodes: 架构总览 (doc) -> 接口规范 (sub-doc) + 核心密钥说明 (sub-doc) + 排期表 (sheet)
const created = await run(`(async () => {
  const root = await (await fetch('/api/wiki/spaces/${spaceId}/nodes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'doc', title: '架构总览' })
  })).json();
  const child = await (await fetch('/api/wiki/spaces/${spaceId}/nodes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'doc', parentId: root.id, title: '接口规范' })
  })).json();
  const secret = await (await fetch('/api/wiki/spaces/${spaceId}/nodes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'doc', parentId: root.id, title: '核心密钥说明' })
  })).json();
  const sheet = await (await fetch('/api/wiki/spaces/${spaceId}/nodes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'sheet', title: '排期表' })
  })).json();
  // Restrict 核心密钥说明: turn off inheritParentAcl and grant only 前端组 view
  await fetch('/api/docs/' + secret.id + '/inheritance', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inheritParentAcl: false })
  });
  await fetch('/api/docs/' + secret.id + '/subject-shares', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subjectType: 'department', subjectId: ${setup.feId}, role: 'view' })
  });
  return { rootId: root.id, childId: child.id, secretId: secret.id, sheetId: sheet.id };
})()`);

// Migrate Drive doc 存量云盘规范 into Wiki via UI dialog
await run(`document.querySelector('[data-wiki-create-menu]').click()`);
await wait(`!!document.querySelector('[data-wiki-import-drive]')`);
await run(`document.querySelector('[data-wiki-import-drive]').click()`);
await wait(`!!document.querySelector('[data-wiki-import-dialog]') && !document.querySelector('[data-wiki-import-source]').disabled`);
await run(`document.querySelector('[data-wiki-import-submit]').click()`);
await wait(`!document.querySelector('[data-wiki-import-dialog]') && document.body.innerText.includes('存量云盘规范')`);

// Confirm Drive root no longer lists 存量云盘规范 (Decision A2)
const driveAfter = await run(`(async () => (await (await fetch('/api/drive/children?scope=shared')).json()).entries || [])()`);
if (driveAfter.some((e) => e.id === setup.driveDocId)) {
  throw new Error("Migrated doc still appears in Drive children!");
}

// Navigate to Wiki spaces hub for screenshot
await send("Page.navigate", { url: `${app}/#/wiki` });
await wait(`!!document.querySelector('[data-wiki-spaces-page]') && document.body.innerText.includes('产品与研发知识库') && document.body.innerText.includes('5 篇内容')`);
await assertNoOverflow("wiki-spaces-desktop");
await screenshot("wiki-spaces-desktop.png");

// Open 架构总览 inside Wiki space for desktop & simulated mobile screenshots
await send("Page.navigate", { url: `${app}/#/wiki/${spaceId}/node/${created.rootId}` });
await wait(`!!document.querySelector('[data-wiki-sidebar]') && !!document.querySelector('[data-doc-scroll]') && document.body.innerText.includes('接口规范')`);
await assertNoOverflow("wiki-doc-desktop");
await screenshot("wiki-doc-desktop.png");

// Simulated mobile viewport (390x844)
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await new Promise((r) => setTimeout(r, 250));
await assertNoOverflow("wiki-mobile");
await screenshot("wiki-mobile.png");

// Verify as Bob (市场部): can view 架构总览 in Wiki & Global Search, CANNOT see or fetch 核心密钥说明 (404)
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await run(`(async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(bobEmail)}, password: 'password123' })
  });
})()`);
await send("Page.navigate", { url: `${app}/` });
await wait(`document.body.innerText.includes('Bob Mkt')`);
await send("Page.navigate", { url: `${app}/#/wiki/${spaceId}/node/${created.rootId}` });
await wait(`!!document.querySelector('[data-wiki-sidebar]') && !!document.querySelector('[data-doc-scroll]') && document.body.innerText.includes('架构总览') && document.body.innerText.includes('只读')`);
const bobSeesSecretInTree = await run(`document.body.innerText.includes('核心密钥说明')`);
if (bobSeesSecretInTree) {
  throw new Error("Restricted Wiki subpage leaked to Bob in Wiki sidebar!");
}
const bobSecretStatus = await run(`(async () => (await fetch('/api/docs/${created.secretId}')).status)()`);
if (bobSecretStatus !== 404) {
  throw new Error(`Expected 404 for Bob on restricted Wiki subpage, got ${bobSecretStatus}`);
}
const bobSearch = await run(`(async () => (await (await fetch('/api/search?q=' + encodeURIComponent('架构总览'))).json()).docs || [])()`);
if (!bobSearch.some((d) => d.id === created.rootId && d.wikiSpaceId === spaceId)) {
  throw new Error(`Expected Bob Global Search to find 架构总览 with wikiSpaceId=${spaceId}, got ${JSON.stringify(bobSearch)}`);
}

await send("Target.closeTarget", { targetId: target.id });
ws.close();
console.log(JSON.stringify({ ok: true, spaceId, rootId: created.rootId, bobSecretStatus, bobSearchCount: bobSearch.length }));
