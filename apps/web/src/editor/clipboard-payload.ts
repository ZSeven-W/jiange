import { CLIPPABLE_BLOCKS, parseTableData, parseText, TEXTLESS, type ClipBlock } from "./model";
import { tableDataOf } from "./table-cells";
import { formatTableTSV } from "./table-clipboard";
import { coverMap, parseMerges } from "./table-ops";

export const CLIP_MIME = "application/x-jiange-blocks";
const MAX_CLIP_BYTES = 2 * 1024 * 1024;
const MARKER = "data-jiange-blocks";

/** A whole-table clipboard payload must not silently expose hidden merged cells. */
export function hasHiddenTableContent(block: ClipBlock): boolean {
  if (block.type !== "table") return false;
  const rows = parseTableData(tableDataOf(block.props));
  const covered = coverMap(parseMerges(block.props.tableMerges, rows.length, rows[0]?.length ?? 0));
  return rows.some((row, r) => row.some((value, c) => covered.get(`${r}:${c}`) === "hidden" && value !== ""));
}

/** Plain text remains useful in other applications; HTML holds the rich block. */
export function blockClipboardPlain(block: ClipBlock): string {
  if (block.type === "table") {
    const rows = parseTableData(tableDataOf(block.props));
    if (rows.length && rows[0]?.length) return formatTableTSV(rows, { r0: 0, r1: rows.length - 1, c0: 0, c1: rows[0].length - 1 }, parseMerges(block.props.tableMerges, rows.length, rows[0].length));
  }
  return block.props.caption || block.props.name || block.props.url || ({ image: "[图片]", file: "[附件]", table: "[表格]", divider: "---", bookmark: "[网页卡片]", video: "[视频]", flowchart: "[流程图]" } as Record<string, string>)[block.type] || "[文档块]";
}

function base64Utf8(value: string): string | null {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_CLIP_BYTES) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

const escapeHTML = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function blockClipboardHTML(raw: string, plain: string, blocks?: ClipBlock[]): string | null {
  const payload = base64Utf8(raw);
  if (!payload) return null;
  let content = escapeHTML(plain).replace(/\n/g, "<br>");
  if (blocks?.length === 1 && blocks[0].type === "table") {
    const block = blocks[0], rows = parseTableData(tableDataOf(block.props));
    const covered = coverMap(parseMerges(block.props.tableMerges, rows.length, rows[0]?.length ?? 0));
    content = `<table>${rows.map((row, r) => `<tr>${row.map((value, c) => {
      const cell = covered.get(`${r}:${c}`);
      if (cell === "hidden") return "";
      const span = cell?.span;
      return `<td${span?.[0] ? ` rowspan="${span[0]}"` : ""}${span?.[1] ? ` colspan="${span[1]}"` : ""}>${escapeHTML(value).replace(/\n/g, "<br>")}</td>`;
    }).join("")}</tr>`).join("")}</table>`;
  }
  const html = `<div ${MARKER}="${payload}">${content}</div>`;
  return html.length <= MAX_CLIP_BYTES * 3 ? html : null;
}

