/** A topic is stored under its own block property, so edits to separate topics do not replace the tree. */
export type MindTopic = { id: string; parent: string | null; order: number; text: string; x?: number; y?: number };
export type MindStyle = { shape?: "text" | "oval" | "rect"; size?: number; color?: string };
export type MindStyles = Record<string, MindStyle>;
export type MindPaint = { fill?: string; fillOpacity?: number; stroke?: string; line?: "solid" | "dashed" | "dotted"; width?: number; opacity?: number };
export type MindPaints = Record<string, MindPaint>;
export type MindTextFormat = { bold?: true; italic?: true; underline?: true; strike?: true; highlight?: string; align?: "left" | "center" | "right" };
export type MindTextFormats = Record<string, MindTextFormat>;
export type MindDescriptions = Record<string, string>;
export type MindDescriptionStyle = { size?: number; color?: string; highlight?: string };
export type MindDescriptionStyles = Record<string, MindDescriptionStyle>;
export function mindDescriptionAt(descriptions: MindDescriptions | undefined, id: string): string | undefined {
  return descriptions && Object.hasOwn(descriptions, id) ? descriptions[id] : undefined;
}
export function mindDefaultTextColor(root: boolean, shape: MindStyle["shape"], paint?: MindPaint): string {
  if (!root || shape === "text") return "#1f2329";
  const fill = paint?.fill ?? "#5b7ff1";
  if (fill === "none" || (paint?.fillOpacity ?? 100) < 50) return "#1f2329";
  const r = parseInt(fill.slice(1, 3), 16), g = parseInt(fill.slice(3, 5), 16), b = parseInt(fill.slice(5, 7), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 160 ? "#1f2329" : "#ffffff";
}
export type PositionedTopic = { topic: MindTopic; x: number; y: number; w: number; h: number };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX = "fc.m.";
export const mindKey = (id: string) => `${PREFIX}${id}`;
export const mindDescriptionKey = (id: string) => `fc.md.${id}`;
export const mindDescriptionStyleKey = (id: string) => `fc.mds.${id}`;
const validCoord = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 20000;

export function normalizeMindTopic(input: unknown, id?: string): MindTopic | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>, key = id ?? raw.id;
  if (typeof key !== "string" || !ID.test(key) || (raw.parent !== null && (typeof raw.parent !== "string" || !ID.test(raw.parent) || raw.parent === key)) || typeof raw.text !== "string" || raw.text.length > 500 || raw.text.includes("\0") || typeof raw.order !== "number" || !Number.isFinite(raw.order) || raw.order < 0 || raw.order > 1000000) return null;
  if (raw.parent === null && (!validCoord(raw.x) || !validCoord(raw.y))) return null;
  return { id: key, parent: raw.parent as string | null, order: raw.order as number, text: raw.text, ...(raw.parent === null ? { x: Math.round(raw.x as number), y: Math.round(raw.y as number) } : {}) };
}
export function canonicalMindTopic(topic: MindTopic): string | null {
  const normalized = normalizeMindTopic(topic, topic.id); if (!normalized) return null;
  const { id: _id, ...content } = normalized; return JSON.stringify(content);
}
export function storedMindTopic(raw: string | undefined, id: string): MindTopic | null {
  if (!raw) return null;
  try { return normalizeMindTopic(JSON.parse(raw), id); } catch { return null; }
}
/** Keep only nodes reachable from a valid root; malformed data is never rewritten. */
export function readMindTopics(props: Record<string, string>): MindTopic[] {
  const nodes = new Map<string, MindTopic>();
  for (const [key, raw] of Object.entries(props)) if (key.startsWith(PREFIX) && raw) { const node = storedMindTopic(raw, key.slice(PREFIX.length)); if (node) nodes.set(node.id, node); }
  return [...nodes.values()].filter((node) => {
    let current: MindTopic | undefined = node, depth = 0; const seen = new Set<string>();
    while (current && current.parent !== null) { if (seen.has(current.id) || ++depth > 32) return false; seen.add(current.id); current = nodes.get(current.parent); }
    return !!current;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Reject stale writes and deletes that would orphan a concurrently added child. */
export function mindIntentWrites(props: Record<string, string>, before: readonly MindTopic[], after: readonly MindTopic[], beforeDescriptions?: MindDescriptions, beforeDescriptionStyles?: MindDescriptionStyles): { writes: Record<string, string>; conflicts: string[] } {
  const old = new Map(before.map((n) => [n.id, n])), next = new Map(after.map((n) => [n.id, n]));
  const candidates = new Map<string, string>(), conflicts = new Set<string>();
  const live = readMindTopics(props), liveMap = new Map(live.map((node) => [node.id, node]));
  const deleted = new Set([...old.keys()].filter((id) => !next.has(id)));
  const deletionGroups = [...deleted].filter((id) => !old.get(id)?.parent || !deleted.has(old.get(id)!.parent!)).map((root) => {
    const group = new Set([root]); let size = -1;
    while (size !== group.size) { size = group.size; for (const id of deleted) if (old.get(id)?.parent && group.has(old.get(id)!.parent!)) group.add(id); }
    return group;
  });
  const added = new Set([...next.keys()].filter((id) => !old.has(id)));
  const additionGroups = [...added].filter((id) => !next.get(id)?.parent || !added.has(next.get(id)!.parent!)).map((root) => {
    const group = new Set([root]); let size = -1;
    while (size !== group.size) { size = group.size; for (const id of added) if (next.get(id)?.parent && group.has(next.get(id)!.parent!)) group.add(id); }
    return { root, group };
  });
  const structural = [...new Set([...old.keys(), ...next.keys()])].filter((id) => { const a = old.get(id), b = next.get(id); return !!a && !!b && (a.parent !== b.parent || a.order !== b.order); });
  const affectedParents = (id: string) => [old.get(id)?.parent, next.get(id)?.parent].filter((parent): parent is string => !!parent);
  const siblings = (nodes: readonly MindTopic[], parent: string) => nodes.filter((node) => node.parent === parent).map((node) => `${node.id}:${node.order}`).sort().join("|");
  const sameAncestry = (parent: string) => { const seen = new Set<string>(); let id: string | null = parent; while (id) { if (seen.has(id)) return false; seen.add(id); const was = old.get(id), now = liveMap.get(id); if (!was) { const planned = next.get(id); if (!planned || now) return false; id = planned.parent; continue; } if (!now || was.parent !== now.parent) return false; id = was.parent; } return true; };
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const prior = old.get(id), target = next.get(id), key = mindKey(id);
    const was = prior ? canonicalMindTopic(prior) : null, desired = target ? canonicalMindTopic(target) : null;
    if (was === desired) continue;
    if ((prior && !was) || (target && !desired) || (prior && target && prior.parent !== target.parent && (!prior.parent || !target.parent))) { conflicts.add(key); continue; }
    const live = storedMindTopic(props[key], id), now = live ? canonicalMindTopic(live) : null;
    if ((!!props[key] && !now) || (now !== was && now !== desired)) { conflicts.add(key); continue; }
    if (prior && !target && beforeDescriptions) {
      const descriptionKey = mindDescriptionKey(id), currentDescription = storedMindDescription(props[descriptionKey]);
      if (currentDescription === null || currentDescription !== canonicalMindDescription(mindDescriptionAt(beforeDescriptions, id))) { conflicts.add(key); conflicts.add(descriptionKey); continue; }
    }
    if (prior && !target && beforeDescriptionStyles) {
      const styleKey = mindDescriptionStyleKey(id), currentStyle = storedMindDescriptionStyle(props[styleKey]);
      if (currentStyle === null || currentStyle !== canonicalMindDescriptionStyle(mindDescriptionStyleAt(beforeDescriptionStyles, id))) { conflicts.add(key); conflicts.add(styleKey); continue; }
    }
    if (structural.includes(id) && now !== desired && affectedParents(id).some((parent) => !sameAncestry(parent) || siblings(before, parent) !== siblings([...liveMap.values()], parent))) { conflicts.add(key); continue; }
    candidates.set(id, desired ?? "");
  }
  const stored = Object.entries(props).filter(([key, raw]) => key.startsWith(PREFIX) && !!raw).map(([key, raw]) => storedMindTopic(raw, key.slice(PREFIX.length)));
  const malformed = stored.some((node) => !node), allStored = stored.filter((node): node is MindTopic => !!node);
  const attemptedAdds = [...candidates.keys()].filter((key) => !old.has(key) && candidates.get(key)).length;
  let changed = true;
  while (changed) {
    changed = false;
    // A failed descendant or newly added remote child must not leave a cut
    // branch half deleted. Each connected deletion is treated as one intent.
    for (const group of deletionGroups) if ([...group].some((id) => conflicts.has(mindKey(id)))) for (const id of group) if (candidates.has(id)) { candidates.delete(id); conflicts.add(mindKey(id)); changed = true; }
    // Reindexing may touch multiple siblings. If any one conflicts, keep the
    // whole structural group unchanged rather than applying a partial reorder.
    const blockedParents = new Set(structural.filter((id) => conflicts.has(mindKey(id))).flatMap(affectedParents));
    for (const group of deletionGroups) if ([...group].some((id) => conflicts.has(mindKey(id)))) for (const id of group) { blockedParents.add(id); const parent = old.get(id)?.parent; if (parent) blockedParents.add(parent); }
    for (const { root, group } of additionGroups) if ([...group].some((id) => conflicts.has(mindKey(id)))) {
      const parent = next.get(root)?.parent; if (parent) blockedParents.add(parent);
      for (const id of group) if (candidates.has(id)) { candidates.delete(id); conflicts.add(mindKey(id)); changed = true; }
    }
    let expanded = true;
    while (expanded) { expanded = false; for (const id of structural) if (affectedParents(id).some((parent) => blockedParents.has(parent))) for (const parent of affectedParents(id)) if (!blockedParents.has(parent)) { blockedParents.add(parent); expanded = true; } }
    for (const id of structural) if (affectedParents(id).some((parent) => blockedParents.has(parent)) && candidates.has(id)) { candidates.delete(id); conflicts.add(mindKey(id)); changed = true; }
    for (const [id, value] of candidates) { const target = next.get(id); if (value && !old.has(id) && target?.parent && blockedParents.has(target.parent)) { candidates.delete(id); conflicts.add(mindKey(id)); changed = true; } }
    for (const [id, value] of candidates) {
      const target = next.get(id);
      const unsafeDelete = !value && (malformed || allStored.some((child) => child.parent === id && candidates.get(child.id) !== "" && !(candidates.get(child.id) && next.get(child.id)?.parent !== id)));
      const unsafeCreate = !!target?.parent && !live.some((node) => node.id === target.parent) && !candidates.get(target.parent);
      let invalidTree = false;
      if (target) {
        const seen = new Set<string>(); let cursor: MindTopic | undefined = target, depth = 0;
        while (cursor?.parent) {
          if (seen.has(cursor.id) || ++depth > 32 || candidates.get(cursor.parent) === "") { invalidTree = true; break; }
          seen.add(cursor.id);
          cursor = candidates.has(cursor.parent) ? next.get(cursor.parent) : live.find((node) => node.id === cursor!.parent);
          if (!cursor) { invalidTree = true; break; }
        }
      }
      if (target && old.get(id)?.parent !== target.parent && old.has(id)) {
        if (malformed || allStored.length !== live.length) invalidTree = true;
        const projected = new Map(live.map((node) => [node.id, node]));
        for (const [candidate, candidateValue] of candidates) { const node = next.get(candidate); if (candidateValue && node) projected.set(candidate, node); else if (!candidateValue) projected.delete(candidate); }
        const descendants = new Set([id]); let count = -1;
        while (count !== descendants.size) { count = descendants.size; for (const node of live) if (node.parent && descendants.has(node.parent)) descendants.add(node.id); }
        for (const descendant of descendants) { let cursor = projected.get(descendant), depth = 0; const seen = new Set<string>(); while (cursor?.parent) { if (seen.has(cursor.id) || ++depth > 32) { invalidTree = true; break; } seen.add(cursor.id); cursor = projected.get(cursor.parent); if (!cursor) { invalidTree = true; break; } } }
      }
      const tooMany = !!target && !old.has(id) && live.length + attemptedAdds > 500;
      if (unsafeDelete || unsafeCreate || invalidTree || tooMany || (target?.parent && candidates.get(target.parent) === "")) { candidates.delete(id); conflicts.add(mindKey(id)); changed = true; }
    }
  }
  const writes: Record<string, string> = {};
  for (const [id, value] of candidates) { const existing = storedMindTopic(props[mindKey(id)], id); if ((existing ? canonicalMindTopic(existing) : "") !== value) writes[mindKey(id)] = value; }
  return { writes, conflicts: [...conflicts] };
}

/** Description data is stored separately so older clients cannot erase it when editing a label. */
export function canonicalMindDescription(value: string | undefined): string | null {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 2000 || value.includes("\0") || mindDescriptionLines(value).length > 128) return null;
  return JSON.stringify(value);
}
function storedMindDescription(raw: string | undefined): string | null {
  if (!raw) return "";
  try { return canonicalMindDescription(JSON.parse(raw)); } catch { return null; }
}
export function readMindDescriptions(props: Record<string, string>, topics: readonly MindTopic[]): MindDescriptions {
  const result: [string, string][] = [];
  for (const topic of topics) {
    const canonical = storedMindDescription(props[mindDescriptionKey(topic.id)]);
    if (canonical) result.push([topic.id, JSON.parse(canonical)]);
  }
  return Object.fromEntries(result);
}
export function mindDescriptionIntent(props: Record<string, string>, before: MindDescriptions, after: MindDescriptions, beforeTopics: readonly MindTopic[], afterTopics: readonly MindTopic[], topicWrites: Record<string, string>, afterStyles: MindDescriptionStyles = {}): { writes: Record<string, string>; conflicts: string[] } {
  const old = new Set(beforeTopics.map((topic) => topic.id)), next = new Set(afterTopics.map((topic) => topic.id));
  const added = afterTopics.filter((topic) => !old.has(topic.id)).map((topic) => topic.id), writes: Record<string, string> = {}, conflicts: string[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after), ...added])) {
    if (!next.has(id) || (!old.has(id) && !topicWrites[mindKey(id)])) continue;
    const key = mindDescriptionKey(id), was = canonicalMindDescription(mindDescriptionAt(before, id)), desired = canonicalMindDescription(mindDescriptionAt(after, id)), now = storedMindDescription(props[key]);
    if (old.has(id) && was === desired) continue;
    if (was === null || desired === null || now === null || (!storedMindTopic(props[mindKey(id)], id) && !topicWrites[mindKey(id)]) || (old.has(id) && now !== was && now !== desired) || (!old.has(id) && now !== "" && now !== desired)) { conflicts.push(key); continue; }
    const currentStyle = storedMindDescriptionStyle(props[mindDescriptionStyleKey(id)]), plannedStyle = canonicalMindDescriptionStyle(mindDescriptionStyleAt(afterStyles, id));
    if (currentStyle === null || plannedStyle === null) { conflicts.push(key); continue; }
    const currentSize = currentStyle ? (JSON.parse(currentStyle) as MindDescriptionStyle).size ?? 12 : 12;
    const plannedSize = plannedStyle ? (JSON.parse(plannedStyle) as MindDescriptionStyle).size ?? 12 : 12;
    const text = mindDescriptionAt(after, id) ?? "";
    if (text && mindDescriptionLines(text, Math.max(currentSize, plannedSize)).length > 128) { conflicts.push(key); continue; }
    if (now !== desired) writes[key] = desired;
  }
  return { writes, conflicts };
}

