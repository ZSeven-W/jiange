import type { SlidePageTextStyles, SlideTextStyleMap } from "./slides-text-style";

export type SlideThemeId =
  | "feishu-blue"
  | "deep-ocean"
  | "fresh-mint"
  | "warm-amber"
  | "dark-geek"
  | "minimal-mono";

export interface SlideThemePreset {
  id: SlideThemeId;
  name: string;
  background: string;
  titleColor: string;
  bodyColor: string;
  accent: string;
}

export const SLIDE_THEMES: readonly SlideThemePreset[] = [
  {
    id: "feishu-blue",
    name: "飞书经典蓝",
    background: "#ffffff",
    titleColor: "#1f2329",
    bodyColor: "#4e5969",
    accent: "#3370ff",
  },
  {
    id: "deep-ocean",
    name: "深海商务",
    background: "#0f1f3d",
    titleColor: "#ffffff",
    bodyColor: "#cbd5e1",
    accent: "#4e83fd",
  },
  {
    id: "fresh-mint",
    name: "清新森绿",
    background: "#f0fdf4",
    titleColor: "#14532d",
    bodyColor: "#3f6212",
    accent: "#00b42a",
  },
  {
    id: "warm-amber",
    name: "暖阳活力",
    background: "#fffbeb",
    titleColor: "#78350f",
    bodyColor: "#92400e",
    accent: "#ff8800",
  },
  {
    id: "dark-geek",
    name: "暗夜极客",
    background: "#18181b",
    titleColor: "#fafafa",
    bodyColor: "#d4d4d8",
    accent: "#7b56d9",
  },
  {
    id: "minimal-mono",
    name: "极简黑白",
    background: "#f8fafc",
    titleColor: "#0f172a",
    bodyColor: "#475569",
    accent: "#1f2329",
  },
] as const;

export function getSlideTheme(id: string): SlideThemePreset | undefined {
  return SLIDE_THEMES.find((theme) => theme.id === id);
}

/** Match a slide's current background & text colors against curated Feishu themes. */
export function matchSlideTheme(
  background: string,
  textStyle?: SlidePageTextStyles,
): SlideThemePreset | null {
  const bg = background.trim().toLowerCase();
  if (!bg) return null;
  const titleColor = textStyle?.title?.color?.trim().toLowerCase();
  const bodyColor = textStyle?.body?.color?.trim().toLowerCase();
  return (
    SLIDE_THEMES.find(
      (theme) =>
        theme.background.toLowerCase() === bg &&
        (!titleColor || theme.titleColor.toLowerCase() === titleColor) &&
        (!bodyColor || theme.bodyColor.toLowerCase() === bodyColor),
    ) ?? null
  );
}

export function applyThemeToPageTextStyle(
  prev: SlidePageTextStyles | undefined,
  theme: SlideThemePreset,
): SlidePageTextStyles {
  return {
    ...prev,
    title: { ...prev?.title, color: theme.titleColor },
    body: { ...prev?.body, color: theme.bodyColor },
  };
}

export function applyThemeToTextStyles(
  prev: SlideTextStyleMap,
  pageIds: readonly number[],
  theme: SlideThemePreset,
): SlideTextStyleMap {
  const next: SlideTextStyleMap = { ...prev };
  for (const pageId of pageIds) {
    next[pageId] = applyThemeToPageTextStyle(prev[pageId], theme);
  }
  return next;
}
