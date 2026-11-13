import { CLIPPABLE_BLOCKS, parseText, TEXTLESS, type ClipBlock } from "./model";
import { tableDataOf } from "./tableCells";

export const CLIP_MIME = "application/x-jiange-blocks";

/** Do not report success or delete a cut block unless the copy event supplied writable clipboard data. */
export function writeBlockClipboard(doc: Document, plain: string, blocks: ClipBlock[]): boolean {
  let written = false;
  const write = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    try {
      event.clipboardData.setData("text/plain", plain);
      event.clipboardData.setData(CLIP_MIME, JSON.stringify(blocks));
      event.preventDefault();
      written = true;
    } catch { /* leave the source intact */ }
  };
  doc.addEventListener("copy", write, { once: true, capture: true });
  let accepted = false;
  try { accepted = doc.execCommand("copy"); } catch { /* unsupported or denied */ }
  finally { doc.removeEventListener("copy", write, { capture: true }); }
  return accepted && written;
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
        block && typeof block === "object" && typeof block.type === "string" && !!block.type && stringRecord(block.props) && Array.isArray(block.chars) && block.chars.every((char: unknown) => {
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