export function mindDescriptionStyleAt(styles: MindDescriptionStyles | undefined, id: string): MindDescriptionStyle | undefined {
  return styles && Object.hasOwn(styles, id) ? styles[id] : undefined;
}
export function normalizeMindDescriptionStyle(input: unknown): MindDescriptionStyle | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["size", "color", "highlight"].includes(key))) return null;
  if (raw.size !== undefined && (typeof raw.size !== "number" || !Number.isInteger(raw.size) || raw.size < 12 || raw.size > 96)) return null;
  for (const key of ["color", "highlight"]) if (raw[key] !== undefined && (typeof raw[key] !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw[key]))) return null;
  return { ...(raw.size !== undefined ? { size: raw.size as number } : {}), ...(raw.color !== undefined ? { color: String(raw.color).toLowerCase() } : {}), ...(raw.highlight !== undefined ? { highlight: String(raw.highlight).toLowerCase() } : {}) };
}
export function canonicalMindDescriptionStyle(value: MindDescriptionStyle | undefined): string | null {
  if (value === undefined) return "";
  const normalized = normalizeMindDescriptionStyle(value);
  return normalized ? Object.keys(normalized).length ? JSON.stringify(normalized) : "" : null;
}
function storedMindDescriptionStyle(raw: string | undefined): string | null {
  if (!raw) return "";
  try { return canonicalMindDescriptionStyle(JSON.parse(raw)); } catch { return null; }
}
export function readMindDescriptionStyles(props: Record<string, string>, topics: readonly MindTopic[]): MindDescriptionStyles {
  const result: [string, MindDescriptionStyle][] = [];
  for (const topic of topics) { const canonical = storedMindDescriptionStyle(props[mindDescriptionStyleKey(topic.id)]); if (canonical) result.push([topic.id, JSON.parse(canonical)]); }
  return Object.fromEntries(result);
}
export function mindDescriptionStyleIntent(props: Record<string, string>, before: MindDescriptionStyles, after: MindDescriptionStyles, beforeTopics: readonly MindTopic[], afterTopics: readonly MindTopic[], topicWrites: Record<string, string>, afterDescriptions: MindDescriptions = {}): { writes: Record<string, string>; conflicts: string[] } {
  const old = new Set(beforeTopics.map((topic) => topic.id)), next = new Set(afterTopics.map((topic) => topic.id));
  const added = afterTopics.filter((topic) => !old.has(topic.id)).map((topic) => topic.id), writes: Record<string, string> = {}, conflicts: string[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after), ...added])) {
    if (!next.has(id) || (!old.has(id) && !topicWrites[mindKey(id)])) continue;
    const key = mindDescriptionStyleKey(id), was = canonicalMindDescriptionStyle(mindDescriptionStyleAt(before, id)), desired = canonicalMindDescriptionStyle(mindDescriptionStyleAt(after, id)), now = storedMindDescriptionStyle(props[key]);
    if (old.has(id) && was === desired) continue;
    if (was === null || desired === null || now === null || (!storedMindTopic(props[mindKey(id)], id) && !topicWrites[mindKey(id)]) || (old.has(id) && now !== was && now !== desired) || (!old.has(id) && now !== "" && now !== desired)) { conflicts.push(key); continue; }
    const currentDescription = storedMindDescription(props[mindDescriptionKey(id)]), plannedDescription = canonicalMindDescription(mindDescriptionAt(afterDescriptions, id));
    if (currentDescription === null || plannedDescription === null) { conflicts.push(key); continue; }
    const size = desired ? (JSON.parse(desired) as MindDescriptionStyle).size ?? 12 : 12;
    const values = [currentDescription ? JSON.parse(currentDescription) as string : "", mindDescriptionAt(afterDescriptions, id) ?? ""];
    if (values.some((text) => text && mindDescriptionLines(text, size).length > 128)) { conflicts.push(key); continue; }
    if (now !== desired) writes[key] = desired;
  }
  return { writes, conflicts };
}

