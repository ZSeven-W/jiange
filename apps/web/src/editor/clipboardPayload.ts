import { parseText, type ClipBlock } from "./model";

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
        if (blocks.length > 1 || blocks[0].chars.length > 0) return blocks;
      }
    } catch { /* Use plain text if the custom data is invalid. */ }
  }
  return plain ? parseText(plain) : null;
}
