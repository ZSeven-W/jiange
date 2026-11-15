import { normalizeMindTextFormat, type MindTextFormat } from "./mindmap";
import type { FlowGraph } from "./model";
import { subscribeAuthChanges, subscribeLocalAuthChanges } from "@/lib/sessionCache";

export type MindTextStyleClip = { version: 1; size: number; color?: string; format: MindTextFormat };
/** On macOS Option can change event.key; use physical key codes for the advertised shortcut. */
export function mindTextStyleShortcut(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code">): "copy" | "paste" | null {
  if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) return null;
  if (event.code === "KeyC" || event.key.toLowerCase() === "c") return "copy";
  if (event.code === "KeyV" || event.key.toLowerCase() === "v") return "paste";
  return null;
}
let sessionTextStyle: MindTextStyleClip | null = null;
let sessionTextStyleRevision = 0;
export function clearMindTextStyleSession(): void { sessionTextStyle = null; sessionTextStyleRevision++; }
export function getMindTextStyleSessionRevision(): number { return sessionTextStyleRevision; }
export function setMindTextStyleSession(clip: MindTextStyleClip): void { sessionTextStyle = parseMindTextStyle(JSON.stringify(clip)); }
export function getMindTextStyleSession(): MindTextStyleClip | null { return sessionTextStyle ? parseMindTextStyle(JSON.stringify(sessionTextStyle)) : null; }
if (typeof window !== "undefined") { subscribeLocalAuthChanges(clearMindTextStyleSession); subscribeAuthChanges(clearMindTextStyleSession); }
export function captureMindTextStyle(graph: FlowGraph, id: string): MindTextStyleClip | null {
  const topic = graph.mind?.find((item) => item.id === id); if (!topic) return null;
  const style = graph.mindStyles?.[id], format = normalizeMindTextFormat(graph.mindTextFormats?.[id] ?? {}); if (!format) return null;
  return { version: 1, size: style?.size ?? (topic.parent === null ? 16 : 14), ...(style?.color ? { color: style.color } : {}), format };
}
export function parseMindTextStyle(text: string): MindTextStyleClip | null {
  if (text.length > 4096) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || raw.version !== 1 || Object.keys(raw).some((key) => !["version", "size", "color", "format"].includes(key)) || typeof raw.size !== "number" || !Number.isInteger(raw.size) || raw.size < 12 || raw.size > 96 || (raw.color !== undefined && (typeof raw.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw.color)))) return null;
    const format = normalizeMindTextFormat(raw.format); if (!format) return null;
    return { version: 1, size: raw.size, ...(typeof raw.color === "string" ? { color: raw.color.toLowerCase() } : {}), format };
  } catch { return null; }
}
export function applyMindTextStyle(graph: FlowGraph, id: string, clip: MindTextStyleClip): FlowGraph | null {
  if (!graph.mind?.some((topic) => topic.id === id) || !parseMindTextStyle(JSON.stringify(clip))) return null;
  const current = graph.mindStyles?.[id] ?? {}, styles = { ...graph.mindStyles }, formats = { ...graph.mindTextFormats };
  styles[id] = { ...(current.shape ? { shape: current.shape } : {}), size: clip.size, ...(clip.color ? { color: clip.color } : {}) };
  if (Object.keys(clip.format).length) formats[id] = { ...clip.format }; else delete formats[id];
  return { ...graph, mindStyles: styles, mindTextFormats: formats, mindTextStyleIntent: [id] };
}
export function mindTextStyleHtml(clip: MindTextStyleClip): string { return `<span data-jiange-mind-text-style="${encodeURIComponent(JSON.stringify(clip))}">Jiange 文字样式</span>`; }
export function mindTextStyleFromHtml(html: string): MindTextStyleClip | null {
  if (html.length > 10000 || !html.includes("data-jiange-mind-text-style")) return null;
  try { const encoded = new DOMParser().parseFromString(html, "text/html").querySelector("span[data-jiange-mind-text-style]")?.getAttribute("data-jiange-mind-text-style"); return encoded ? parseMindTextStyle(decodeURIComponent(encoded)) : null; } catch { return null; }
}
