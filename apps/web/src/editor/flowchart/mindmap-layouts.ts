import {
  layoutMindTopics,
  mindDescriptionAt,
  mindDescriptionLines,
  mindDescriptionStyleAt,
  mindDescriptionTextWidth,
  mindTitleHeight,
  type MindDescriptions,
  type MindDescriptionStyles,
  type MindStyles,
  type MindTopic,
  type PositionedTopic,
} from "./mindmap";

export type MindLayoutKind = "logic" | "org" | "fishbone" | "timeline";

export const MIND_LAYOUT_OPTIONS: readonly { value: MindLayoutKind; label: string }[] = [
  { value: "logic", label: "逻辑图" },
  { value: "org", label: "组织架构图" },
  { value: "fishbone", label: "鱼骨图" },
  { value: "timeline", label: "时间轴" },
];

export function isMindLayoutKind(value: unknown): value is MindLayoutKind {
  return value === "logic" || value === "org" || value === "fishbone" || value === "timeline";
}

export interface MindRelation {
  id: string;
  fromId: string;
  toId: string;
  label?: string;
}

export interface MindLayoutStorageConfig {
  structure: MindLayoutKind;
  relations: MindRelation[];
}

const LAYOUT_STORAGE_PREFIX = "jiange.board.mindlayout.v1:";

export function mindLayoutStorageKey(boardKey: string): string {
  return `${LAYOUT_STORAGE_PREFIX}${boardKey || "default"}`;
}

export function loadMindLayoutConfig(boardKey: string): MindLayoutStorageConfig {
  const fallback: MindLayoutStorageConfig = { structure: "logic", relations: [] };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(mindLayoutStorageKey(boardKey));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const structure: MindLayoutKind = isMindLayoutKind(parsed.structure) ? parsed.structure : "logic";
    const relations: MindRelation[] = Array.isArray(parsed.relations)
      ? parsed.relations
          .slice(0, 200)
          .filter((item): item is MindRelation => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return false;
            const r = item as Record<string, unknown>;
            return (
              typeof r.id === "string" &&
              r.id.length > 0 &&
              typeof r.fromId === "string" &&
              r.fromId.length > 0 &&
              typeof r.toId === "string" &&
              r.toId.length > 0 &&
              r.fromId !== r.toId
            );
          })
          .map((item) => ({
            id: item.id.slice(0, 64),
            fromId: item.fromId.slice(0, 64),
            toId: item.toId.slice(0, 64),
            ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.slice(0, 60) } : {}),
          }))
      : [];
    return { structure, relations };
  } catch {
    return fallback;
  }
}

export function saveMindLayoutConfig(boardKey: string, config: MindLayoutStorageConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (config.structure === "logic" && config.relations.length === 0) {
      localStorage.removeItem(mindLayoutStorageKey(boardKey));
    } else {
      localStorage.setItem(mindLayoutStorageKey(boardKey), JSON.stringify(config));
    }
  } catch {
    /* ignore restricted storage errors */
  }
}

function topicDimensions(
  topic: MindTopic,
  styles: MindStyles,
  descriptions: MindDescriptions,
  descriptionStyles: MindDescriptionStyles,
): { w: number; h: number } {
  const root = topic.parent === null;
  const size = styles[topic.id]?.size ?? (root ? 16 : 14);
  const description = mindDescriptionAt(descriptions, topic.id);
  const descSize = mindDescriptionStyleAt(descriptionStyles, topic.id)?.size ?? 12;
  const lines = description ? mindDescriptionLines(description, descSize) : [];
  const descWidth = lines.reduce((max, line) => Math.max(max, mindDescriptionTextWidth(line, descSize) + 28), 0);
  const w = Math.max(root ? 104 : 90, Math.min(600, [...topic.text].length * size + 32), descWidth);
  const h = mindTitleHeight(topic, styles) + (lines.length ? lines.length * Math.ceil(descSize * 1.35) + 8 : 0);
  return { w, h };
}

