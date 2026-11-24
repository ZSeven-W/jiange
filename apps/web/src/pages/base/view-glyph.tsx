import type { View } from "@/lib/api";

const colors: Record<View["type"], string> = { grid: "#3370ff", kanban: "#34b768", calendar: "#2eafa4", gantt: "#d95c9f", gallery: "#8758d8", hierarchy: "#0ea5a4", form: "#ed823d" };

/** Compact view glyphs based on the Feishu view picker. */
export function ViewGlyph({ type }: { type: View["type"] }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={colors[type]} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
    {type === "grid" && <><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1"/><path d="M2.5 6h11M2.5 9.8h11M6 2.5v11"/></>}
    {type === "kanban" && <><rect x="2" y="2.5" width="3.1" height="6" rx=".4"/><rect x="6.45" y="2.5" width="3.1" height="9.5" rx=".4"/><rect x="10.9" y="2.5" width="3.1" height="7.5" rx=".4"/></>}
    {type === "calendar" && <><rect x="2.2" y="3.1" width="11.6" height="10.7" rx="1"/><path d="M2.5 6.3h11M5 2v2.4M11 2v2.4M5.2 8.8h.1M8 8.8h.1M10.8 8.8h.1M5.2 11.2h.1M8 11.2h.1"/></>}
    {type === "gantt" && <><path d="M2 3h3.8v2H2zM5 7h6v2H5zM8 11h6v2H8z"/></>}
    {type === "gallery" && <><rect x="2.2" y="2.2" width="4.4" height="4.4" rx=".6"/><rect x="9.4" y="2.2" width="4.4" height="4.4" rx=".6"/><rect x="2.2" y="9.4" width="4.4" height="4.4" rx=".6"/><rect x="9.4" y="9.4" width="4.4" height="4.4" rx=".6"/></>}
    {type === "hierarchy" && <><rect x="2.2" y="2.2" width="4.4" height="3.2" rx=".6"/><rect x="8.8" y="6.6" width="5" height="2.8" rx=".6"/><rect x="8.8" y="11" width="5" height="2.8" rx=".6"/><path d="M4.4 5.4V12.4H8.8M4.4 8H8.8"/></>}
    {type === "form" && <><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1"/><path d="M4.3 5.1l.7.7 1.1-1.3M8 5.3h3.4M4.3 9l.7.7 1.1-1.3M8 9.2h3.4"/></>}
  </svg>;
}
