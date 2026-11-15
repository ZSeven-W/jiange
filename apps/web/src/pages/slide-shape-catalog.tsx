import type { SlideShape } from "@/lib/api";

export type BasicSlideShape = Exclude<SlideShape["kind"], "text" | "image">;
export const SLIDE_SHAPES: { kind: BasicSlideShape; label: string; group: "基础" | "箭头" }[] = [
  { kind: "rectangle", label: "矩形", group: "基础" }, { kind: "rounded-rectangle", label: "圆角矩形", group: "基础" },
  { kind: "parallelogram", label: "平行四边形", group: "基础" }, { kind: "ellipse", label: "椭圆", group: "基础" },
  { kind: "triangle", label: "三角形", group: "基础" }, { kind: "right-triangle", label: "直角三角形", group: "基础" },
  { kind: "diamond", label: "菱形", group: "基础" }, { kind: "pentagon", label: "五边形", group: "基础" },
  { kind: "hexagon", label: "六边形", group: "基础" }, { kind: "star", label: "五角星", group: "基础" },
  { kind: "trapezoid", label: "梯形", group: "基础" }, { kind: "arrow-right", label: "向右箭头", group: "箭头" },
];
const paths: Record<BasicSlideShape, string> = {
  rectangle: "M4 4H96V96H4Z", "rounded-rectangle": "M16 4H84Q96 4 96 16V84Q96 96 84 96H16Q4 96 4 84V16Q4 4 16 4Z",
  ellipse: "M50 3A47 47 0 1 1 49.99 3Z", triangle: "M50 3L97 96H3Z", "right-triangle": "M4 4L96 96H4Z",
  diamond: "M50 3L97 50L50 97L3 50Z", pentagon: "M50 3L96 36L79 96H21L4 36Z", hexagon: "M25 4H75L97 50L75 96H25L3 50Z",
  star: "M50 3L61 35H96L68 56L79 94L50 72L21 94L32 56L4 35H39Z",
  parallelogram: "M25 4H97L75 96H3Z", trapezoid: "M24 4H76L97 96H3Z", "arrow-right": "M4 30H57V8L97 50L57 92V70H4Z",
};
export function SlideShapeGraphic({ kind, color, outline = false }: { kind: BasicSlideShape; color: string; outline?: boolean }) {
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true"><path d={paths[kind]} fill={outline ? "none" : color} stroke={outline ? color : "none"} strokeWidth={outline ? 4 : 0} strokeLinejoin="round"/></svg>;
}
