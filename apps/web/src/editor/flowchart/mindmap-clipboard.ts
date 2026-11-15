import { canonicalMindDescription, mindDescriptionAt, mindDescriptionLines, normalizeMindDescriptionStyle, normalizeMindPaint, normalizeMindStyle, normalizeMindTextFormat, normalizeMindTopic, type MindDescriptions, type MindDescriptionStyle, type MindDescriptionStyles, type MindPaint, type MindPaints, type MindStyle, type MindStyles, type MindTextFormat, type MindTextFormats, type MindTopic } from "./mindmap";
import { mindSubtree } from "./mindmap-move";
import type { FlowGraph } from "./model";

export const MIND_CLIP_MIME = "application/x-jiange-mindmap+json";
export type MindClip = { version: 1 | 2 | 3; root: string; topics: MindTopic[]; styles: MindStyles; paints: MindPaints; textFormats?: MindTextFormats; descriptions?: MindDescriptions; descriptionStyles?: MindDescriptionStyles; collapsed: string[] };

/** Capture descendants even when folded; no unrelated canvas objects or metadata. */
export function copyMindBranch(graph: FlowGraph, id: string): MindClip | null {
  if (!graph.mind?.some((topic) => topic.id === id)) return null;
  const ids = mindSubtree(graph.mind, id), topics = graph.mind.filter((topic) => ids.has(topic.id)).map((topic) => ({ ...topic }));
  const descriptions = Object.fromEntries(Object.entries(graph.mindDescriptions ?? {}).filter(([key, value]) => ids.has(key) && !!value));
  const descriptionStyles = Object.fromEntries(Object.entries(graph.mindDescriptionStyles ?? {}).filter(([key]) => ids.has(key)));
  const version = Object.keys(descriptionStyles).length ? 3 : Object.keys(descriptions).length ? 2 : 1;
  return { version, root: id, topics, styles: Object.fromEntries(Object.entries(graph.mindStyles ?? {}).filter(([key]) => ids.has(key))), paints: Object.fromEntries(Object.entries(graph.mindPaints ?? {}).filter(([key]) => ids.has(key))), ...(graph.mindTextFormats ? { textFormats: Object.fromEntries(Object.entries(graph.mindTextFormats).filter(([key]) => ids.has(key))) } : {}), ...(version >= 2 ? { descriptions } : {}), ...(version === 3 ? { descriptionStyles } : {}), collapsed: (graph.mindCollapsed ?? []).filter((key) => ids.has(key)) };
}

