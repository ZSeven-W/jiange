import type { SlideFieldTextStyleMeta, SlidePageMeta, SlideShapeAnimation, SlidesPage } from "@/lib/api";
import { normalizeSlideShapeAnimations } from "./slides-animations";

export type SlideTextAlign = "left" | "center" | "right";

export interface SlideFieldTextStyle {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: SlideTextAlign;
}

export interface SlidePageTextStyles {
  title?: SlideFieldTextStyle;
  body?: SlideFieldTextStyle;
}

export type SlideTextStyleMap = Record<number, SlidePageTextStyles>;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeSlideFieldTextStyle(
  style: SlideFieldTextStyle | SlideFieldTextStyleMeta | undefined,
): SlideFieldTextStyle | undefined {
  if (!style || typeof style !== "object") return undefined;
  const out: SlideFieldTextStyle = {};
  if (
    typeof style.fontSize === "number" &&
    Number.isFinite(style.fontSize) &&
    style.fontSize >= 12 &&
    style.fontSize <= 120
  ) {
    out.fontSize = style.fontSize;
  }
  if (typeof style.bold === "boolean") out.bold = style.bold;
  if (typeof style.italic === "boolean") out.italic = style.italic;
  if (typeof style.color === "string" && HEX_COLOR_RE.test(style.color)) {
    out.color = style.color;
  }
  if (style.align === "left" || style.align === "center" || style.align === "right") {
    out.align = style.align;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Hydrate per-page text styles directly from cloud-persisted page.meta. */
export function hydrateSlideTextStyles(
  pages: readonly Pick<SlidesPage, "id" | "meta">[] | undefined,
): SlideTextStyleMap {
  if (!pages?.length) return {};
  const result: SlideTextStyleMap = {};
  for (const page of pages) {
    const title = normalizeSlideFieldTextStyle(page.meta?.titleStyle);
    const body = normalizeSlideFieldTextStyle(page.meta?.bodyStyle);
    if (title || body) {
      const entry: SlidePageTextStyles = {};
      if (title) entry.title = title;
      if (body) entry.body = body;
      result[page.id] = entry;
    }
  }
  return result;
}

/** Compose a normalized cloud SlidePageMeta payload for a single slide page. */
export function buildSlidePageMeta(
  styles: SlidePageTextStyles | undefined,
  transition: SlidePageMeta["transition"] | undefined,
  shapeGroups: Record<string, string[]> | undefined,
  animations?: Record<string, SlideShapeAnimation> | undefined,
): SlidePageMeta {
  const meta: SlidePageMeta = {};
  const titleStyle = normalizeSlideFieldTextStyle(styles?.title);
  const bodyStyle = normalizeSlideFieldTextStyle(styles?.body);
  if (titleStyle) meta.titleStyle = titleStyle;
  if (bodyStyle) meta.bodyStyle = bodyStyle;
  if (transition === "fade" || transition === "push" || transition === "wipe") {
    meta.transition = transition;
  }
  if (shapeGroups && typeof shapeGroups === "object") {
    const cleanGroups: Record<string, string[]> = {};
    for (const [groupId, members] of Object.entries(shapeGroups)) {
      if (!groupId || !Array.isArray(members)) continue;
      const unique = [...new Set(members.filter((id): id is string => typeof id === "string" && id.length > 0))];
      if (unique.length >= 2) cleanGroups[groupId] = unique;
    }
    if (Object.keys(cleanGroups).length > 0) {
      meta.shapeGroups = cleanGroups;
    }
  }
  const cleanAnims = normalizeSlideShapeAnimations(animations as Record<string, unknown> | undefined);
  if (cleanAnims) {
    meta.animations = cleanAnims;
  }
  return meta;
}

const storageKey = (slidesId: number) => `jiange:slides:text-styles:${slidesId}`;

export function loadSlideTextStyles(slidesId: number): SlideTextStyleMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(storageKey(slidesId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSlideTextStyles(slidesId: number, styles: SlideTextStyleMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey(slidesId), JSON.stringify(styles));
  } catch {
    // Ignore storage quota errors
  }
}

const BULLET_PREFIX = /^(\s*)[•·\-*]\s+/;

export function bodyHasBullets(body: string): boolean {
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => BULLET_PREFIX.test(line));
}

export function toggleBodyBullets(body: string): string {
  if (!body.trim()) return "• ";
  const lines = body.split("\n");
  if (bodyHasBullets(body)) {
    return lines.map((line) => line.replace(BULLET_PREFIX, "$1")).join("\n");
  }
  return lines
    .map((line) => {
      if (!line.trim()) return line;
      if (BULLET_PREFIX.test(line)) return line;
      return `• ${line}`;
    })
    .join("\n");
}
