import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createZip, listZip, readZipEntry } from "../packages/doc-sdk/dist/zip.js";

const APP = process.env.APP_URL || "http://127.0.0.1:5174";
const API = process.env.API_URL || "http://127.0.0.1:8080";
const CDP_PORT = Number(process.env.CDP_PORT || 9241);
const OUT_DIR = process.env.OUT_DIR || "/tmp/docx-print-20261120";
mkdirSync(OUT_DIR, { recursive: true });

const enc = new TextEncoder();
const dec = new TextDecoder();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const t = enc.encode(type);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const body = new Uint8Array(4 + data.length);
  body.set(t, 0);
  body.set(data, 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  const out = new Uint8Array(4 + body.length + 4);
  out.set(len, 0);
  out.set(body, 4);
  out.set(crc, 4 + body.length);
  return out;
}

/** Generates a crisp Feishu-blue gradient card PNG (160x64) for embedded table image testing. */
function makeBannerPng(width = 160, height = 64) {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 4;
      const border = x < 3 || x >= width - 3 || y < 3 || y >= height - 3;
      const stripe = y >= 26 && y <= 38 && x >= 18 && x <= width - 18;
      if (border) {
        raw[p] = 20; raw[p + 1] = 86; raw[p + 2] = 240; raw[p + 3] = 255;
      } else if (stripe) {
        raw[p] = 255; raw[p + 1] = 255; raw[p + 2] = 255; raw[p + 3] = 255;
      } else {
        raw[p] = 51; raw[p + 1] = Math.round(112 + (x / width) * 32); raw[p + 2] = 255; raw[p + 3] = 255;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Builds a rich .docx fixture containing table rich text, table embedded PNG, comments, footnotes, endnotes, header/footer, and mc:AlternateContent textbox. */
function buildRichDocxFixture() {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
  const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

  const bannerPng = makeBannerPng();

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:mc="${MC}">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>一、持久化索引与多跳架构升级</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>全链路引用索引已切至持久化存储</w:t><w:footnoteReference w:id="1"/><w:t>，压测指标满足生产 SLA</w:t><w:endnoteReference w:id="1"/><w:t>。</w:t></w:r>
    </w:p>
    <w:p>
      <w:commentRangeStart w:id="7"/>
      <w:r><w:t>核心服务需在灰度阶段完成双写校验。</w:t></w:r>
      <w:commentRangeEnd w:id="7"/>
      <w:r><w:commentReference w:id="7"/></w:r>
    </w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="2600"/><w:gridCol w:w="6400"/></w:tblGrid>
      <w:tr>
        <w:trPr><w:tblHeader/></w:trPr>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>模块</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>富文本状态与架构示意图</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>同步引擎</w:t></w:r></w:p></w:tc>
        <w:tc>
          <w:p>
            <w:r><w:rPr><w:b/></w:rPr><w:t>核心加粗</w:t></w:r>
            <w:r><w:t xml:space="preserve"> · </w:t></w:r>
            <w:r><w:rPr><w:i/></w:rPr><w:t>灰度斜体</w:t></w:r>
            <w:r><w:t xml:space="preserve"> · </w:t></w:r>
            <w:r><w:rPr><w:rFonts w:ascii="Consolas"/><w:shd w:val="clear" w:fill="F2F3F5"/></w:rPr><w:t>v2-index</w:t></w:r>
            <w:r><w:t xml:space="preserve"> · </w:t></w:r>
            <w:r><w:rPr><w:color w:val="D83931"/></w:rPr><w:t>高优先级</w:t></w:r>
            <w:r>
              <w:drawing>
                <wp:inline>
                  <wp:extent cx="1524000" cy="609600"/>
                  <wp:docPr id="1" name="架构状态图" descr="架构状态图"/>
                  <a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>
                </wp:inline>
              </w:drawing>
            </w:r>
          </w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:r>
        <mc:AlternateContent>
          <mc:Choice Requires="wps">
            <w:drawing>
              <w:txbxContent>
                <w:p><w:r><w:t>架构提示：所有迁移脚本必须保持幂等可执行。</w:t></w:r></w:p>
              </w:txbxContent>
            </w:drawing>
          </mc:Choice>
          <mc:Fallback>
            <w:pict>
              <w:txbxContent>
                <w:p><w:r><w:t>架构提示：所有迁移脚本必须保持幂等可执行。</w:t></w:r></w:p>
              </w:txbxContent>
            </w:pict>
          </mc:Fallback>
        </mc:AlternateContent>
      </w:r>
    </w:p>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rIdHdr1"/>
      <w:footerReference w:type="default" r:id="rIdFtr1"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/arch-status.png"/>
  <Relationship Id="rIdHdr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFtr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rIdCmt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  <Relationship Id="rIdFn1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdEn1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
</Relationships>`;

  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W}">
  <w:comment w:id="7" w:author="周架构" w:date="2026-11-20T05:00:00Z" w:initials="周">
    <w:p><w:r><w:t>请补充回滚开关与降级 SLA 指标</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;

  const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W}">
  <w:footnote w:type="separator" w:id="0"><w:p/></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>参见 PostgreSQL 16 GIN 索引压测报告。</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

  const endnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="${W}">
  <w:endnote w:id="1"><w:p><w:r><w:t>数据采集窗口为 2026-11 生产集群。</w:t></w:r></w:p></w:endnote>
</w:endnotes>`;

  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Q4 架构升级方案 · 内部技术评审</w:t></w:r></w:p></w:hdr>`;

  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>鉴格云文档 · 架构委员会</w:t></w:r><w:r><w:t xml:space="preserve">  </w:t></w:r><w:fldSimple w:instr="PAGE"/><w:r><w:t> / </w:t></w:r><w:fldSimple w:instr="NUMPAGES"/></w:p></w:ftr>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return createZip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypesXml) },
    { name: "_rels/.rels", data: enc.encode(rootRelsXml) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(relsXml) },
    { name: "word/comments.xml", data: enc.encode(commentsXml) },
    { name: "word/footnotes.xml", data: enc.encode(footnotesXml) },
    { name: "word/endnotes.xml", data: enc.encode(endnotesXml) },
    { name: "word/header1.xml", data: enc.encode(headerXml) },
    { name: "word/footer1.xml", data: enc.encode(footerXml) },
    { name: "word/media/arch-status.png", data: bannerPng },
  ]);
}

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
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        consoleErrors,
        close() {
          ws.close();
        },
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
        consoleErrors.push(`EXCEPTION: ${msg.params?.exceptionDetails?.text || "exception"}`);
      } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        consoleErrors.push(`LOG: ${msg.params.entry.text} (${msg.params.entry.url || ""})`);
      }
    };
  });
}

async function apiReq(cookie, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") || "" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJS(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error(`evalJS error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception)}`);
  }
  return res.result?.value;
}

async function waitFor(cdp, label, fnSource, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await evalJS(cdp, `(${fnSource})()`);
    if (val) return val;
    await sleep(150);
  }
  const debug = await evalJS(cdp, `({ url: location.href, text: document.body.innerText.slice(0, 900) })`);
  throw new Error(`Timed out waiting for ${label}; debug=${JSON.stringify(debug)}`);
}

async function screenshot(cdp, filename, extra = {}) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", ...extra });
  const outPath = `${OUT_DIR}/${filename}`;
  writeFileSync(outPath, Buffer.from(data, "base64"));
  return outPath;
}

async function main() {
  const fixturePath = `${OUT_DIR}/Q4-架构升级方案.docx`;
  const fixtureBytes = buildRichDocxFixture();
  writeFileSync(fixturePath, fixtureBytes);
  console.log(`Built rich .docx fixture (${fixtureBytes.length} bytes) at ${fixturePath}`);

  const suffix = Date.now();
  const reg = await apiReq("", "POST", "/api/auth/register", {
    email: `docx-print-${suffix}@test.dev`,
    name: "林架构",
    password: "password123",
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.text}`);
  const cookie = reg.setCookie.split(";")[0];
  const user = reg.json.user;
  const workspace = reg.json.workspaces[0];

  const created = await apiReq(
    cookie,
    "POST",
    "/api/docs",
    { title: "Q4 架构升级评审", workspaceId: workspace.id },
    { "X-Jiange-User-Id": String(user.id) },
  );
  if (created.status !== 201) throw new Error(`create doc failed: ${created.status} ${created.text}`);
  const docId = created.json.id;
  console.log(`Created live doc #${docId}`);

  const wsUrl = await getWsUrl();
  const cdp = await connectCDP(wsUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

    const [cookieName, ...cookieRest] = cookie.split("=");
    const cookieVal = cookieRest.join("=");
    await cdp.send("Network.setCookie", { name: cookieName, value: cookieVal, url: APP, path: "/" });
    await cdp.send("Network.setCookie", { name: cookieName, value: cookieVal, url: API, path: "/" });

    await cdp.send("Page.navigate", { url: `${APP}/#/doc/${docId}` });
    await waitFor(cdp, "doc synced", () => !!document.querySelector('[data-status="synced"]') && !!document.querySelector("[data-more-menu]"));

    // 1. Import rich .docx via the real UI menu input
    await evalJS(cdp, `document.querySelector("[data-more-menu]").click()`);
    await waitFor(cdp, "import docx input", () => !!document.querySelector('[data-import-docx] input[type="file"]'));
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-import-docx] input[type="file"]' });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [fixturePath] });

    // Confirm the transparent conversion notice dialog (table image extraction & textbox -> callout)
    await waitFor(
      cdp,
      "import conversion notice dialog",
      () => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "确定") && document.body.innerText.includes("表格单元格中的图片已提取为表格下方独立图片块"),
      15000,
    );
    const askText = await evalJS(cdp, `document.body.innerText.slice(0, 400)`);
    console.log("Import notice:", askText.replace(/\s+/g, " ").slice(0, 260));
    if (askText.includes("Word 批注未导入") || askText.includes("脚注和尾注未导入") || askText.includes("页眉和页脚未导入")) {
      throw new Error(`Unexpected legacy drop warning shown: ${askText}`);
    }
    await evalJS(cdp, `[...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "确定").click()`);

    // Wait for rich content, uploaded table image, and imported Word comment
    await waitFor(
      cdp,
      "imported docx body + image + footnotes + textbox",
      () => {
        const text = document.body.innerText;
        const img = document.querySelector('[data-print-doc] img[src*="/api/files/"]');
        return (
          text.includes("核心加粗") &&
          text.includes("灰度斜体") &&
          text.includes("v2-index") &&
          text.includes("高优先级") &&
          text.includes("脚注与尾注") &&
          text.includes("架构提示：所有迁移脚本必须保持幂等可执行。") &&
          img &&
          img.complete &&
          img.naturalWidth > 0
        );
      },
      20000,
    );
    await waitFor(cdp, "synced after import", () => !!document.querySelector('[data-status="synced"]'));

    // Verify zero textbox duplication, table rich formatting marks, and table image caption
    const importAudit = await evalJS(cdp, `(() => {
      const article = document.querySelector("[data-print-doc]");
      const text = article.innerText;
      const tbOccurrences = text.split("架构提示：所有迁移脚本必须保持幂等可执行。").length - 1;
      const table = article.querySelector("table");
      const strong = table?.querySelector("strong")?.textContent || "";
      const em = table?.querySelector("em")?.textContent || "";
      const code = table?.querySelector("code")?.textContent || "";
      const redSpan = [...(table?.querySelectorAll("span") || [])].find((el) => el.textContent?.includes("高优先级"));
      const redColor = redSpan ? getComputedStyle(redSpan).color : "";
      const img = article.querySelector('img[src*="/api/files/"]');
      const callout = article.querySelector("[data-callout-color]");
      return {
        tbOccurrences,
        strong,
        em,
        code,
        redColor,
        hasFootnoteMarker: text.includes("[注1]") && text.includes("[尾注2]"),
        hasFootnoteText: text.includes("参见 PostgreSQL 16 GIN 索引压测报告。"),
        hasEndnoteText: text.includes("数据采集窗口为 2026-11 生产集群。"),
        imgNatural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
        calloutText: callout?.innerText || "",
      };
    })()`);
    console.log("Import audit:", JSON.stringify(importAudit));
    if (importAudit.tbOccurrences !== 1) throw new Error(`Expected textbox once, got ${importAudit.tbOccurrences}`);
    if (!importAudit.strong.includes("核心加粗") || !importAudit.em.includes("灰度斜体") || !importAudit.code.includes("v2-index")) {
      throw new Error(`Rich table marks missing: ${JSON.stringify(importAudit)}`);
    }
    if (importAudit.redColor !== "rgb(216, 57, 49)") {
      throw new Error(`Expected red table span rgb(216, 57, 49), got ${importAudit.redColor}`);
    }
    if (!importAudit.hasFootnoteMarker || !importAudit.hasFootnoteText || !importAudit.hasEndnoteText) {
      throw new Error(`Footnotes/endnotes missing: ${JSON.stringify(importAudit)}`);
    }
    if (!importAudit.imgNatural || importAudit.imgNatural.w !== 160 || importAudit.imgNatural.h !== 64) {
      throw new Error(`Uploaded table image invalid: ${JSON.stringify(importAudit.imgNatural)}`);
    }

    // Open Comments panel and verify Word comment persisted in PostgreSQL
    await evalJS(cdp, `document.querySelector('button[aria-label="评论"]').click()`);
    await waitFor(
      cdp,
      "imported Word comment in panel",
      () => {
        const panel = document.querySelector("[data-comments-panel]");
        return panel && panel.innerText.includes("Word 批注 · 周架构") && panel.innerText.includes("请补充回滚开关与降级 SLA 指标");
      },
      15000,
    );
    await screenshot(cdp, "01-imported-docx-desktop.png");

    // 2. Real browser .docx re-export round-trip check (capture Blob bytes from URL.createObjectURL)
    await evalJS(cdp, `(() => {
      window.__capturedDocx = null;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        if (blob && blob.type && blob.type.includes("wordprocessingml")) {
          window.__capturedDocx = blob.arrayBuffer().then((buf) => Array.from(new Uint8Array(buf)));
        }
        return orig(blob);
      };
    })()`);
    await evalJS(cdp, `document.querySelector("[data-more-menu]").click()`);
    await waitFor(cdp, "download submenu trigger", () => !!document.querySelector("[data-download-menu]"));
    await evalJS(cdp, `document.querySelector("[data-download-menu]").click()`);
    await waitFor(cdp, "export docx button", () => !!document.querySelector("[data-export-docx]"));
    await evalJS(cdp, `document.querySelector("[data-export-docx]").click()`);
    const exportedBytesArr = await waitFor(cdp, "captured exported docx blob", () => window.__capturedDocx, 15000);
    const exportedBytes = new Uint8Array(exportedBytesArr);
    const exportedEntries = listZip(exportedBytes);
    const exportedNames = exportedEntries.map((e) => e.name);
    console.log("Re-exported .docx entries:", exportedNames.join(", "));
    for (const needed of ["word/comments.xml", "word/header1.xml", "word/footer1.xml"]) {
      if (!exportedNames.includes(needed)) throw new Error(`Re-exported .docx missing ${needed}`);
    }
    if (!exportedNames.some((n) => n.startsWith("word/media/"))) {
      throw new Error(`Re-exported .docx missing embedded image in word/media/: ${exportedNames}`);
    }
    const expComments = dec.decode(await readZipEntry(exportedBytes, exportedEntries.find((e) => e.name === "word/comments.xml"), 1 << 20));
    const expHeader = dec.decode(await readZipEntry(exportedBytes, exportedEntries.find((e) => e.name === "word/header1.xml"), 1 << 20));
    const expFooter = dec.decode(await readZipEntry(exportedBytes, exportedEntries.find((e) => e.name === "word/footer1.xml"), 1 << 20));
    if (!expComments.includes("请补充回滚开关与降级 SLA 指标")) throw new Error("Re-exported comments.xml missing comment body");
    if (!expHeader.includes("Q4 架构升级方案 · 内部技术评审")) throw new Error(`Re-exported header1.xml mismatch: ${expHeader}`);
    if (!expFooter.includes("鉴格云文档 · 架构委员会") || !expFooter.includes("PAGE") || !expFooter.includes("NUMPAGES")) {
      throw new Error(`Re-exported footer1.xml mismatch: ${expFooter}`);
    }

    // 3. Open Print / Export PDF dialog, verify imported header/footer prefilled, configure landscape + narrow + comments
    await evalJS(cdp, `document.querySelector("[data-more-menu]").click()`);
    await waitFor(cdp, "download submenu for pdf", () => !!document.querySelector("[data-download-menu]"));
    await evalJS(cdp, `document.querySelector("[data-download-menu]").click()`);
    await waitFor(cdp, "export pdf button", () => !!document.querySelector("[data-export-pdf]"));
    await evalJS(cdp, `document.querySelector("[data-export-pdf]").click()`);
    await waitFor(cdp, "print dialog open", () => !!document.querySelector("[data-doc-print-dialog]"));

    const prefill = await evalJS(cdp, `({
      headerChecked: document.querySelector("[data-print-header-toggle]")?.checked,
      headerValue: document.querySelector("[data-print-header-input]")?.value,
      footerChecked: document.querySelector("[data-print-footer-toggle]")?.checked,
      footerValue: document.querySelector("[data-print-footer-input]")?.value,
    })`);
    console.log("Print dialog prefill:", JSON.stringify(prefill));
    if (!prefill.headerChecked || prefill.headerValue !== "Q4 架构升级方案 · 内部技术评审") {
      throw new Error(`Print header prefill mismatch: ${JSON.stringify(prefill)}`);
    }
    if (!prefill.footerChecked || prefill.footerValue !== "鉴格云文档 · 架构委员会") {
      throw new Error(`Print footer prefill mismatch: ${JSON.stringify(prefill)}`);
    }

    await evalJS(cdp, `
      document.querySelector('[data-print-orientation="landscape"]').click();
      document.querySelector('[data-print-margin="narrow"]').click();
      document.querySelector('[data-print-comments-toggle]').click();
    `);
    await waitFor(cdp, "preview shows comments appendix", () => !!document.querySelector("[data-print-preview-comments]"));
    await screenshot(cdp, "02-print-dialog-desktop.png");

    // Stub window.print so headless confirms smoothly and leaves <style data-doc-print-style> active for printToPDF
    await evalJS(cdp, `window.__printCalled = 0; window.print = () => { window.__printCalled += 1; };`);
    await evalJS(cdp, `document.querySelector("[data-doc-print-confirm]").click()`);
    await waitFor(cdp, "window.print triggered & @page style injected", () => window.__printCalled === 1 && !!document.querySelector('style[data-doc-print-style]'));
    const injectedCss = await evalJS(cdp, `document.querySelector('style[data-doc-print-style]')?.textContent || ""`);
    console.log("Injected @page CSS:", injectedCss);
    if (injectedCss !== "@page { size: A4 landscape; margin: 10mm 10mm; }") {
      throw new Error(`Unexpected @page CSS: ${injectedCss}`);
    }

    // Emulate print media and verify chrome hidden + header/comments/footer visible + real PDF output
    await cdp.send("Emulation.setEmulatedMedia", { media: "print" });
    await sleep(250);
    const printAudit = await evalJS(cdp, `(() => {
      const vis = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).display : "missing";
      };
      return {
        headerBar: vis("header"),
        commentsPanel: vis("[data-comments-panel]"),
        printHeader: vis("[data-doc-print-header]"),
        printComments: vis("[data-doc-print-comments]"),
        printFooter: vis("[data-doc-print-footer]"),
        printHeaderText: document.querySelector("[data-doc-print-header]")?.innerText || "",
        printCommentsText: document.querySelector("[data-doc-print-comments]")?.innerText || "",
        printFooterText: document.querySelector("[data-doc-print-footer]")?.innerText || "",
      };
    })()`);
    console.log("Print media audit:", JSON.stringify(printAudit));
    if (printAudit.headerBar !== "none" || printAudit.commentsPanel !== "none") {
      throw new Error(`Expected app chrome hidden in print media: ${JSON.stringify(printAudit)}`);
    }
    if (printAudit.printHeader === "none" || printAudit.printComments === "none" || printAudit.printFooter === "none") {
      throw new Error(`Expected print header/comments/footer visible in print media: ${JSON.stringify(printAudit)}`);
    }
    if (!printAudit.printCommentsText.includes("请补充回滚开关与降级 SLA 指标")) {
      throw new Error(`Comments appendix missing imported comment: ${printAudit.printCommentsText}`);
    }
    await screenshot(cdp, "03-print-media-desktop.png", { captureBeyondViewport: true });

    const pdfRes = await cdp.send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
    const pdfBuf = Buffer.from(pdfRes.data, "base64");
    const pdfPath = `${OUT_DIR}/exported-doc.pdf`;
    writeFileSync(pdfPath, pdfBuf);
    console.log(`Generated real PDF (${pdfBuf.length} bytes) at ${pdfPath}`);
    if (!pdfBuf.subarray(0, 5).equals(Buffer.from("%PDF-")) || pdfBuf.length < 10_000) {
      throw new Error(`Invalid generated PDF: header=${pdfBuf.subarray(0, 8).toString()} size=${pdfBuf.length}`);
    }

    await cdp.send("Emulation.setEmulatedMedia", { media: "" });
    await sleep(200);

    // 4. Reload page to confirm full PostgreSQL 16 persistence
    await evalJS(cdp, `window.__beforeReload = 1`);
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(
      cdp,
      "persisted doc after reload",
      () => {
        if (window.__beforeReload) return false;
        const text = document.body.innerText;
        const img = document.querySelector('[data-print-doc] img[src*="/api/files/"]');
        return (
          !!document.querySelector("[data-more-menu]") &&
          !!document.querySelector('[data-status="synced"]') &&
          text.includes("核心加粗") &&
          text.includes("脚注与尾注") &&
          img &&
          img.complete &&
          img.naturalWidth > 0
        );
      },
      15000,
    );

    // 5. Mobile 390x844 verification
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    const mobileDocOverflow = await evalJS(cdp, `document.documentElement.scrollWidth - window.innerWidth`);
    console.log("Mobile doc overflow px:", mobileDocOverflow);
    if (mobileDocOverflow > 1) throw new Error(`Mobile doc horizontal overflow: ${mobileDocOverflow}px`);

    await evalJS(cdp, `document.querySelector("[data-more-menu]").click()`);
    await waitFor(cdp, "mobile print menu button", () => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "打印"));
    await evalJS(cdp, `[...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "打印").click()`);
    await waitFor(cdp, "mobile print dialog open", () => !!document.querySelector("[data-doc-print-dialog]"));
    await sleep(200);
    const mobileModalOverflow = await evalJS(cdp, `document.documentElement.scrollWidth - window.innerWidth`);
    console.log("Mobile print dialog overflow px:", mobileModalOverflow);
    if (mobileModalOverflow > 1) throw new Error(`Mobile print dialog overflow: ${mobileModalOverflow}px`);
    await screenshot(cdp, "04-print-dialog-mobile.png");

    if (cdp.consoleErrors.length) {
      throw new Error(`Console errors recorded: ${cdp.consoleErrors.join(" | ")}`);
    }
    console.log("ALL DOCX FIDELITY + PRINT/PDF E2E CHECKS PASSED WITH 0 CONSOLE ERRORS!");
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
