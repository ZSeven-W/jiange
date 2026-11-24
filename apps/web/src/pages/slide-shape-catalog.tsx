import type { SlideShape } from "@/lib/api";
import { t } from "@/lib/i18n";

export type BasicSlideShape = Exclude<SlideShape["kind"], "text" | "image" | "table" | "chart" | "video" | "audio">;
export const SLIDE_SHAPES: { kind: BasicSlideShape; label: string; group: "基础" | "线条" | "箭头" }[] = [
  { kind: "rectangle", get label() { return t("矩形"); }, group: "基础" },
  { kind: "rounded-rectangle", get label() { return t("圆角矩形"); }, group: "基础" },
  { kind: "parallelogram", get label() { return t("平行四边形"); }, group: "基础" },
  { kind: "ellipse", get label() { return t("椭圆"); }, group: "基础" },
  { kind: "triangle", get label() { return t("三角形"); }, group: "基础" },
  { kind: "right-triangle", get label() { return t("直角三角形"); }, group: "基础" },
  { kind: "diamond", get label() { return t("菱形"); }, group: "基础" },
  { kind: "pentagon", get label() { return t("五边形"); }, group: "基础" },
  { kind: "hexagon", get label() { return t("六边形"); }, group: "基础" },
  { kind: "star", get label() { return t("五角星"); }, group: "基础" },
  { kind: "trapezoid", get label() { return t("梯形"); }, group: "基础" },
  { kind: "line", get label() { return t("直线"); }, group: "线条" },
  { kind: "line-arrow", get label() { return t("开放箭头线"); }, group: "线条" },
  { kind: "line-arrow-filled", get label() { return t("实心箭头线"); }, group: "线条" },
  { kind: "line-dot", get label() { return t("圆点线"); }, group: "线条" },
  { kind: "line-double-arrow", get label() { return t("双向箭头线"); }, group: "线条" },
  { kind: "arrow-right", get label() { return t("向右箭头"); }, group: "箭头" },
];
type LineShape = Extract<BasicSlideShape, `line${string}`>;
export function isLineSlideShape(kind: BasicSlideShape): kind is LineShape { return kind === "line" || kind.startsWith("line-"); }
const paths: Record<Exclude<BasicSlideShape, LineShape>, string> = {
  rectangle: "M4 4H96V96H4Z", "rounded-rectangle": "M16 4H84Q96 4 96 16V84Q96 96 84 96H16Q4 96 4 84V16Q4 4 16 4Z",
  ellipse: "M50 3A47 47 0 1 1 49.99 3Z", triangle: "M50 3L97 96H3Z", "right-triangle": "M4 4L96 96H4Z",
  diamond: "M50 3L97 50L50 97L3 50Z", pentagon: "M50 3L96 36L79 96H21L4 36Z", hexagon: "M25 4H75L97 50L75 96H25L3 50Z",
  star: "M50 3L61 35H96L68 56L79 94L50 72L21 94L32 56L4 35H39Z",
  parallelogram: "M25 4H97L75 96H3Z", trapezoid: "M24 4H76L97 96H3Z", "arrow-right": "M4 30H57V8L97 50L57 92V70H4Z",
};
export function SlideShapeGraphic({ kind, color, outline = false }: { kind: BasicSlideShape; color: string; outline?: boolean }) {
  if (isLineSlideShape(kind)) return <span className="relative block h-full w-full" aria-hidden="true">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full"><path d="M5 50H95" fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>
    {(kind === "line-arrow" || kind === "line-arrow-filled" || kind === "line-double-arrow") && <svg viewBox="0 0 20 20" className="absolute right-[4%] top-1/2 h-[55%] w-auto max-w-[20%] -translate-y-1/2"><path d={kind === "line-arrow-filled" ? "M3 3L17 10L3 17Z" : "M3 3L17 10L3 17"} fill={kind === "line-arrow-filled" ? color : "none"} stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/></svg>}
    {kind === "line-double-arrow" && <svg viewBox="0 0 20 20" className="absolute left-[4%] top-1/2 h-[55%] w-auto max-w-[20%] -translate-y-1/2"><path d="M17 3L3 10L17 17" fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/></svg>}
    {kind === "line-dot" && <svg viewBox="0 0 20 20" className="absolute right-[4%] top-1/2 h-[55%] w-auto max-w-[20%] -translate-y-1/2"><circle cx="10" cy="10" r="5" fill={color}/></svg>}
  </span>;
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true"><path d={paths[kind]} fill={outline ? "none" : color} stroke={outline ? color : "none"} strokeWidth={outline ? 4 : 0} strokeLinejoin="round"/></svg>;
}