/** Wrap each paragraph into predictable lines for the canvas and exported image. */
export function mindDescriptionTextWidth(value: string, size: number): number {
  return [...value].reduce((sum, ch) => sum + (/[\u2e80-\uffff]/.test(ch) ? size : size * 0.58), 0);
}
export function mindDescriptionLines(value: string, size = 12): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "", width = 0;
    for (const ch of [...paragraph]) {
      const advance = mindDescriptionTextWidth(ch, size);
      if (line && width + advance > 288) { lines.push(line); line = ""; width = 0; }
      line += ch; width += advance;
    }
    lines.push(line);
  }
  return lines;
}
export function mindTitleHeight(topic: MindTopic, styles: MindStyles = {}): number {
  const root = topic.parent === null, size = styles[topic.id]?.size ?? (root ? 16 : 14);
  return Math.max(root ? 48 : 30, size + 16);
}

/** A bounded, deterministic rightward tree layout. */
export function layoutMindTopics(topics: readonly MindTopic[], collapsed: ReadonlySet<string> = new Set(), styles: MindStyles = {}, descriptions: MindDescriptions = {}, descriptionStyles: MindDescriptionStyles = {}): PositionedTopic[] {
  const children = new Map<string, MindTopic[]>();
  for (const topic of topics) if (topic.parent) { const group = children.get(topic.parent) ?? []; group.push(topic); children.set(topic.parent, group); }
  for (const group of children.values()) group.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const sizes = new Map<string, number>();
  const dimensions = (topic: MindTopic) => {
    const root = topic.parent === null, size = styles[topic.id]?.size ?? (root ? 16 : 14), description = mindDescriptionAt(descriptions, topic.id);
    const descSize = mindDescriptionStyleAt(descriptionStyles, topic.id)?.size ?? 12, lines = description ? mindDescriptionLines(description, descSize) : [];
    const descWidth = lines.reduce((max, line) => Math.max(max, mindDescriptionTextWidth(line, descSize) + 28), 0);
    const w = Math.max(root ? 104 : 90, Math.min(600, [...topic.text].length * size + 32), descWidth);
    const h = mindTitleHeight(topic, styles) + (lines.length ? lines.length * Math.ceil(descSize * 1.35) + 8 : 0);
    return { w, h };
  };
  const subtree = (topic: MindTopic): number => { const group = collapsed.has(topic.id) ? [] : children.get(topic.id) ?? []; const h = Math.max(dimensions(topic).h + 10, group.length ? group.reduce((total, child) => total + subtree(child), 0) + (group.length - 1) * 12 : 40); sizes.set(topic.id, h); return h; };
  const out: PositionedTopic[] = [];
  const place = (topic: MindTopic, x: number, centerY: number, depth: number) => {
    const { w, h } = dimensions(topic);
    out.push({ topic, x, y: centerY - h / 2, w, h });
    const group = collapsed.has(topic.id) ? [] : children.get(topic.id) ?? [], height = group.reduce((total, child) => total + sizes.get(child.id)!, 0) + Math.max(0, group.length - 1) * 12;
    let y = centerY - height / 2;
    for (const child of group) { const childH = sizes.get(child.id)!; place(child, x + w + 60, y + childH / 2, depth + 1); y += childH + 12; }
  };
  for (const root of topics.filter((topic) => topic.parent === null)) { subtree(root); place(root, root.x ?? 0, (root.y ?? 0) + dimensions(root).h / 2, 0); }
  return out;
}