/** Treat clipboard contents as untrusted: bound size, topology and every style. */
export function parseMindClip(text: string): MindClip | null {
  if (text.length > 1_000_000) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) || typeof raw.root !== "string" || !Array.isArray(raw.topics) || !raw.topics.length || raw.topics.length > 500 || !Array.isArray(raw.collapsed)) return null;
    if (!raw.styles || typeof raw.styles !== "object" || Array.isArray(raw.styles) || !raw.paints || typeof raw.paints !== "object" || Array.isArray(raw.paints)) return null;
    if (raw.textFormats !== undefined && (!raw.textFormats || typeof raw.textFormats !== "object" || Array.isArray(raw.textFormats))) return null;
    if (raw.version === 1 && raw.descriptions !== undefined || (raw.version === 2 || raw.version === 3) && (!raw.descriptions || typeof raw.descriptions !== "object" || Array.isArray(raw.descriptions))) return null;
    if (raw.version !== 3 && raw.descriptionStyles !== undefined || raw.version === 3 && (!raw.descriptionStyles || typeof raw.descriptionStyles !== "object" || Array.isArray(raw.descriptionStyles))) return null;
    const topics = raw.topics.map((topic) => normalizeMindTopic(topic)); if (topics.some((topic) => !topic)) return null;
    const nodes = topics as MindTopic[], byId = new Map(nodes.map((topic) => [topic.id, topic]));
    if (byId.size !== nodes.length || !byId.has(raw.root)) return null;
    for (const node of nodes) {
      let cursor: MindTopic | undefined = node, depth = 0; const seen = new Set<string>();
      while (cursor && cursor.id !== raw.root) { if (seen.has(cursor.id) || ++depth > 32 || !cursor.parent) return null; seen.add(cursor.id); cursor = byId.get(cursor.parent); }
      if (!cursor) return null;
    }
    const styleEntries: [string, MindStyle][] = [], paintEntries: [string, MindPaint][] = [];
    for (const [key, value] of Object.entries(raw.styles)) { const style = normalizeMindStyle(value); if (!byId.has(key) || !style) return null; styleEntries.push([key, style]); }
    for (const [key, value] of Object.entries(raw.paints)) { const paint = normalizeMindPaint(value); if (!byId.has(key) || !paint) return null; paintEntries.push([key, paint]); }
    const styles: MindStyles = Object.fromEntries(styleEntries), paints: MindPaints = Object.fromEntries(paintEntries);
    const formatEntries: [string, MindTextFormat][] = [];
    for (const [key, value] of Object.entries(raw.textFormats ?? {})) { const format = normalizeMindTextFormat(value); if (!byId.has(key) || !format) return null; formatEntries.push([key, format]); }
    const descriptionEntries: [string, string][] = [];
    for (const [key, value] of Object.entries(raw.descriptions ?? {})) { if (!byId.has(key) || typeof value !== "string" || !value || canonicalMindDescription(value) === null) return null; descriptionEntries.push([key, value]); }
    const descriptions: MindDescriptions = Object.fromEntries(descriptionEntries);
    const descriptionStyleEntries: [string, MindDescriptionStyle][] = [];
    for (const [key, value] of Object.entries(raw.descriptionStyles ?? {})) { const style = normalizeMindDescriptionStyle(value); if (!byId.has(key) || !style) return null; descriptionStyleEntries.push([key, style]); }
    const descriptionStyles = Object.fromEntries(descriptionStyleEntries) as MindDescriptionStyles;
    for (const [id, value] of descriptionEntries) if (mindDescriptionLines(value, Object.hasOwn(descriptionStyles, id) ? descriptionStyles[id].size ?? 12 : 12).length > 128) return null;
    if (raw.collapsed.some((id) => typeof id !== "string" || !byId.has(id)) || new Set(raw.collapsed).size !== raw.collapsed.length) return null;
    return { version: raw.version as 1 | 2 | 3, root: raw.root, topics: nodes, styles, paints, ...(raw.textFormats !== undefined ? { textFormats: Object.fromEntries(formatEntries) } : {}), ...(raw.version !== 1 ? { descriptions } : {}), ...(raw.version === 3 ? { descriptionStyles } : {}), collapsed: raw.collapsed as string[] };
  } catch { return null; }
}

