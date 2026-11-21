import { markdownTableRows, type MdBlock, type MdSpan } from "./markdown.js";
import { tableDataOf } from "./table-cells.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeHtmlHref(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith("#/") || trimmed.startsWith("/")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:" ? trimmed : null;
  } catch {
    return null;
  }
}

function renderSpansToHtml(spans: readonly MdSpan[]): string {
  return spans
    .map((span) => {
      let out = escapeHtml(span.text).replace(/\n/g, "<br/>");
      const m = span.marks;
      if (m.code) out = `<code>${out}</code>`;
      if (m.bold) out = `<strong>${out}</strong>`;
      if (m.italic) out = `<em>${out}</em>`;
      if (m.underline) out = `<u>${out}</u>`;
      if (m.strike) out = `<del>${out}</del>`;
      const href = safeHtmlHref(m.link);
      if (href) out = `<a href="${escapeHtml(href)}">${out}</a>`;
      return out;
    })
    .join("");
}

/** Serialize document blocks into clean, semantic, XSS-safe HTML. */
export function blocksToHtml(blocks: readonly { type: string; text?: string; props: Record<string, string>; spans: MdSpan[] }[]): string {
  const out: string[] = [];
  let listKind: "ul" | "ol" | null = null;
  const closeList = () => { if (listKind) { out.push(`</${listKind}>`); listKind = null; } };

  for (const b of blocks) {
    if (b.type === "title") continue;
    if (b.type === "bullet" || b.type === "todo") {
      if (listKind !== "ul") { closeList(); out.push("<ul>"); listKind = "ul"; }
      const prefix = b.type === "todo" ? `<input type="checkbox" disabled${b.props.checked === "true" ? " checked" : ""}/> ` : "";
      out.push(`<li>${prefix}${renderSpansToHtml(b.spans)}</li>`);
      continue;
    }
    if (b.type === "ordered") {
      if (listKind !== "ol") { closeList(); out.push("<ol>"); listKind = "ol"; }
      out.push(`<li>${renderSpansToHtml(b.spans)}</li>`);
      continue;
    }
    closeList();
    if (/^h[1-9]$/.test(b.type)) {
      const lvl = Math.min(6, Number(b.type[1]));
      out.push(`<h${lvl}>${renderSpansToHtml(b.spans)}</h${lvl}>`);
    } else if (b.type === "quote" || b.type === "callout") {
      out.push(`<blockquote>${renderSpansToHtml(b.spans)}</blockquote>`);
    } else if (b.type === "code" || b.type === "diagram" || b.type === "math") {
      const lang = b.props.lang ? ` class="language-${escapeHtml(b.props.lang)}"` : "";
      const raw = b.text ?? b.spans.map((s) => s.text).join("");
      out.push(`<pre><code${lang}>${escapeHtml(raw)}</code></pre>`);
    } else if (b.type === "divider") {
      out.push("<hr/>");
    } else if (b.type === "table") {
      const rows = markdownTableRows(tableDataOf(b.props));
      if (rows && rows.length) {
        const hasHeader = b.props.tableHeader !== "none";
        const rowHtml = rows.map((row, ri) => {
          const tag = hasHeader && ri === 0 ? "th" : "td";
          return `<tr>${row.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("")}</tr>`;
        });
        out.push(`<table>${rowHtml.join("")}</table>`);
      }
    } else if (b.type === "image") {
      const src = safeHtmlHref(b.props.url);
      const alt = escapeHtml(b.props.name ?? "image");
      out.push(src ? `<img src="${escapeHtml(src)}" alt="${alt}"/>` : `<p>[${alt}]</p>`);
    } else {
      out.push(`<p>${renderSpansToHtml(b.spans)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

function parseInlineHtml(html: string): MdSpan[] {
  const spans: MdSpan[] = [];
  const stack: { tag: string; marks: Record<string, string> }[] = [];
  const activeMarks = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const item of stack) Object.assign(out, item.marks);
    return out;
  };
  const pushText = (raw: string) => {
    const text = decodeHtmlEntities(raw);
    if (!text) return;
    const marks = activeMarks();
    const prev = spans[spans.length - 1];
    if (prev && JSON.stringify(prev.marks) === JSON.stringify(marks)) prev.text += text;
    else spans.push({ text, marks });
  };

  const tokenRe = /(<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    if (match.index > last) pushText(html.slice(last, match.index));
    const tagStr = match[1];
    last = match.index + tagStr.length;
    if (/^<br\s*\/?>$/i.test(tagStr)) { pushText("\n"); continue; }
    const closeM = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>$/.exec(tagStr);
    if (closeM) {
      const name = closeM[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === name) { stack.splice(i, 1); break; }
      continue;
    }
    if (tagStr.endsWith("/>")) continue;
    const openM = /^<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>$/.exec(tagStr);
    if (!openM) continue;
    const name = openM[1].toLowerCase();
    const attrs = openM[2];
    if (name === "strong" || name === "b") stack.push({ tag: name, marks: { bold: "1" } });
    else if (name === "em" || name === "i") stack.push({ tag: name, marks: { italic: "1" } });
    else if (name === "u") stack.push({ tag: name, marks: { underline: "1" } });
    else if (name === "del" || name === "s" || name === "strike") stack.push({ tag: name, marks: { strike: "1" } });
    else if (name === "code") stack.push({ tag: name, marks: { code: "1" } });
    else if (name === "a") {
      const hrefM = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const safe = safeHtmlHref(decodeHtmlEntities(hrefM?.[1] ?? hrefM?.[2] ?? ""));
      stack.push({ tag: name, marks: safe ? { link: safe } : {} });
    }
  }
  if (last < html.length) pushText(html.slice(last));
  return spans;
}

/** Parse sanitized HTML into Jiange `MdBlock[]` without a DOM or third-party parser. */
export function parseHtml(html: string): MdBlock[] {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (!cleaned) return [];

  const blocks: MdBlock[] = [];
  const blockRe = /<(h[1-6]|p|blockquote|pre|ul|ol|table|hr|img)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(cleaned)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const inner = m[3] ?? "";

    if (tag === "hr") {
      blocks.push({ type: "divider", text: "", props: {}, spans: [] });
    } else if (tag === "img") {
      const srcM = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const altM = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const safe = safeHtmlHref(decodeHtmlEntities(srcM?.[1] ?? srcM?.[2] ?? ""));
      blocks.push({ type: "image", text: "", props: { ...(safe ? { url: safe } : {}), name: decodeHtmlEntities(altM?.[1] ?? altM?.[2] ?? "image") }, spans: [] });
    } else if (tag === "pre") {
      const codeM = /<code\b([^>]*)>([\s\S]*?)<\/code>/i.exec(inner);
      const langM = codeM ? /language-([a-zA-Z0-9_+#.-]+)/i.exec(codeM[1]) : null;
      const text = decodeHtmlEntities(codeM ? codeM[2] : inner).replace(/^\n|\n$/g, "");
      blocks.push({ type: "code", text, props: langM ? { lang: langM[1] } : {}, spans: [] });
    } else if (tag === "ul" || tag === "ol") {
      const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let li: RegExpExecArray | null;
      while ((li = liRe.exec(inner)) !== null) {
        const rawLi = li[1].trim();
        const checkM = /^<input\b[^>]*type\s*=\s*["']?checkbox["']?[^>]*>/i.exec(rawLi);
        if (tag === "ul" && checkM) {
          const checked = /\bchecked\b/i.test(checkM[0]);
          const spans = parseInlineHtml(rawLi.slice(checkM[0].length).trim());
          blocks.push({ type: "todo", text: spans.map((s) => s.text).join(""), props: { checked: checked ? "true" : "false" }, spans });
        } else {
          const spans = parseInlineHtml(rawLi);
          blocks.push({ type: tag === "ol" ? "ordered" : "bullet", text: spans.map((s) => s.text).join(""), props: {}, spans });
        }
      }
    } else if (tag === "table") {
      const rows: string[][] = [];
      const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let tr: RegExpExecArray | null;
      while ((tr = trRe.exec(inner)) !== null) {
        const row: string[] = [];
        const tdRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
        let td: RegExpExecArray | null;
        while ((td = tdRe.exec(tr[1])) !== null) {
          row.push(parseInlineHtml(td[1]).map((s) => s.text).join("").trim());
        }
        if (row.length) rows.push(row);
      }
      if (rows.length) {
        const maxCols = rows.reduce((mx, r) => Math.max(mx, r.length), 1);
        const norm = rows.map((r) => [...r, ...Array(maxCols - r.length).fill("")]);
        blocks.push({ type: "table", text: "", props: { tableData: JSON.stringify(norm) }, spans: [] });
      }
    } else {
      const spans = parseInlineHtml(inner.trim());
      const type = tag === "blockquote" ? "quote" : tag === "p" ? "paragraph" : tag;
      blocks.push({ type, text: spans.map((s) => s.text).join(""), props: {}, spans });
    }
  }
  return blocks;
}