function buildChildrenMap(topics: readonly MindTopic[]): Map<string, MindTopic[]> {
  const children = new Map<string, MindTopic[]>();
  for (const topic of topics) {
    if (!topic.parent) continue;
    const group = children.get(topic.parent) ?? [];
    group.push(topic);
    children.set(topic.parent, group);
  }
  for (const group of children.values()) {
    group.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  return children;
}

function collectVisibleDescendants(
  parentId: string,
  children: Map<string, MindTopic[]>,
  collapsed: ReadonlySet<string>,
  depth = 1,
): Array<{ topic: MindTopic; depth: number }> {
  if (collapsed.has(parentId)) return [];
  const out: Array<{ topic: MindTopic; depth: number }> = [];
  for (const child of children.get(parentId) ?? []) {
    out.push({ topic: child, depth });
    if (depth < 32) {
      out.push(...collectVisibleDescendants(child.id, children, collapsed, depth + 1));
    }
  }
  return out;
}

function layoutOrgTopics(
  topics: readonly MindTopic[],
  collapsed: ReadonlySet<string>,
  styles: MindStyles,
  descriptions: MindDescriptions,
  descriptionStyles: MindDescriptionStyles,
): PositionedTopic[] {
  const H_GAP = 24;
  const V_GAP = 56;
  const children = buildChildrenMap(topics);
  const dims = new Map<string, { w: number; h: number }>();
  for (const t of topics) dims.set(t.id, topicDimensions(t, styles, descriptions, descriptionStyles));

  const subWidth = new Map<string, number>();
  const measure = (topic: MindTopic, depth = 0): number => {
    const dim = dims.get(topic.id)!;
    const group = collapsed.has(topic.id) || depth >= 32 ? [] : (children.get(topic.id) ?? []);
    const childrenW = group.length
      ? group.reduce((acc, c) => acc + measure(c, depth + 1), 0) + (group.length - 1) * H_GAP
      : 0;
    const w = Math.max(dim.w, childrenW);
    subWidth.set(topic.id, w);
    return w;
  };

  const out: PositionedTopic[] = [];
  const place = (topic: MindTopic, centerX: number, topY: number, depth = 0) => {
    const dim = dims.get(topic.id)!;
    out.push({ topic, x: Math.round(centerX - dim.w / 2), y: Math.round(topY), w: dim.w, h: dim.h });
    const group = collapsed.has(topic.id) || depth >= 32 ? [] : (children.get(topic.id) ?? []);
    if (!group.length) return;
    const childrenW = group.reduce((acc, c) => acc + subWidth.get(c.id)!, 0) + (group.length - 1) * H_GAP;
    let cursorX = centerX - childrenW / 2;
    const nextY = topY + dim.h + V_GAP;
    for (const child of group) {
      const cw = subWidth.get(child.id)!;
      place(child, cursorX + cw / 2, nextY, depth + 1);
      cursorX += cw + H_GAP;
    }
  };

  for (const root of topics.filter((t) => t.parent === null)) {
    measure(root);
    const rootDim = dims.get(root.id)!;
    place(root, (root.x ?? 0) + rootDim.w / 2, root.y ?? 0);
  }
  return out;
}

function layoutFishboneTopics(
  topics: readonly MindTopic[],
  collapsed: ReadonlySet<string>,
  styles: MindStyles,
  descriptions: MindDescriptions,
  descriptionStyles: MindDescriptionStyles,
): PositionedTopic[] {
  const SLANT_RATIO = 0.36;
  const SUB_GAP = 10;
  const RIB_CLEARANCE = 38;
  const children = buildChildrenMap(topics);
  const dims = new Map<string, { w: number; h: number }>();
  for (const t of topics) dims.set(t.id, topicDimensions(t, styles, descriptions, descriptionStyles));

  const out: PositionedTopic[] = [];
  for (const root of topics.filter((t) => t.parent === null)) {
    const rootDim = dims.get(root.id)!;
    const rootX = Math.round(root.x ?? 0);
    const rootY = Math.round(root.y ?? 0);
    const spineY = rootY + rootDim.h / 2;
    out.push({ topic: root, x: rootX, y: rootY, w: rootDim.w, h: rootDim.h });

    const branches = collapsed.has(root.id) ? [] : (children.get(root.id) ?? []);
    let topRightLimit = rootX - 52;
    let bottomRightLimit = rootX - 96;

    branches.forEach((branch, idx) => {
      const side = idx % 2 === 0 ? -1 : 1; // -1 above spine, +1 below spine
      const branchDim = dims.get(branch.id)!;
      const subs = collectVisibleDescendants(branch.id, children, collapsed).map((entry) => ({
        ...entry,
        ...dims.get(entry.topic.id)!,
      }));

      const subsTotalH = subs.reduce((acc, s) => acc + s.h + SUB_GAP, 0);
      const ribSpanY = Math.max(66, subsTotalH + 34);
      const branchY = side === -1 ? spineY - ribSpanY - branchDim.h : spineY + ribSpanY;

      // Compute node positions relative to attachX = 0 so we can measure exact horizontal span.
      const relNodes: Array<{ topic: MindTopic; relX: number; y: number; w: number; h: number }> = [];
      const tipRelX = -ribSpanY * SLANT_RATIO;
      const branchRelX = tipRelX - branchDim.w / 2;
      relNodes.push({ topic: branch, relX: branchRelX, y: branchY, w: branchDim.w, h: branchDim.h });

      let dyCursor = 24;
      for (const sub of subs) {
        const subCenterDy = dyCursor + sub.h / 2;
        const ribRelX = -subCenterDy * SLANT_RATIO;
        const indent = (sub.depth - 1) * 16;
        const subRelX = ribRelX - 18 - indent - sub.w;
        const subY = side === -1 ? spineY - dyCursor - sub.h : spineY + dyCursor;
        relNodes.push({ topic: sub.topic, relX: subRelX, y: subY, w: sub.w, h: sub.h });
        dyCursor += sub.h + SUB_GAP;
      }

      const minRelX = Math.min(...relNodes.map((n) => n.relX));
      const maxRelX = Math.max(0, ...relNodes.map((n) => n.relX + n.w));
      const limit = side === -1 ? topRightLimit : bottomRightLimit;
      const attachX = Math.round(limit - maxRelX);

      for (const item of relNodes) {
        out.push({
          topic: item.topic,
          x: Math.round(attachX + item.relX),
          y: Math.round(item.y),
          w: item.w,
          h: item.h,
        });
      }

      const nextLimit = attachX + minRelX - RIB_CLEARANCE;
      if (side === -1) topRightLimit = nextLimit;
      else bottomRightLimit = nextLimit;
    });
  }
  return out;
}

function layoutTimelineTopics(
  topics: readonly MindTopic[],
  collapsed: ReadonlySet<string>,
  styles: MindStyles,
  descriptions: MindDescriptions,
  descriptionStyles: MindDescriptionStyles,
): PositionedTopic[] {
  const AXIS_OFFSET = 44;
  const SUB_GAP = 10;
  const COL_GAP = 40;
  const children = buildChildrenMap(topics);
  const dims = new Map<string, { w: number; h: number }>();
  for (const t of topics) dims.set(t.id, topicDimensions(t, styles, descriptions, descriptionStyles));

  const out: PositionedTopic[] = [];
  for (const root of topics.filter((t) => t.parent === null)) {
    const rootDim = dims.get(root.id)!;
    const rootX = Math.round(root.x ?? 0);
    const rootY = Math.round(root.y ?? 0);
    const axisY = rootY + rootDim.h / 2;
    out.push({ topic: root, x: rootX, y: rootY, w: rootDim.w, h: rootDim.h });

    const milestones = collapsed.has(root.id) ? [] : (children.get(root.id) ?? []);
    let cursorX = rootX + rootDim.w + 56;

    milestones.forEach((milestone, idx) => {
      const side = idx % 2 === 0 ? -1 : 1; // -1 above timeline, +1 below timeline
      const mDim = dims.get(milestone.id)!;
      const mX = Math.round(cursorX);
      const mY = Math.round(side === -1 ? axisY - AXIS_OFFSET - mDim.h : axisY + AXIS_OFFSET);
      out.push({ topic: milestone, x: mX, y: mY, w: mDim.w, h: mDim.h });

      const subs = collectVisibleDescendants(milestone.id, children, collapsed).map((entry) => ({
        ...entry,
        ...dims.get(entry.topic.id)!,
      }));

      let maxColRight = mX + mDim.w;
      let yCursor = side === -1 ? mY - SUB_GAP : mY + mDim.h + SUB_GAP;
      for (const sub of subs) {
        const sx = mX + sub.depth * 18;
        const sy = side === -1 ? yCursor - sub.h : yCursor;
        out.push({ topic: sub.topic, x: Math.round(sx), y: Math.round(sy), w: sub.w, h: sub.h });
        maxColRight = Math.max(maxColRight, sx + sub.w);
        yCursor = side === -1 ? sy - SUB_GAP : sy + sub.h + SUB_GAP;
      }

      cursorX = Math.max(mX + 120, maxColRight) + COL_GAP;
    });
  }
  return out;
}

/**
 * Multi-structure MindMap layout engine:
 * - `"logic"`: delegates directly to `layoutMindTopics` (100% backward compatible)
 * - `"org"`: top-down vertical org-chart tree with balanced subtree widths
 * - `"fishbone"`: Ishikawa diagram (root head on right, alternating angled ribs)
 * - `"timeline"`: horizontal chronological spine (root on left, alternating milestones)
 */
export function layoutMindTopicsWithStructure(
  topics: readonly MindTopic[],
  structure: MindLayoutKind = "logic",
  collapsed: ReadonlySet<string> = new Set(),
  styles: MindStyles = {},
  descriptions: MindDescriptions = {},
  descriptionStyles: MindDescriptionStyles = {},
): PositionedTopic[] {
  switch (structure) {
    case "org":
      return layoutOrgTopics(topics, collapsed, styles, descriptions, descriptionStyles);
    case "fishbone":
      return layoutFishboneTopics(topics, collapsed, styles, descriptions, descriptionStyles);
    case "timeline":
      return layoutTimelineTopics(topics, collapsed, styles, descriptions, descriptionStyles);
    case "logic":
    default:
      return layoutMindTopics(topics, collapsed, styles, descriptions, descriptionStyles);
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function relationGeometry(fromPos: PositionedTopic, toPos: PositionedTopic) {
  const fx = fromPos.x + fromPos.w / 2;
  const fy = fromPos.y + fromPos.h / 2;
  const tx = toPos.x + toPos.w / 2;
  const ty = toPos.y + toPos.h / 2;
  const dx = tx - fx;
  const dy = ty - fy;

  let p0: { x: number; y: number };
  let p1: { x: number; y: number };
  if (Math.abs(dx) >= Math.abs(dy)) {
    p0 = dx >= 0 ? { x: fromPos.x + fromPos.w, y: fy } : { x: fromPos.x, y: fy };
    p1 = dx >= 0 ? { x: toPos.x, y: ty } : { x: toPos.x + toPos.w, y: ty };
  } else {
    p0 = dy >= 0 ? { x: fx, y: fromPos.y + fromPos.h } : { x: fx, y: fromPos.y };
    p1 = dy >= 0 ? { x: tx, y: toPos.y } : { x: tx, y: toPos.y + toPos.h };
  }

  const vx = p1.x - p0.x;
  const vy = p1.y - p0.y;
  const dist = Math.hypot(vx, vy);
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  const bend = dist > 1 ? Math.max(36, Math.min(140, dist * 0.28)) : 40;
  // Curve outward smoothly along the perpendicular normal (prefer arching upward when horizontal).
  let nx = dist > 1 ? -vy / dist : 0;
  let ny = dist > 1 ? vx / dist : -1;
  if (Math.abs(vx) >= Math.abs(vy) && ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const c = { x: mx + nx * bend, y: my + ny * bend };
  return { p0, c, p1 };
}

/** Compute a smooth quadratic bezier SVG curve path between any two cross-branch topics. */
export function mindRelationCurvePath(fromPos: PositionedTopic, toPos: PositionedTopic): string {
  const { p0, c, p1 } = relationGeometry(fromPos, toPos);
  return `M${round1(p0.x)},${round1(p0.y)} Q${round1(c.x)},${round1(c.y)} ${round1(p1.x)},${round1(p1.y)}`;
}

/** Compute the midpoint on the quadratic bezier curve (t = 0.5) for placing relation pill labels. */
export function mindRelationLabelPoint(fromPos: PositionedTopic, toPos: PositionedTopic): { x: number; y: number } {
  const { p0, c, p1 } = relationGeometry(fromPos, toPos);
  return {
    x: round1(0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x),
    y: round1(0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y),
  };
}
