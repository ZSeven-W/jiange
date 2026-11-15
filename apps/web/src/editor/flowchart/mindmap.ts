/** A topic is stored under its own block property, so edits to separate topics do not replace the tree. */
export type MindTopic = { id: string; parent: string | null; order: number; text: string; x?: number; y?: number };
export type MindStyle = { shape?: "text" | "oval" | "rect"; size?: number; color?: string };
export type MindStyles = Record<string, MindStyle>;
export type PositionedTopic = { topic: MindTopic; x: number; y: number; w: number; h: number };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX = "fc.m.";
export const mindKey = (id: string) => `${PREFIX}${id}`;
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
export function mindIntentWrites(props: Record<string, string>, before: readonly MindTopic[], after: readonly MindTopic[]): { writes: Record<string, string>; conflicts: string[] } {
  const old = new Map(before.map((n) => [n.id, n])), next = new Map(after.map((n) => [n.id, n]));
  const candidates = new Map<string, string>(), conflicts = new Set<string>();
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const prior = old.get(id), target = next.get(id), key = mindKey(id);
    const was = prior ? canonicalMindTopic(prior) : null, desired = target ? canonicalMindTopic(target) : null;
    if (was === desired) continue;
    if ((prior && !was) || (target && !desired) || (prior && target && prior.parent !== target.parent)) { conflicts.add(key); continue; }
    const live = storedMindTopic(props[key], id), now = live ? canonicalMindTopic(live) : null;
    if ((!!props[key] && !now) || (now !== was && now !== desired)) { conflicts.add(key); continue; }
    candidates.set(id, desired ?? "");
  }
  const live = readMindTopics(props), stored = Object.entries(props).filter(([key, raw]) => key.startsWith(PREFIX) && !!raw).map(([key, raw]) => storedMindTopic(raw, key.slice(PREFIX.length)));
  const malformed = stored.some((node) => !node), allStored = stored.filter((node): node is MindTopic => !!node);
  const attemptedAdds = [...candidates.keys()].filter((key) => !old.has(key) && candidates.get(key)).length;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, value] of candidates) {
      const target = next.get(id);
      const unsafeDelete = !value && (malformed || allStored.some((child) => child.parent === id && candidates.get(child.id) !== ""));
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
      const tooMany = !!target && !old.has(id) && live.length + attemptedAdds > 500;
      if (unsafeDelete || unsafeCreate || invalidTree || tooMany || (target?.parent && candidates.get(target.parent) === "")) { candidates.delete(id); conflicts.add(mindKey(id)); changed = true; }
    }
  }
  const writes: Record<string, string> = {};
  for (const [id, value] of candidates) { const existing = storedMindTopic(props[mindKey(id)], id); if ((existing ? canonicalMindTopic(existing) : "") !== value) writes[mindKey(id)] = value; }
  return { writes, conflicts: [...conflicts] };
}

/** A bounded, deterministic rightward tree layout. */
export function layoutMindTopics(topics: readonly MindTopic[], collapsed: ReadonlySet<string> = new Set(), styles: MindStyles = {}): PositionedTopic[] {
  const children = new Map<string, MindTopic[]>();
  for (const topic of topics) if (topic.parent) { const group = children.get(topic.parent) ?? []; group.push(topic); children.set(topic.parent, group); }
  for (const group of children.values()) group.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const sizes = new Map<string, number>();
  const dimensions = (topic: MindTopic) => { const root = topic.parent === null, size = styles[topic.id]?.size ?? (root ? 16 : 14), w = Math.max(root ? 104 : 90, Math.min(600, [...topic.text].length * size + 32)), h = Math.max(root ? 48 : 30, size + 16); return { w, h }; };
  const subtree = (topic: MindTopic): number => { const group = collapsed.has(topic.id) ? [] : children.get(topic.id) ?? []; const h = Math.max(dimensions(topic).h + 10, group.length ? group.reduce((total, child) => total + subtree(child), 0) + (group.length - 1) * 12 : 40); sizes.set(topic.id, h); return h; };
  const out: PositionedTopic[] = [];
  const place = (topic: MindTopic, x: number, centerY: number, depth: number) => {
    const { w, h } = dimensions(topic);
    out.push({ topic, x, y: centerY - h / 2, w, h });
    const group = collapsed.has(topic.id) ? [] : children.get(topic.id) ?? [], height = group.reduce((total, child) => total + (sizes.get(child.id) ?? 40), 0) + Math.max(0, group.length - 1) * 12;
    let y = centerY - height / 2;
    for (const child of group) { const childH = sizes.get(child.id) ?? 40; place(child, x + w + 60, y + childH / 2, depth + 1); y += childH + 12; }
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
    // A newly created id may carry an old tombstone. Reset it to the intended state;
    // an existing topic must still match the user's base or intended value.
    if (oldTopics.has(id) && raw !== was && raw !== desired) { conflicts.push(key); continue; }
    if (raw !== desired) writes[key] = desired;
  }
  return { writes, conflicts };
}
