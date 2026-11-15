import type { MindTopic, PositionedTopic } from "./mindmap";

export type MindDrop = { kind: "before" | "after" | "child"; target: string };

/** Include hidden descendants: a folded subtree must never be moved under itself. */
export function mindSubtree(topics: readonly MindTopic[], id: string): Set<string> {
  const ids = new Set([id]); let size = -1;
  while (size !== ids.size) { size = ids.size; for (const topic of topics) if (topic.parent && ids.has(topic.parent)) ids.add(topic.id); }
  return ids;
}

/** Pick a nearby visible topic; its right edge accepts a child, its top/bottom reorders. */
export function mindDropAt(topics: readonly MindTopic[], nodes: readonly PositionedTopic[], moving: string, point: { x: number; y: number }): MindDrop | null {
  const excluded = mindSubtree(topics, moving);
  const nearby = nodes.filter((node) => !excluded.has(node.topic.id) && point.x >= node.x - 30 && point.x <= node.x + node.w + 55 && point.y >= node.y - 24 && point.y <= node.y + node.h + 24)
    .sort((a, b) => Math.abs(point.y - (a.y + a.h / 2)) - Math.abs(point.y - (b.y + b.h / 2)));
  const target = nearby[0]; if (!target) return null;
  if (point.x >= target.x + target.w * 0.75 && point.y >= target.y - 8 && point.y <= target.y + target.h + 8) return { kind: "child", target: target.topic.id };
  if (!target.topic.parent) return null;
  return { kind: point.y < target.y + target.h / 2 ? "before" : "after", target: target.topic.id };
}

/** Return a reordered tree or null when the target is invalid or the move is a no-op. */
export function moveMindTopic(topics: readonly MindTopic[], id: string, drop: MindDrop): MindTopic[] | null {
  const source = topics.find((topic) => topic.id === id), target = topics.find((topic) => topic.id === drop.target);
  if (!source?.parent || !target || mindSubtree(topics, id).has(target.id)) return null;
  const parent = drop.kind === "child" ? target.id : target.parent;
  if (!parent) return null;
  const siblings = topics.filter((topic) => topic.parent === parent && topic.id !== id).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const targetIndex = siblings.findIndex((topic) => topic.id === target.id);
  if (drop.kind !== "child" && targetIndex < 0) return null;
  const index = drop.kind === "child" ? siblings.length : targetIndex + (drop.kind === "after" ? 1 : 0);
  const previous = siblings[index - 1]?.order, following = siblings[index]?.order;
  const order = previous === undefined ? (following === undefined ? 0 : following / 2) : following === undefined ? previous + 1 : (previous + following) / 2;
  const lacksSpace = order > 1000000 || (previous !== undefined && order <= previous) || (following !== undefined && order >= following);
  let result = topics.map((topic) => topic.id === id ? { ...topic, parent, order } : topic);
  if (lacksSpace) {
    const arranged = [...siblings]; arranged.splice(index, 0, { ...source, parent });
    const orders = new Map(arranged.map((topic, position) => [topic.id, position + 1]));
    result = result.map((topic) => orders.has(topic.id) ? { ...topic, order: orders.get(topic.id)! } : topic);
  }
  if (result.every((topic, i) => topic.parent === topics[i].parent && topic.order === topics[i].order)) return null;
  return result;
}
