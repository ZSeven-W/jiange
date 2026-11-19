import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9232);
const OUT_DIR = process.env.OUT_DIR || "output/search-index-verify-20261119";
mkdirSync(OUT_DIR, { recursive: true });

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("CDP target not ready");
}

function connectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      consoleErrors,
      close() { ws.close(); },
    });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.code}: ${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params?.exceptionDetails?.text || "exception");
      } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        consoleErrors.push(msg.params.entry.text);
      }
    };
  });
}

async function apiReq(cookie, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return { data: text ? JSON.parse(text) : null, setCookie };
}

async function waitFor(cdp, expr, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (result?.value) return result.value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for: ${expr}`);
}

async function screenshot(cdp, name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const outPath = `${OUT_DIR}/${name}`;
  writeFileSync(outPath, Buffer.from(data, "base64"));
  console.log("Saved screenshot:", outPath);
}

async function main() {
  const ts = Date.now();
  const email = `search-cdp-${ts}@example.com`;
  const reg = await apiReq(null, "POST", "/api/auth/register", { email, name: "SearchLead", password: "password123" });
  const cookie = reg.setCookie.split(";")[0];
  const userId = String(reg.data.user.id);
  const uidHeader = { "X-Jiange-User-Id": userId };

  // Create folder hierarchy: 研发档案 -> Q4 专项
  const rootFolder = (await apiReq(cookie, "POST", "/api/drive/folders", { title: "研发档案" }, uidHeader)).data;
  const subFolder = (await apiReq(cookie, "POST", "/api/drive/folders", { title: "Q4 专项", parentId: rootFolder.id }, uidHeader)).data;

  // 1. Base inside Q4 专项 with deep cell value
  const baseNode = (await apiReq(cookie, "POST", "/api/drive/nodes", { kind: "base", title: "供应链台账", parentId: subFolder.id }, uidHeader)).data;
  const baseDetail = (await apiReq(cookie, "GET", `/api/bases/${baseNode.id}`)).data;
  const primaryFieldId = String(baseDetail.fields[0].id);
  await apiReq(cookie, "POST", `/api/bases/${baseNode.id}/records`, {
    cells: { [primaryFieldId]: "光子芯片交付里程碑" },
  }, uidHeader);

  // 2. Slides inside 研发档案 with speaker notes + text shape
  const slidesNode = (await apiReq(cookie, "POST", "/api/drive/nodes", { kind: "slides", title: "年度架构汇报", parentId: rootFolder.id }, uidHeader)).data;
  const pages = (await apiReq(cookie, "GET", `/api/slides/${slidesNode.id}/pages`)).data.pages;
  await apiReq(cookie, "PATCH", `/api/slides/pages/${pages[0].id}`, {
    title: "2026 核心演进",
    body: "全面升级检索基础设施",
    notes: "容灾切换演练方案",
    shapes: [{ id: "s1", kind: "text", x: 10, y: 10, width: 50, height: 20, color: "#1f2329", text: "多活网关设计" }],
    expectedRevision: pages[0].revision,
  }, uidHeader);

  // 3. Survey at root with deep question option
  const surveyNode = (await apiReq(cookie, "POST", "/api/drive/nodes", { kind: "survey", title: "客户满意度问卷" }, uidHeader)).data;
  const svDetail = (await apiReq(cookie, "GET", `/api/surveys/${surveyNode.id}`)).data.survey;
  await apiReq(cookie, "PUT", `/api/surveys/${surveyNode.id}`, {
    description: "用于收集企业全文检索体验反馈",
    questions: [
      { id: "q1", type: "single", title: "请评估全文检索精准度", required: true, options: ["极速响应", "满足预期"] },
    ],
    expectedRevision: svDetail.revision,
  });

  // Verify API deep search + server filters directly
  const baseHit = (await apiReq(cookie, "GET", `/api/search?q=${encodeURIComponent("光子芯片交付")}`)).data.docs;
  if (!baseHit.some((d) => d.id === baseNode.id)) throw new Error("Base deep search missed");
  const slidesHit = (await apiReq(cookie, "GET", `/api/search?q=${encodeURIComponent("容灾切换演练")}`)).data.docs;
  if (!slidesHit.some((d) => d.id === slidesNode.id)) throw new Error("Slides notes deep search missed");
  const surveyHit = (await apiReq(cookie, "GET", `/api/search?q=${encodeURIComponent("极速响应")}`)).data.docs;
  if (!surveyHit.some((d) => d.id === surveyNode.id)) throw new Error("Survey option deep search missed");
  const folderBaseHit = (await apiReq(cookie, "GET", `/api/search?folderId=${rootFolder.id}&kind=base`)).data.docs;
  if (folderBaseHit.length !== 1 || folderBaseHit[0].id !== baseNode.id) {
    throw new Error(`Expected folderId+kind=base to match only baseNode, got ${JSON.stringify(folderBaseHit)}`);
  }
  console.log("API deep search & filter assertions passed.");

  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const [cookieName, cookieVal] = cookie.split("=");
  await cdp.send("Network.setCookie", { name: cookieName, value: cookieVal, domain: "127.0.0.1", path: "/" });
  await cdp.send("Page.navigate", { url: `${APP}/#/home` });
  await cdp.send("Page.bringToFront");
  await waitFor(cdp, `document.body.innerText.includes("主页") || document.body.innerText.includes("云盘")`);

  // Open Global Search via sidebar trigger
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const trigger = document.querySelector("[data-search]");
      if (!trigger) throw new Error("search trigger not found");
      trigger.click();
    })()`,
  });
  await waitFor(cdp, `!!document.querySelector('[role="dialog"][aria-label="全局搜索"]')`);

  // Expand Advanced Search
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").includes("高级搜索"));
      btn.click();
    })()`,
  });
  await waitFor(cdp, `!!document.querySelector('select[aria-label="所在目录筛选"]')`);

  // 1) Search deep survey option "极速响应"
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('[role="dialog"] input[type="search"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "极速响应");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`,
  });
  await waitFor(cdp, `document.querySelector('[role="dialog"]')?.innerText.includes("客户满意度问卷")`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "01-search-deep-survey.png");

  // 2) Clear keyword, filter by folder "研发档案" + kind "多维表格" + today's date range
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;
  await waitFor(cdp, `document.querySelector('select[aria-label="所在目录筛选"]')?.options.length >= 3`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const setInput = (el, val) => {
        const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setInput(document.querySelector('[role="dialog"] input[type="search"]'), "");
      setInput(document.querySelector('select[aria-label="文档类型筛选"]'), "base");
      setInput(document.querySelector('select[aria-label="所在目录筛选"]'), "${rootFolder.id}");
      setInput(document.querySelector('input[aria-label="更新开始日期"]'), "${todayStr}");
      setInput(document.querySelector('input[aria-label="更新结束日期"]'), "${todayStr}");
    })()`,
  });
  await waitFor(cdp, `(() => {
    const opts = [...document.querySelectorAll('[role="dialog"] [role="option"]')];
    return opts.length === 1 && opts[0].innerText.includes("供应链台账");
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "02-search-folder-date-filter.png");

  // 3) Mobile 390x844 viewport verification
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "03-search-mobile.png");

  if (cdp.consoleErrors.length) {
    throw new Error(`Console errors: ${cdp.consoleErrors.join("; ")}`);
  }
  console.log("CDP search index & advanced filter verification succeeded with 0 console errors.");
  cdp.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
