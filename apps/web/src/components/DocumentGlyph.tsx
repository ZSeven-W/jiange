import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Icons are rendered as text, never as HTML or an image URL. Older databases
// may contain arbitrary strings, so fall back rather than rendering controls.
export function displayDocumentIcon(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || [...value].length > 16 || /[\p{Cc}\p{Cs}\p{Z}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff<>\u0026/\\:]/u.test(value)) return undefined;
  return value;
}

export function DocumentGlyph({ icon, fallback, className }: { icon?: string; fallback: ReactNode; className?: string }) {
  const text = displayDocumentIcon(icon);
  return text ? <span aria-hidden="true" className={cn("inline-grid size-[18px] shrink-0 place-items-center text-[16px] leading-none", className)}>{text}</span> : <>{fallback}</>;
}
