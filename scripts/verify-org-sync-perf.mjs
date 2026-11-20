import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const app = process.env.JIANGE_ORG_TEST_URL;
const cdp = process.env.JIANGE_ORG_CDP_URL;
const pgContainer = process.env.JIANGE_ORG_PG_CONTAINER || "";
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
const consoleErrors = [];
const pageErrors = [];
ws.onmessage = (event) => {
  const item = JSON.parse(event.data);
  if (item.method === "Runtime.consoleAPICalled" && item.params?.type === "error") {
    const text = (item.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    consoleErrors.push(text);
  }
  if (item.method === "Runtime.exceptionThrown") {
    pageErrors.push(item.params?.exceptionDetails?.text || "exception");
  }
  if (!item.id) return;
  const job = jobs.get(item.id);
  if (!job) return;
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

const setControl = async (selector, value, proto = "HTMLInputElement") => {
  await run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
    const set = Object.getOwnPropertyDescriptor(window[${JSON.stringify(proto)}].prototype, 'value').set;
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

const acceptInvitation = async (account) => {
  const list = await (await fetch(`${app}/api/invitations`, { headers: { Cookie: account.cookie } })).json();
  if (!list.invitations?.length) throw new Error(`Expected invitation, got ${JSON.stringify(list)}`);
  const res = await fetch(`${app}/api/invitations/${list.invitations[0].id}/accept`, {
    method: "POST",
    headers: { Cookie: account.cookie },
  });
  if (res.status !== 204) throw new Error(`Accept failed: ${res.status}`);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.clearBrowserCookies");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${app}/` });
await wait(`!!document.querySelector('form')`);

const suffix = Date.now();
const ownerEmail = `sync-owner-${suffix}@example.test`;
const aliceEmail = `sync-alice-${suffix}@example.test`;
const bobEmail = `sync-bob-${suffix}@example.test`;
const inviteeEmail = `sync-newcomer-${suffix}@example.test`;

const aliceAcc = await registerAccount(aliceEmail, "Alice Eng");
const bobAcc = await registerAccount(bobEmail, "Bob Docs");

// Register Owner in the browser UI.
await run(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('免费注册') || b.textContent.includes('注册'));
  if (btn) btn.click();
})()`);
await setControl('input[type="email"]', ownerEmail);
await run(`(() => {
  const nameInput = [...document.querySelectorAll('input')].find((el) => el.type !== 'email' && el.type !== 'password');
  if (nameInput) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(nameInput, 'Sync Owner');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
})()`);
await setControl('input[type="password"]', "password123");
await run(`document.querySelector('form button[type="submit"]').click()`);
await wait(`document.body.innerText.includes('主页') && document.body.innerText.includes('组织架构')`);

const ownerMe = await run(`fetch('/api/me').then((r) => r.json())`);
const wsId = ownerMe.workspaces[0].id;
const ownerId = ownerMe.user.id;

// Invite Alice & Bob via API and have them accept so they are workspace members.
for (const acc of [aliceAcc, bobAcc]) {
  await run(`fetch('/api/workspaces/${wsId}/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Jiange-User-Id': '${ownerId}' },
    body: JSON.stringify({ email: ${JSON.stringify(acc.me.user.email)}, role: 'member' })
  }).then((r) => { if (!r.ok) throw new Error('invite failed ' + r.status); })`);
  await acceptInvitation(acc);
}

// Create a manual department that external sync must preserve.
await run(`fetch('/api/workspaces/${wsId}/departments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Jiange-User-Id': '${ownerId}' },
  body: JSON.stringify({ name: '手工保留部', parentId: null, sortOrder: 99 })
}).then((r) => { if (!r.ok) throw new Error('create manual dept failed ' + r.status); })`);

// Navigate to 组织架构 -> 目录同步 tab.
await run(`(() => {
  const nav = [...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes('组织架构'));
  if (!nav) throw new Error('Missing 组织架构 nav button');
  nav.click();
})()`);
await wait(`!!document.querySelector('[data-org-tab="sync"]')`);
await run(`document.querySelector('[data-org-tab="sync"]').click()`);
await wait(`!!document.querySelector('[data-sync-create-form]')`);

// 1. Create a SCIM 2.0 sync source and verify one-time Bearer token banner.
await setControl("[data-sync-source-name]", "企业 SCIM 目录");
await setControl("[data-sync-provider-select]", "scim", "HTMLSelectElement");
await run(`document.querySelector('[data-sync-create-btn]').click()`);
await wait(`!!document.querySelector('[data-sync-token-banner]') && !!document.querySelector('[data-sync-token-value]')`);
const rawToken = await run(`document.querySelector('[data-sync-token-value]').textContent.trim()`);
if (!rawToken.startsWith("jg_sync_")) {
  throw new Error(`Unexpected generated sync token: ${rawToken}`);
}
await screenshot("org-sync-token-desktop.png");

// 2. Paste CSV directory snapshot -> Dry-Run -> assert zero DB mutation -> Apply Sync.
const csvPayload = [
  "部门路径,姓名,邮箱,角色,用户组,负责人",
  `研发中心/基础架构部,Alice Eng,${aliceEmail},member,核心架构组,是`,
  `研发中心/云文档部,Bob Docs,${bobEmail},admin,安全审计组,否`,
  `产品设计部/交互组,Newcomer,${inviteeEmail},member,产品评审组,否`,
].join("\n");

await setControl("[data-sync-input]", csvPayload, "HTMLTextAreaElement");
await run(`document.querySelector('[data-sync-dry-run-btn]').click()`);
await wait(`!!document.querySelector('[data-sync-preview-card]') && document.querySelector('[data-sync-preview-card]').textContent.includes('差异预演结果')`);

const orgAfterDry = await run(`fetch('/api/workspaces/${wsId}/org', { headers: { 'X-Jiange-User-Id': '${ownerId}' } }).then((r) => r.json())`);
if (orgAfterDry.departments.length !== 1 || orgAfterDry.departments[0].name !== "手工保留部") {
  throw new Error(`Dry-run mutated departments: ${JSON.stringify(orgAfterDry.departments)}`);
}

await run(`document.querySelector('[data-sync-apply-btn]').click()`);
await wait(`document.querySelector('[data-sync-preview-card]')?.textContent.includes('本次同步执行结果') && document.querySelectorAll('[data-sync-run-row]').length >= 2`);
await screenshot("org-sync-applied-desktop.png");

// 3. Push a SCIM 2.0 ListResponse via Bearer token (application/scim+json) directly to /api/org/sync/push!
const scimRes = await fetch(`${app}/api/org/sync/push`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${rawToken}`,
    "Content-Type": "application/scim+json",
  },
  body: JSON.stringify({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    Resources: [
      {
        schemas: [
          "urn:ietf:params:scim:schemas:core:2.0:User",
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
        ],
        id: "scim-alice",
        userName: aliceEmail,
        displayName: "Alice Eng",
        active: true,
        emails: [{ value: aliceEmail, primary: true }],
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
          department: "研发中心/基础架构部",
        },
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        id: "scim-grp-review",
        displayName: "SCIM评审团",
        members: [{ value: "scim-alice" }],
      },
    ],
  }),
});
const scimRun = await scimRes.json();
if (!scimRes.ok || scimRun.triggerMode !== "scim") {
  throw new Error(`SCIM push failed: ${scimRes.status} ${JSON.stringify(scimRun)}`);
}