export function mindClipText(clip: MindClip): string {
  const lines: string[] = [], children = new Map<string, MindTopic[]>();
  for (const topic of clip.topics) if (topic.id !== clip.root && topic.parent) children.set(topic.parent, [...(children.get(topic.parent) ?? []), topic]);
  for (const group of children.values()) group.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const visit = (id: string, depth: number) => { const topic = clip.topics.find((item) => item.id === id)!; lines.push(`${"\t".repeat(depth)}${topic.text.replace(/[\r\n]+/g, " ")}`); const description = mindDescriptionAt(clip.descriptions, id); if (description) lines.push(`${"\t".repeat(depth + 1)}${description.replace(/[\r\n]+/g, " ")}`); for (const child of children.get(id) ?? []) visit(child.id, depth + 1); };
  visit(clip.root, 0); return lines.join("\n");
}
export function mindClipHtml(clip: MindClip): string {
  const text = mindClipText(clip), encoded = encodeURIComponent(JSON.stringify(clip));
  return `<pre data-jiange-mindmap="${encoded}">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
}

export function mindClipFromHtml(html: string): MindClip | null {
  if (html.length > 5_000_000 || !html.includes("data-jiange-mindmap")) return null;
  try { const encoded = new DOMParser().parseFromString(html, "text/html").querySelector("pre[data-jiange-mindmap]")?.getAttribute("data-jiange-mindmap"); return encoded ? parseMindClip(decodeURIComponent(encoded)) : null; } catch { return null; }
}

/** Clone IDs, preserve appearance and insert under a target or beside a sibling. */
export function pasteMindBranch(graph: FlowGraph, clip: MindClip, parent: string | null, after: string | null, at: { x: number; y: number }, nextId: () => string): { graph: FlowGraph; root: string } | null {
  const topics = graph.mind ?? [];
  if (!parseMindClip(JSON.stringify(clip))) return null;
  if (topics.length + clip.topics.length > 500 || (parent && !topics.some((topic) => topic.id === parent))) return null;
  const existing = new Map(topics.map((topic) => [topic.id, topic])), copied = new Map(clip.topics.map((topic) => [topic.id, topic]));
  let targetDepth = parent ? 1 : 0, cursor = parent ? existing.get(parent) : undefined; const seen = new Set<string>();
  while (cursor?.parent) { if (seen.has(cursor.id)) return null; seen.add(cursor.id); targetDepth++; cursor = existing.get(cursor.parent); if (!cursor) return null; }
  for (const topic of clip.topics) { let current = topic, depth = targetDepth; while (current.id !== clip.root) { if (!current.parent || ++depth > 32) return null; current = copied.get(current.parent)!; } if (depth > 32) return null; }
  const ids = new Map(clip.topics.map((topic) => [topic.id, nextId()]));
  if (new Set(ids.values()).size !== ids.size || [...ids.values()].some((id) => topics.some((topic) => topic.id === id))) return null;
  let result = [...topics];
  const siblings = parent ? topics.filter((topic) => topic.parent === parent).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) : [];
  const atIndex = after ? siblings.findIndex((topic) => topic.id === after) : siblings.length - 1;
  if (after && atIndex < 0) return null;
  const previous = siblings[atIndex]?.order, following = siblings[atIndex + 1]?.order;
  let order = previous === undefined ? 0 : following === undefined ? previous + 1 : (previous + following) / 2;
  if (order > 1000000 || (previous !== undefined && order <= previous) || (following !== undefined && order >= following)) {
    const reordered = [...siblings]; reordered.splice(atIndex + 1, 0, { id: ids.get(clip.root)!, parent, order: 0, text: "" });
    const orders = new Map(reordered.map((topic, i) => [topic.id, i + 1]));
    result = result.map((topic) => orders.has(topic.id) ? { ...topic, order: orders.get(topic.id)! } : topic); order = orders.get(ids.get(clip.root)!)!;
  }
  const x = Math.round(Math.max(-20000, Math.min(20000, at.x))), y = Math.round(Math.max(-20000, Math.min(20000, at.y)));
  for (const topic of clip.topics) {
    if (topic.id === clip.root) result.push({ id: ids.get(topic.id)!, parent, order, text: topic.text, ...(parent === null ? { x, y } : {}) });
    else result.push({ id: ids.get(topic.id)!, parent: ids.get(topic.parent!)!, order: topic.order, text: topic.text });
  }
  const styles = { ...graph.mindStyles }, paints = { ...graph.mindPaints }, textFormats = { ...graph.mindTextFormats };
  let descriptions = { ...graph.mindDescriptions };
  let descriptionStyles = { ...graph.mindDescriptionStyles };
  for (const [id, value] of Object.entries(clip.styles)) styles[ids.get(id)!] = { ...value };
  for (const [id, value] of Object.entries(clip.paints)) paints[ids.get(id)!] = { ...value };
  for (const [id, value] of Object.entries(clip.textFormats ?? {})) textFormats[ids.get(id)!] = { ...value };
  for (const [id, value] of Object.entries(clip.descriptions ?? {})) descriptions = { ...descriptions, [ids.get(id)!]: value };
  for (const [id, value] of Object.entries(clip.descriptionStyles ?? {})) descriptionStyles = { ...descriptionStyles, [ids.get(id)!]: { ...value } };
  const collapsed = new Set(graph.mindCollapsed ?? []); if (parent) collapsed.delete(parent); for (const id of clip.collapsed) collapsed.add(ids.get(id)!);
  return { graph: { ...graph, mind: result, mindStyles: styles, mindPaints: paints, mindTextFormats: textFormats, mindDescriptions: descriptions, mindDescriptionStyles: descriptionStyles, mindCollapsed: [...collapsed] }, root: ids.get(clip.root)! };
}