export const mindStyleKey = (id: string) => `fc.ms.${id}`;
/** Reject unknown properties instead of erasing styles written by newer clients. */
export function normalizeMindStyle(input: unknown): MindStyle | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["shape", "size", "color"].includes(key))) return null;
  if (raw.shape !== undefined && !["text", "oval", "rect"].includes(String(raw.shape))) return null;
  if (raw.size !== undefined && (typeof raw.size !== "number" || !Number.isInteger(raw.size) || raw.size < 12 || raw.size > 96)) return null;
  if (raw.color !== undefined && (typeof raw.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw.color))) return null;
  return { ...(raw.shape !== undefined ? { shape: raw.shape as MindStyle["shape"] } : {}), ...(raw.size !== undefined ? { size: raw.size as number } : {}), ...(raw.color !== undefined ? { color: (raw.color as string).toLowerCase() } : {}) };
}
export function canonicalMindStyle(style: MindStyle | undefined): string | null {
  if (!style) return "";
  const value = normalizeMindStyle(style);
  return value ? (Object.keys(value).length ? JSON.stringify(value) : "") : null;
}
export function readMindStyles(props: Record<string, string>, topics: readonly MindTopic[]): MindStyles {
  const styles: MindStyles = {};
  for (const topic of topics) { const raw = props[mindStyleKey(topic.id)]; if (!raw) continue; try { const style = normalizeMindStyle(JSON.parse(raw)); if (style) styles[topic.id] = style; } catch { /* preserve malformed data */ } }
  return styles;
}
export function mindStyleIntent(props: Record<string, string>, before: MindStyles, after: MindStyles, beforeTopics: readonly MindTopic[], afterTopics: readonly MindTopic[], topicWrites: Record<string, string>): { writes: Record<string, string>; conflicts: string[] } {
  const oldTopics = new Set(beforeTopics.map((topic) => topic.id)), nextTopics = new Set(afterTopics.map((topic) => topic.id));
  const added = afterTopics.filter((topic) => !oldTopics.has(topic.id)).map((topic) => topic.id);
  const writes: Record<string, string> = {}, conflicts: string[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after), ...added])) {
    if (!nextTopics.has(id) || (!oldTopics.has(id) && !topicWrites[mindKey(id)])) continue;
    const key = mindStyleKey(id), raw = props[key] ?? "", was = canonicalMindStyle(before[id]), desired = canonicalMindStyle(after[id]);
    if (oldTopics.has(id) && was === desired) continue;
    let now: string | null = ""; if (raw) { try { now = canonicalMindStyle(JSON.parse(raw)); } catch { now = null; } }
    if (was === null || desired === null || now === null || (!storedMindTopic(props[mindKey(id)], id) && !topicWrites[mindKey(id)]) || (oldTopics.has(id) && now !== was && now !== desired)) { conflicts.push(key); continue; }
    if (now !== desired) writes[key] = desired;
  }
  return { writes, conflicts };
}

