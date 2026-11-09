import { CLIPPABLE_BLOCKS, parseText, TEXTLESS, type ClipBlock } from "./model";

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
        if (blocks.length > 1 || blocks[0].chars.length > 0 || CLIPPABLE_BLOCKS.has(blocks[0].type)) return blocks;
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
