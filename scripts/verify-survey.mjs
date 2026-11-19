import { mkdirSync, writeFileSync } from "node:fs";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9231);
const OUT_DIR = process.env.OUT_DIR || "output/survey-verify-20261119";
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

async function apiReq(cookie, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
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
  const email = `survey-cdp-${ts}@example.com`;
  const reg = await apiReq(null, "POST", "/api/auth/register", { email, name: "SurveyLead", password: "password123" });
  const cookie = reg.setCookie.split(";")[0];

  // Create standalone survey node
  const node = (await apiReq(cookie, "POST", "/api/drive/nodes", {
    kind: "survey",
    title: "2026 产品体验与优先级问卷",
    scope: "workspace",
  })).data;

  // Seed rich questions (single with skip logic + rating + matrix + ranking + signature)
  const questions = [
    {
      id: "q1",
      type: "single",
      title: "您使用云文档的频率是？",
      required: true,
      options: ["每天使用", "暂未使用"],
      skipRules: [{ whenOption: "暂未使用", jumpToQuestionId: "q_rank" }],
    },
    { id: "q_rate", type: "rating", title: "请为协同编辑流畅度打分", required: true, maxRating: 5 },
    {
      id: "q_matrix",
      type: "matrix",
      title: "各模块满意度量表",
      required: false,
      matrixRows: ["云文档", "电子表格", "多维表格"],
      matrixCols: ["非常满意", "满意", "一般"],
    },
    {
      id: "q_rank",
      type: "ranking",
      title: "最期待优先增强的能力",
      required: false,
      options: ["修订模式", "跨文档同步块", "离线编辑"],
    },
  ];
  await apiReq(cookie, "PUT", `/api/surveys/${node.id}`, {
    description: "本问卷支持跳题逻辑、矩阵量表、排序题与实时可视化结果统计。",
    questions,
    allowAnonymous: true,
    maxResponses: 0,
    expectedRevision: 1,
  });

  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Page.bringToFront");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const [cname, cval] = cookie.split("=");
  await cdp.send("Network.setCookie", { name: cname, value: cval, url: APP, path: "/" });

  // 1. Open Survey Studio (#/survey/{id}) -> screenshot Design tab + publish survey!
  await cdp.send("Page.navigate", { url: `${APP}/#/survey/${node.id}` });
  await waitFor(cdp, `!!document.querySelector('[data-survey-page]') && document.querySelectorAll('[data-question-card]').length === 4`);
  await screenshot(cdp, "01-survey-designer.png");

  // Publish survey via UI button
  await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-publish-survey]')?.click()` });
  await waitFor(cdp, `document.querySelector('[data-survey-status="published"]') !== null`);
  await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-survey-tab="publish"]')?.click()` });
  await waitFor(cdp, `!!document.querySelector('[data-public-survey-url]')`);
  const publicHash = (await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-open-public-survey]')?.getAttribute('href')`,
    returnByValue: true,
  })).result.value;

  // 2. Open Public Respondent Page (#/q/{token}), verify live skip logic + submit!
  await cdp.send("Page.navigate", { url: `${APP}/${publicHash}` });
  await waitFor(cdp, `!!document.querySelector('[data-public-survey-page]') && document.querySelectorAll('[data-public-question]').length === 4`);

  // Click "暂未使用" -> verify skip logic hides q_rate and q_matrix dynamically (4 -> 2 visible questions)!
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-public-option="q1:暂未使用"] input')?.click()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-public-question]').length === 2`);

  // Switch back to "每天使用" -> all 4 questions reappear! Fill rating + matrix and screenshot!
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('[data-public-option="q1:每天使用"] input')?.click();
    })()`,
  });
  await waitFor(cdp, `document.querySelectorAll('[data-public-question]').length === 4`);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const nameIn = document.querySelector('[data-public-respondent-name]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameIn, '受访者小王');
      nameIn.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-public-rating="q_rate:5"]')?.click();
      document.querySelector('[data-public-matrix="q_matrix:云文档:非常满意"]')?.click();
      document.querySelector('[data-public-matrix="q_matrix:电子表格:非常满意"]')?.click();
      document.querySelector('[data-public-matrix="q_matrix:多维表格:满意"]')?.click();
    })()`,
  });
  await new Promise((r) => setTimeout(r, 250));
  await screenshot(cdp, "02-survey-public-form.png");

  // Submit public form
  await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-public-survey-submit]')?.click()` });
  await waitFor(cdp, `!!document.querySelector('[data-survey-submitted]')`);

  // Also submit a 2nd anonymous response via API (using skip logic) so stats show rich multi-response distribution!
  const token = publicHash.replace(/^#\/q\//, "");
  await apiReq(null, "POST", `/api/public/surveys/${token}/submit`, {
    respondentName: "匿名用户 B",
    answers: { q1: "暂未使用", q_rank: ["离线编辑", "修订模式", "跨文档同步块"] },
  });

  // 3. Return to Survey Studio Stats tab and screenshot visual analytics!
  await cdp.send("Page.navigate", { url: `${APP}/#/survey/${node.id}` });
  await waitFor(cdp, `!!document.querySelector('[data-survey-tab="stats"]')`);
  await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-survey-tab="stats"]')?.click()` });
  await waitFor(cdp, `document.querySelector('[data-survey-total-responses]')?.textContent?.trim() === '2' && document.querySelectorAll('[data-stat-card]').length === 4`);
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(cdp, "03-survey-stats.png");

  if (cdp.consoleErrors.length) {
    console.error("Console errors:", cdp.consoleErrors);
    process.exitCode = 1;
  } else {
    console.log("ALL STANDALONE SURVEY CDP CHECKS PASSED (0 console errors)");
  }
  cdp.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