// Paint lives separately so clients that know only shape/text styles can still edit them.
export const mindPaintKey = (id: string) => `fc.mp.${id}`;
export function normalizeMindPaint(input: unknown): MindPaint | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["fill", "fillOpacity", "stroke", "line", "width", "opacity"].includes(key))) return null;
  const hex = (value: unknown) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
  if (raw.fill !== undefined && raw.fill !== "none" && !hex(raw.fill)) return null;
  if (raw.stroke !== undefined && !hex(raw.stroke)) return null;
  if (raw.line !== undefined && !["solid", "dashed", "dotted"].includes(String(raw.line))) return null;
  if (raw.width !== undefined && (typeof raw.width !== "number" || !Number.isInteger(raw.width) || raw.width < 1 || raw.width > 4)) return null;
  for (const key of ["opacity", "fillOpacity"]) if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isInteger(raw[key]) || (raw[key] as number) < 0 || (raw[key] as number) > 100)) return null;
  return { ...(raw.fill !== undefined ? { fill: String(raw.fill).toLowerCase() } : {}), ...(raw.fillOpacity !== undefined ? { fillOpacity: raw.fillOpacity as number } : {}), ...(raw.stroke !== undefined ? { stroke: String(raw.stroke).toLowerCase() } : {}), ...(raw.line !== undefined ? { line: raw.line as MindPaint["line"] } : {}), ...(raw.width !== undefined ? { width: raw.width as number } : {}), ...(raw.opacity !== undefined ? { opacity: raw.opacity as number } : {}) };
}
export function canonicalMindPaint(paint: MindPaint | undefined): string | null {
  if (!paint) return "";
  const value = normalizeMindPaint(paint); return value ? (Object.keys(value).length ? JSON.stringify(value) : "") : null;
}
export function readMindPaints(props: Record<string, string>, topics: readonly MindTopic[]): MindPaints {
  const paints: MindPaints = {};
  for (const topic of topics) { const raw = props[mindPaintKey(topic.id)]; if (!raw) continue; try { const paint = normalizeMindPaint(JSON.parse(raw)); if (paint) paints[topic.id] = paint; } catch { /* preserve malformed data */ } }
  return paints;
}
export function mindPaintIntent(props: Record<string, string>, before: MindPaints, after: MindPaints, beforeTopics: readonly MindTopic[], afterTopics: readonly MindTopic[], topicWrites: Record<string, string>): { writes: Record<string, string>; conflicts: string[] } {
  const oldTopics = new Set(beforeTopics.map((topic) => topic.id)), nextTopics = new Set(afterTopics.map((topic) => topic.id));
  const added = afterTopics.filter((topic) => !oldTopics.has(topic.id)).map((topic) => topic.id);
  const writes: Record<string, string> = {}, conflicts: string[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after), ...added])) {
    if (!nextTopics.has(id) || (!oldTopics.has(id) && !topicWrites[mindKey(id)])) continue;
    const key = mindPaintKey(id), raw = props[key] ?? "", was = canonicalMindPaint(before[id]), desired = canonicalMindPaint(after[id]);
    if (oldTopics.has(id) && was === desired) continue;
    let now: string | null = ""; if (raw) { try { now = canonicalMindPaint(JSON.parse(raw)); } catch { now = null; } }
    if (was === null || desired === null || now === null || (!storedMindTopic(props[mindKey(id)], id) && !topicWrites[mindKey(id)]) || (oldTopics.has(id) && now !== was && now !== desired)) { conflicts.push(key); continue; }
    if (now !== desired) writes[key] = desired;
  }
  return { writes, conflicts };
}

