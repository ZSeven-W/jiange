export type SlideShape = { id: string; kind: "rectangle" | "ellipse" | "triangle" | "rounded-rectangle" | "right-triangle" | "diamond" | "pentagon" | "hexagon" | "star" | "parallelogram" | "trapezoid" | "arrow-right" | "line" | "line-arrow" | "line-arrow-filled" | "line-dot" | "line-double-arrow" | "text" | "image"; x: number; y: number; color: string; width?: number; height?: number; rotation?: number; text?: string; fontSize?: number; bold?: boolean; align?: "left" | "center" | "right"; fileId?: number };
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
}
