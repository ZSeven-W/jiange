import type { SlideCreationLayout, SlideShape } from "@/lib/api";

/** Must match the server's atomic two-column creation preset. */
export const TWO_COLUMN_SHAPES: SlideShape[] = [
  { id: "preset-two-title", kind: "text", x: 7, y: 8, width: 86, height: 12, color: "#1f2329", text: "", fontSize: 36, bold: true },
  { id: "preset-two-left", kind: "text", x: 7, y: 27, width: 40, height: 57, color: "#1f2329", text: "", fontSize: 24 },
  { id: "preset-two-right", kind: "text", x: 53, y: 27, width: 40, height: 57, color: "#1f2329", text: "", fontSize: 24 },
];

export function slidePresetContent(preset: SlideCreationLayout) {
  return { title: "", body: "", notes: "", background: "", layout: preset === "two-column" ? "blank" as const : preset, shapes: preset === "two-column" ? TWO_COLUMN_SHAPES : [] };
}

export function slidePresetPlaceholder(id: string): string | null {
  return id === "preset-two-title" ? "点击添加标题" : id === "preset-two-left" || id === "preset-two-right" ? "点击添加内容" : null;
}

export function slidePresetControlLabel(id: string, hasText = false): string | null {
  return id === "preset-two-title" ? (hasText ? "标题文本框" : "点击添加标题") : id === "preset-two-left" ? (hasText ? "左栏文本框" : "点击添加左栏内容") : id === "preset-two-right" ? (hasText ? "右栏文本框" : "点击添加右栏内容") : null;
}