// Text formatting is separate from shape styles so older clients do not erase it.
export const mindTextFormatKey = (id: string) => `fc.mt.${id}`;
export function normalizeMindTextFormat(input: unknown): MindTextFormat | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["bold", "italic", "underline", "strike", "highlight", "align"].includes(key))) return null;
  for (const key of ["bold", "italic", "underline", "strike"]) if (raw[key] !== undefined && raw[key] !== true) return null;
  if (raw.highlight !== undefined && (typeof raw.highlight !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw.highlight))) return null;
  if (raw.align !== undefined && !["left", "center", "right"].includes(String(raw.align))) return null;
  return { ...(raw.bold ? { bold: true as const } : {}), ...(raw.italic ? { italic: true as const } : {}), ...(raw.underline ? { underline: true as const } : {}), ...(raw.strike ? { strike: true as const } : {}), ...(raw.highlight !== undefined ? { highlight: String(raw.highlight).toLowerCase() } : {}), ...(raw.align !== undefined ? { align: raw.align as MindTextFormat["align"] } : {}) };
}
export function canonicalMindTextFormat(format: MindTextFormat | undefined): string | null {
  if (!format) return "";
  const value = normalizeMindTextFormat(format); return value ? (Object.keys(value).length ? JSON.stringify(value) : "") : null;
}
export function readMindTextFormats(props: Record<string, string>, topics: readonly MindTopic[]): MindTextFormats {
  const entries: [string, MindTextFormat][] = [];
  for (const topic of topics) { const raw = props[mindTextFormatKey(topic.id)]; if (!raw) continue; try { const value = normalizeMindTextFormat(JSON.parse(raw)); if (value) entries.push([topic.id, value]); } catch { /* preserve malformed data */ } }
  return Object.fromEntries(entries);
}
export function mindTextFormatIntent(props: Record<string, string>, before: MindTextFormats, after: MindTextFormats, beforeTopics: readonly MindTopic[], afterTopics: readonly MindTopic[], topicWrites: Record<string, string>): { writes: Record<string, string>; conflicts: string[] } {
  const oldTopics = new Set(beforeTopics.map((topic) => topic.id)), nextTopics = new Set(afterTopics.map((topic) => topic.id));
  const added = afterTopics.filter((topic) => !oldTopics.has(topic.id)).map((topic) => topic.id), writes: Record<string, string> = {}, conflicts: string[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after), ...added])) {
    if (!nextTopics.has(id) || (!oldTopics.has(id) && !topicWrites[mindKey(id)])) continue;
    const key = mindTextFormatKey(id), raw = props[key] ?? "", was = canonicalMindTextFormat(before[id]), desired = canonicalMindTextFormat(after[id]);
    if (oldTopics.has(id) && was === desired) continue;
    let now: string | null = ""; if (raw) { try { now = canonicalMindTextFormat(JSON.parse(raw)); } catch { now = null; } }
    if (was === null || desired === null || now === null || (!storedMindTopic(props[mindKey(id)], id) && !topicWrites[mindKey(id)]) || (oldTopics.has(id) && now !== was && now !== desired)) { conflicts.push(key); continue; }
    if (now !== desired) writes[key] = desired;
  }
  return { writes, conflicts };
}