/** Read only our opening tag; never parse or load resources from pasted HTML. */
export function blockPayloadFromHTML(html: string): string | null {
  if (html.length > MAX_CLIP_BYTES * 3 || !/data-jiange-blocks/i.test(html)) return null;
  try {
    // Accept only an envelope at the start of the clipboard fragment (after
    // common browser wrappers), never markup buried in scripts or unrelated HTML.
    let offset = 0;
    while (offset < html.length && offset < 8192) {
      const space = /^\s+/.exec(html.slice(offset));
      if (space) { offset += space[0].length; continue; }
      if (html.startsWith("<!--", offset)) {
        const end = html.indexOf("-->", offset + 4);
        if (end < 0 || end > 8192) return null;
        offset = end + 3; continue;
      }
      const wrapper = /^(?:<!doctype\s+html\s*>|<html(?:\s[^<>]*)?>|<body(?:\s[^<>]*)?>|<meta\s[^<>]*>)/i.exec(html.slice(offset));
      if (wrapper) { offset += wrapper[0].length; continue; }
      break;
    }
    if (offset >= 8192) return null;
    const first = /^<div\s+data-jiange-blocks\s*=\s*(["'])([A-Za-z0-9+/=]+)\1\s*>/i.exec(html.slice(offset));
    if (!first || /<div\s+data-jiange-blocks\s*=/i.test(html.slice(offset + first[0].length))) return null;
    const payload = first[2];
    if (!payload || payload.length > Math.ceil(MAX_CLIP_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
    const binary = atob(payload);
    if (binary.length > MAX_CLIP_BYTES) return null;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const blocks = clipboardBlocks(raw, "");
    return blocks?.length === 1 && CLIPPABLE_BLOCKS.has(blocks[0].type) && blocks[0].chars.length === 0 ? raw : null;
  } catch { return null; }
}

export async function writeBlockClipboard(clipboard: Pick<Clipboard, "write"> | undefined, Item: typeof ClipboardItem | undefined, plain: string, blocks: ClipBlock[], timeoutMs = 5000): Promise<string | null> {
  if (!clipboard || !Item) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = JSON.stringify(blocks), html = blockClipboardHTML(raw, plain, blocks);
    if (!html) return null;
    const write = clipboard.write([new Item({ "text/plain": new Blob([plain], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]).then(() => true);
    const ok = await Promise.race([write, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    return ok ? raw : null;
  } catch { return null; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** A cut only removes the source after the exact structured format is readable. */
export async function confirmBlockClipboard(clipboard: Pick<Clipboard, "read"> | undefined, expected: string, timeoutMs = 5000): Promise<boolean> {
  if (!clipboard) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const check = (async () => {
      const items = await clipboard.read();
      for (const item of items) {
        if (!item.types.includes("text/html")) continue;
        const html = await item.getType("text/html");
        if (html.size <= MAX_CLIP_BYTES * 6 && blockPayloadFromHTML(await html.text()) === expected) return true;
      }
      return false;
    })();
    return await Promise.race([check, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } catch { return false; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** The source is never removed when readback fails or the document changed. */
export async function cutConfirmedBlock(
  clipboard: Pick<Clipboard, "read"> | undefined,
  expected: string,
  canDelete: () => boolean,
  remove: () => void,
  timeoutMs = 5000,
): Promise<"cut" | "unconfirmed" | "changed"> {
  if (!await confirmBlockClipboard(clipboard, expected, timeoutMs)) return "unconfirmed";
  if (!canDelete()) return "changed";
  remove();
  return "cut";
}

function stringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string");
}

/** Validate custom clipboard data before a transaction can delete selection. */
export function clipboardBlocks(raw: string, plain: string): ClipBlock[] | null {
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value) && value.length > 0 && value.every((block) =>
        block && typeof block === "object" && typeof block.type === "string" && !!block.type && stringRecord(block.props) && (block.source === undefined || !!block.source && typeof block.source === "object" && typeof block.source.origin === "string" && block.source.origin.length <= 512 && Number.isSafeInteger(block.source.docId) && block.source.docId > 0) && Array.isArray(block.chars) && block.chars.every((char: unknown) => {
          if (!char || typeof char !== "object") return false;
          const item = char as { ch?: unknown; marks?: unknown };
          return typeof item.ch === "string" && [...item.ch].length === 1 && stringRecord(item.marks);
        }),
      )) {
        const blocks = value as ClipBlock[];
        // pasteBlocks merges a single block as text regardless of its type;
        // a textless image/divider would otherwise only delete the selection.
        if (blocks.length > 1 || blocks[0].chars.length > 0 || CLIPPABLE_BLOCKS.has(blocks[0].type)) return blocks.map((block) => {
          if (block.type !== "table") return block;
          // A fresh block must not inherit sparse registers whose explicit
          // empty values could be dropped by generic block creation. Materialize
          // the effective grid and let the new table migrate independently.
          if (block.props["tbl.v"] === "2") {
            const rows: unknown = JSON.parse(block.props["tbl.rows"] ?? "null");
            const cols: unknown = JSON.parse(block.props["tbl.cols"] ?? "null");
            if (Array.isArray(rows) && Array.isArray(cols) && (rows.length > 5000 || cols.length > 5000 || rows.length * cols.length > 50_000)) throw new Error("clipboard table too large");
          }
          const props = Object.fromEntries(Object.entries(block.props).filter(([key]) => !key.startsWith("tbl.")));
          props.tableData = tableDataOf(block.props);
          return { ...block, props };
        });
      }
    } catch { /* Use plain text if the custom data is invalid. */ }
  }
  return plain ? parseText(plain) : null;
}

/** A column supports one text block; flatten copied block breaks into newlines. */
export function columnClipboardBlocks(raw: string, plain: string): ClipBlock[] | null {
  const blocks = clipboardBlocks(raw, plain);
  if (!blocks) return null;
  // Columns have no nested media/source blocks; do not silently discard one.
  if (blocks.some((block) => TEXTLESS.has(block.type)) || (!plain && blocks.every((block) => block.chars.length === 0))) return null;
  const chars: ClipBlock["chars"] = [];
  blocks.forEach((block, i) => {
    if (i) chars.push({ ch: "\n", marks: {} });
    chars.push(...block.chars);
  });
  return chars.length ? [{ type: "paragraph", props: {}, chars }] : null;
}