// 4. Reload page and verify Postgres persistence across 部门架构, 用户组, 空间成员, and 目录同步!
await run(`window.__preReload = true`);
await send("Page.reload");
await wait(`!window.__preReload && !!document.querySelector('[data-org-tab="departments"]') && !document.body.innerText.includes('正在加载组织架构')`);
await run(`document.querySelector('[data-org-tab="departments"]').click()`);
await wait(`document.body.innerText.includes('研发中心') && document.body.innerText.includes('基础架构部') && document.body.innerText.includes('手工保留部')`);
await screenshot("org-sync-dept-tree-desktop.png");

await run(`document.querySelector('[data-org-tab="groups"]').click()`);
await wait(`document.body.innerText.includes('核心架构组') && document.body.innerText.includes('SCIM评审团')`);

await run(`document.querySelector('[data-org-tab="members"]').click()`);
await wait(`document.body.innerText.includes(${JSON.stringify(inviteeEmail)})`);

// 5. Verify department-inherited restricted doc access on synced hierarchy!
const orgLive = await run(`fetch('/api/workspaces/${wsId}/org', { headers: { 'X-Jiange-User-Id': '${ownerId}' } }).then((r) => r.json())`);
const rndDepts = orgLive.departments.filter((d) => d.name === "研发中心");
if (rndDepts.length !== 1) {
  throw new Error(`Expected CSV and SCIM to merge into 1 canonical 研发中心 dept, got ${rndDepts.length}: ${JSON.stringify(orgLive.departments)}`);
}
const rndDept = rndDepts[0];

