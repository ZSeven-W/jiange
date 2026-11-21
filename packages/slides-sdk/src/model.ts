export type SlideShapeKind =
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "rounded-rectangle"
  | "right-triangle"
  | "diamond"
  | "pentagon"
  | "hexagon"
  | "star"
  | "parallelogram"
  | "trapezoid"
  | "arrow-right"
  | "line"
  | "line-arrow"
  | "line-arrow-filled"
  | "line-dot"
  | "line-double-arrow"
  | "text"
  | "image"
  | "table"
  | "chart";

export interface SlideTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSize?: number;
}

export interface SlideTextParagraph {
  runs: SlideTextRun[];
  align?: "left" | "center" | "right";
  bullet?: boolean;
  level?: number;
}

export interface SlideTableData {
  rows: string[][];
  headerRow?: boolean;
  headerFill?: string;
  borderColor?: string;
}

export interface SlideChartSeries {
  name: string;
  values: number[];
  color?: string;
}

export interface SlideChartData {
  type: "column" | "bar" | "line" | "pie";
  title?: string;
  categories: string[];
  series: SlideChartSeries[];
}

export interface SlideMediaAsset {
  id: string;
  mimeType: "image/png" | "image/jpeg" | "image/svg+xml" | "image/webp";
  data: Uint8Array;
  name?: string;
}

export interface SlideTheme {
  name: string;
  background: string;
  primary: string;
  secondary: string;
  accent: string;
  textDark: string;
  textLight: string;
  fontFamily: string;
}

export interface SlideTransition {
  type: "none" | "fade" | "push" | "wipe";
  durationMs?: number;
}

export type SlideShape = {
  id: string;
  kind: SlideShapeKind;
  x: number;
  y: number;
  color: string;
  width?: number;
  height?: number;
  rotation?: number;
  text?: string;
  fontSize?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  fileId?: number;
  mediaId?: string;
  paragraphs?: SlideTextParagraph[];
  table?: SlideTableData;
  chart?: SlideChartData;
  strokeColor?: string;
  strokeWidth?: number;
  opacity?: number;
};

export type SlideLayout = "" | "title" | "blank" | "blank-title";
export type SlideCreationLayout = SlideLayout | "two-column";

export interface SlidesPage {
  id: number;
  slidesId: number;
  pos: number;
  title: string;
  body: string;
  background: string;
  layout?: SlideLayout;
  notes: string;
  shapes: SlideShape[];
  hidden: boolean;
  revision: number;
  updatedAt: string;
  transition?: SlideTransition;
}

export interface SlideDeck {
  title: string;
  theme: SlideTheme;
  pages: SlidesPage[];
  media?: Record<string, SlideMediaAsset>;
}

export const DEFAULT_SLIDE_THEME: SlideTheme = {
  name: "Jiange Default",
  background: "#ffffff",
  primary: "#3370ff",
  secondary: "#00b42a",
  accent: "#ff7d00",
  textDark: "#1f2329",
  textLight: "#ffffff",
  fontFamily: "Inter, PingFang SC, Microsoft YaHei, sans-serif",
};
