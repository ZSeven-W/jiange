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
