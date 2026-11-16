import type { SlideCreationLayout, SlideShape } from "@/lib/api";
import type { SlideContent } from "./slides-draft";

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

const PRESET_IDS = new Set(TWO_COLUMN_SHAPES.map((shape) => shape.id));
export function isTwoColumnSlide(content: Pick<SlideContent, "layout" | "shapes">): boolean {
  return content.layout === "blank" && TWO_COLUMN_SHAPES.every((preset) => content.shapes.some((shape) => shape.id === preset.id && shape.kind === "text"));
}

/** Remove only untouched empty placeholders; modified ones remain editable objects. */
function pristinePlaceholder(shape: SlideShape, original: SlideShape): boolean {
  const known = new Set(["id", "kind", "x", "y", "width", "height", "color", "text", "fontSize", "bold", "align", "rotation"]);
  return Object.keys(shape).every((key) => known.has(key)) && shape.id === original.id && shape.kind === original.kind && shape.x === original.x && shape.y === original.y && (shape.width ?? 16) === (original.width ?? 16) && (shape.height ?? 20) === (original.height ?? 20) && shape.color === original.color && (shape.text ?? "") === "" && (shape.fontSize ?? 24) === (original.fontSize ?? 24) && (shape.bold ?? false) === (original.bold ?? false) && (shape.align ?? "left") === (original.align ?? "left") && (shape.rotation ?? 0) === 0;
}

export function planSlideLayout(content: SlideContent, target: SlideCreationLayout): { ok: true; content: SlideContent } | { ok: false; message: string } {
  if (target === "two-column") {
    if (isTwoColumnSlide(content)) return { ok: true, content };
    if (content.shapes.some((shape) => PRESET_IDS.has(shape.id))) return { ok: false, message: "页面已有同名版式对象，请先处理后再切换；原内容已保留。" };
    if (content.shapes.length + TWO_COLUMN_SHAPES.length > 100) return { ok: false, message: "页面对象数量已达上限，原内容已保留。" };
    if ([...content.title].length > 1000 || [...content.body].length > 1000) return { ok: false, message: "标题或正文过长，无法放入双栏文本框；原内容已保留。" };
    const shapes = TWO_COLUMN_SHAPES.map((shape, index) => ({ ...shape, text: index === 0 ? content.title : index === 1 ? content.body : "" }));
    return { ok: true, content: { ...content, layout: "blank", title: "", body: "", shapes: [...content.shapes, ...shapes] } };
  }
  if (!isTwoColumnSlide(content)) return { ok: true, content: { ...content, layout: target } };
  const used = new Set(content.shapes.map((shape) => shape.id));
  let nextId = 1;
  const detached = (shape: SlideShape): SlideShape => {
    let id = `shape-detached-${nextId++}`;
    while (used.has(id)) id = `shape-detached-${nextId++}`;
    used.add(id);
    return { ...shape, id };
  };
  const shapes = content.shapes.flatMap((shape) => {
    const original = TWO_COLUMN_SHAPES.find((candidate) => candidate.id === shape.id);
    if (!original || shape.kind !== "text") return [shape];
    return pristinePlaceholder(shape, original) ? [] : [detached(shape)];
  });
  return { ok: true, content: { ...content, layout: target, shapes } };
}