const secretFolder = await run(`fetch('/api/drive/folders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '同步权限保密区', parentId: null, scope: 'shared' })
}).then(async (r) => { if (!r.ok) throw new Error('folder failed ' + r.status + ' ' + await r.text()); return r.json(); })`);

await run(`fetch('/api/docs/${secretFolder.id}/inheritance', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Jiange-User-Id': '${ownerId}' },
  body: JSON.stringify({ inheritParentAcl: false })
}).then((r) => { if (!r.ok) throw new Error('inheritance failed ' + r.status); })`);

await run(`fetch('/api/docs/${secretFolder.id}/subject-shares', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Jiange-User-Id': '${ownerId}' },
  body: JSON.stringify({ subjectType: 'department', subjectId: ${rndDept.id}, role: 'edit' })
}).then((r) => { if (!r.ok) throw new Error('subject-share failed ' + r.status); })`);

const secretDoc = await run(`fetch('/api/drive/nodes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'doc', title: '同步子部门可见文档', parentId: ${secretFolder.id}, scope: 'shared' })
}).then(async (r) => { if (!r.ok) throw new Error('doc failed ' + r.status + ' ' + await r.text()); return r.json(); })`);

const aliceDocRes = await fetch(`${app}/api/docs/${secretDoc.id}`, { headers: { Cookie: aliceAcc.cookie } });
if (!aliceDocRes.ok) {
  throw new Error(`Alice (in synced sub-dept) should access restricted doc via 研发中心, got ${aliceDocRes.status}`);
}

// 6. Optional large-space HTTP latency benchmark & EXPLAIN check against real Postgres 16.
let perfReport = null;
if (pgContainer) {
  const openFolder = await run(`fetch('/api/drive/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '压测公开目录', parentId: null, scope: 'shared' })
  }).then(async (r) => { if (!r.ok) throw new Error('open folder failed ' + r.status); return r.json(); })`);

  const seedSQL = `
    INSERT INTO nodes (workspace_id, parent_id, kind, title, sort_key, creator_id, inherit_parent_acl, drive_revision)
    SELECT ${wsId}, ${openFolder.id}, 'doc', '压测文档 #' || gs, 'z' || lpad(gs::text, 6, '0'), ${ownerId}, true, 1
    FROM generate_series(1, 1500) gs;
    ANALYZE nodes, node_acl_state, node_acl_ancestors, org_department_closure, node_subject_shares;
  `;
  execFileSync("docker", ["exec", "-i", pgContainer, "psql", "-U", "jiange", "-d", "jiange", "-v", "ON_ERROR_STOP=1"], {
    input: seedSQL,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Warm up + measure 5 real HTTP GET /api/docs calls for Alice!
  await fetch(`${app}/api/docs`, { headers: { Cookie: aliceAcc.cookie } });
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const r = await fetch(`${app}/api/docs`, { headers: { Cookie: aliceAcc.cookie } });
    const data = await r.json();
    const ms = performance.now() - t0;
    if (!r.ok || !Array.isArray(data.docs) || data.docs.length !== 500) {
      throw new Error(`Unexpected /api/docs response: ${r.status} count=${data.docs?.length}`);
    }
    samples.push(Number(ms.toFixed(1)));
  }
  const avgMs = Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(1));
  perfReport = { seededDocs: 1500, aliceApiDocsSamplesMs: samples, aliceApiDocsAvgMs: avgMs };
}

// 7. Mobile 390x844 layout & zero-overflow check on 目录同步 tab.
await run(`document.querySelector('[data-org-tab="sync"]').click()`);
await wait(`!!document.querySelector('[data-org-sync-panel]') && document.querySelectorAll('[data-sync-run-row]').length >= 3`);
await assertNoOverflow("desktop-1440");

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await new Promise((r) => setTimeout(r, 300));
await assertNoOverflow("mobile-390");
await screenshot("org-sync-mobile.png");

if (consoleErrors.length > 0 || pageErrors.length > 0) {
  throw new Error(`Console/page errors detected: console=${JSON.stringify(consoleErrors)} page=${JSON.stringify(pageErrors)}`);
}

console.log(JSON.stringify({
  ok: true,
  wsId,
  scimTriggerMode: scimRun.triggerMode,
  syncedDeptCount: orgLive.departments.length,
  syncedGroupCount: orgLive.groups.length,
  pendingInvitations: orgLive.invitations?.length ?? 0,
  perfReport,
  screenshots: [
    "org-sync-token-desktop.png",
    "org-sync-applied-desktop.png",
    "org-sync-dept-tree-desktop.png",
    "org-sync-mobile.png",
  ],
}, null, 2));

ws.close();