const COLLAPSE_PREFIX = "fc.mc.";
export const mindCollapseKey = (id: string) => `${COLLAPSE_PREFIX}${id}`;

/** Fold flags are separate from topic data so older clients cannot erase them when editing text. */
export function readMindCollapsed(props: Record<string, string>, topics: readonly MindTopic[]): string[] {
  return topics.filter((topic) => props[mindCollapseKey(topic.id)] === "1").map((topic) => topic.id).sort();
}

export function mindCollapseIntent(props: Record<string, string>, before: readonly string[], after: readonly string[], beforeTopics: readonly MindTopic[], afterTopics: readonly MindTopic[], topicWrites: Record<string, string>): { writes: Record<string, string>; conflicts: string[] } {
  const old = new Set(before), next = new Set(after), oldTopics = new Set(beforeTopics.map((topic) => topic.id)), nextTopics = new Set(afterTopics.map((topic) => topic.id));
  const added = afterTopics.filter((topic) => !oldTopics.has(topic.id)).map((topic) => topic.id);
  const writes: Record<string, string> = {}, conflicts: string[] = [];
  for (const id of new Set([...old, ...next, ...added])) {
    // Topic deletion deliberately retains its fold flag for undo and old clients.
    if (!nextTopics.has(id)) continue;
    // A rejected new topic already has a node conflict; don't add a spurious fold conflict.
    if (!oldTopics.has(id) && !topicWrites[mindKey(id)]) continue;
    const key = mindCollapseKey(id), raw = props[key] ?? "", desired = next.has(id) ? "1" : "", was = old.has(id) ? "1" : "";
    if (oldTopics.has(id) && was === desired) continue;
    if (raw !== "" && raw !== "1") { conflicts.push(key); continue; }
    if (!storedMindTopic(props[mindKey(id)], id) && !topicWrites[mindKey(id)]) { conflicts.push(key); continue; }
    if (raw !== desired) writes[key] = desired;
  }
  return { writes, conflicts };
}
