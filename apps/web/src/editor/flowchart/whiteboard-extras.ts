import { newFlowId, type FlowNode } from "./model";
import type { MindTopic, PositionedTopic } from "./mindmap";
import type { MindLayoutKind } from "./mindmap-layouts";

/* ---------------- Sticky Notes ---------------- */

export interface StickyPreset {
  id: string;
  label: string;
  fill: string;
  stroke: string;
  fold: string;
  text: string;
}

export const STICKY_PRESETS: readonly StickyPreset[] = [
  { id: "yellow", label: "暖黄", fill: "#fff3b0", stroke: "#e6c963", fold: "#f0dc7a", text: "#1f2329" },
  { id: "pink", label: "樱粉", fill: "#ffd6e7", stroke: "#e8a4c0", fold: "#f5b8d1", text: "#1f2329" },
  { id: "mint", label: "薄荷绿", fill: "#d9f4e6", stroke: "#8fd1b1", fold: "#b5e6ce", text: "#1f2329" },
  { id: "sky", label: "天空蓝", fill: "#dcebff", stroke: "#94bbf5", fold: "#bad7ff", text: "#1f2329" },
  { id: "lavender", label: "薰衣草紫", fill: "#efe4ff", stroke: "#bfa3f2", fold: "#dcc8ff", text: "#1f2329" },
];

export const STICKY_DEFAULT_SIZE = { w: 180, h: 150 } as const;

export function stickyPresetForFill(fill?: string): StickyPreset {
  const lower = (fill ?? "").toLowerCase();
  return STICKY_PRESETS.find((p) => p.fill === lower) ?? STICKY_PRESETS[0];
}

export function createStickyNode(
  center: { x: number; y: number },
  existingNodes: readonly FlowNode[],
  presetOrFill?: StickyPreset | string,
): FlowNode {
  const preset =
    typeof presetOrFill === "string"
      ? stickyPresetForFill(presetOrFill)
      : presetOrFill ?? STICKY_PRESETS[0];
  const w = STICKY_DEFAULT_SIZE.w;
  const h = STICKY_DEFAULT_SIZE.h;
  const clampCoord = (v: number) => Math.round(Math.max(-20_000, Math.min(20_000, v)));
  const maxZ = existingNodes.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
  return {
    id: newFlowId("n"),
    shape: "sticky",
    text: "",
    x: clampCoord(center.x - w / 2),
    y: clampCoord(center.y - h / 2),
    w,
    h,
    fill: preset.fill,
    stroke: preset.stroke,
    color: preset.text,
    z: maxZ + 1,
  };
}

/* ---------------- CRDT Prop Prefixes & Validation ---------------- */

export const BOARD_VOTE_PROP_PREFIX = "fc.vt.";
export const MIND_BOUNDARY_PROP_PREFIX = "fc.mb.";
/**
 * Uses `fc.msu.` (Mind Summary) rather than `fc.ms.` because `fc.ms.<id>` is
 * already occupied by `@zseven-w/whiteboard-sdk`'s `MindStyle` prop key.
 */
export const MIND_SUMMARY_PROP_PREFIX = "fc.msu.";
export const MIND_BADGE_PROP_PREFIX = "fc.mg.";

const FLOW_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MIND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VOTER_ID_RE = /^[A-Za-z0-9_:@.-]{1,64}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const MAX_VOTE_RECORDS = 200;
const MAX_VOTERS_PER_NODE = 500;
const MAX_MIND_BOUNDARIES = 200;
const MAX_MIND_SUMMARIES = 200;
const MAX_MIND_BADGES = 500;

/* ---------------- Team Voting (fc.vt.<nodeId>) ---------------- */

export type BoardVotes = Record<string, string[]>;

export interface RankedVoteItem {
  nodeId: string;
  label: string;
  count: number;
  voters: string[];
}

export function boardVotePropKey(nodeId: string): string {
  return `${BOARD_VOTE_PROP_PREFIX}${nodeId}`;
}

export function normalizeBoardVote(input: unknown): { voters: string[] } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.voters)) return null;
  const seen = new Set<string>();
  const voters: string[] = [];
  for (const item of raw.voters) {
    if (voters.length >= MAX_VOTERS_PER_NODE) break;
    if (typeof item !== "string" || item.includes("\0")) continue;
    const trimmed = item.trim();
    if (!VOTER_ID_RE.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    voters.push(trimmed);
  }
  if (!voters.length) return null;
  voters.sort();
  return { voters };
}

export function canonicalBoardVote(voters: readonly string[] | undefined): string {
  if (!voters?.length) return "";
  const clean = normalizeBoardVote({ voters });
  return clean ? JSON.stringify(clean) : "";
}

export function readBoardVotesFromProps(props: Record<string, string>): BoardVotes {
  const entries: [string, string[]][] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (!key.startsWith(BOARD_VOTE_PROP_PREFIX) || !raw) continue;
    const nodeId = key.slice(BOARD_VOTE_PROP_PREFIX.length);
    if (!FLOW_ID_RE.test(nodeId)) continue;
    try {
      const clean = normalizeBoardVote(JSON.parse(raw));
      if (clean) entries.push([nodeId, clean.voters]);
    } catch {
      /* ignore corrupt vote entry */
    }
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(entries.slice(0, MAX_VOTE_RECORDS));
}

export function boardVotePropWrites(before: BoardVotes, after: BoardVotes): Record<string, string> {
  const writes: Record<string, string> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const nodeId of keys) {
    if (!FLOW_ID_RE.test(nodeId)) continue;
    const prev = canonicalBoardVote(before[nodeId]);
    const next = canonicalBoardVote(after[nodeId]);
    if (prev !== next) writes[boardVotePropKey(nodeId)] = next;
  }
  return writes;
}

export function toggleNodeVote(votes: BoardVotes, nodeId: string, voterId: string): BoardVotes {
  const cleanVoter = voterId.trim();
  if (!FLOW_ID_RE.test(nodeId) || !VOTER_ID_RE.test(cleanVoter)) return votes;
  const current = new Set(votes[nodeId] ?? []);
  if (current.has(cleanVoter)) current.delete(cleanVoter);
  else if (current.size < MAX_VOTERS_PER_NODE) current.add(cleanVoter);
  const next: BoardVotes = { ...votes };
  if (current.size === 0) {
    delete next[nodeId];
  } else {
    next[nodeId] = [...current].sort();
  }
  return next;
}

export function topVotedNodes(
  votes: BoardVotes,
  nodes: readonly FlowNode[],
  limit = 5,
): RankedVoteItem[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const items: RankedVoteItem[] = [];
  for (const [nodeId, voters] of Object.entries(votes)) {
    const node = nodeMap.get(nodeId);
    if (!node || !voters.length) continue;
    const firstLine = node.text.split("\n")[0]?.trim() ?? "";
    items.push({
      nodeId,
      label: firstLine || (node.shape === "sticky" ? "便利贴" : "图形"),
      count: voters.length,
      voters,
    });
  }
  items.sort((a, b) => b.count - a.count || a.nodeId.localeCompare(b.nodeId));
  return items.slice(0, Math.max(0, limit));
}

/* ---------------- MindMap Boundary (fc.mb.<nodeId>) ---------------- */

export interface MindBoundary {
  label?: string;
  color: string;
}

export type MindBoundaries = Record<string, MindBoundary>;

export const MIND_BOUNDARY_COLORS = [
  "#3370ff",
  "#722ed1",
  "#2ea121",
  "#ff8800",
  "#d83931",
  "#14a3a3",
] as const;

export function mindBoundaryPropKey(nodeId: string): string {
  return `${MIND_BOUNDARY_PROP_PREFIX}${nodeId}`;
}

export function normalizeMindBoundary(input: unknown): MindBoundary | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  let color = "#3370ff";
  if (raw.color !== undefined && raw.color !== null) {
    if (typeof raw.color !== "string" || !HEX_COLOR_RE.test(raw.color)) return null;
    color = raw.color.toLowerCase();
  }
  let label: string | undefined;
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== "string" || raw.label.includes("\0") || raw.label.length > 40) return null;
    const trimmed = raw.label.trim();
    if (trimmed) label = trimmed;
  }
  return { ...(label ? { label } : {}), color };
}

export function canonicalMindBoundary(boundary: MindBoundary | undefined): string {
  if (!boundary) return "";
  const clean = normalizeMindBoundary(boundary);
  return clean ? JSON.stringify(clean) : "";
}

export function readMindBoundariesFromProps(props: Record<string, string>): MindBoundaries {
  const entries: [string, MindBoundary][] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (!key.startsWith(MIND_BOUNDARY_PROP_PREFIX) || !raw) continue;
    const nodeId = key.slice(MIND_BOUNDARY_PROP_PREFIX.length);
    if (!MIND_ID_RE.test(nodeId)) continue;
    try {
      const clean = normalizeMindBoundary(JSON.parse(raw));
      if (clean) entries.push([nodeId, clean]);
    } catch {
      /* ignore corrupt boundary entry */
    }
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(entries.slice(0, MAX_MIND_BOUNDARIES));
}

export function mindBoundaryPropWrites(
  before: MindBoundaries,
  after: MindBoundaries,
): Record<string, string> {
  const writes: Record<string, string> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const id of keys) {
    if (!MIND_ID_RE.test(id)) continue;
    const prev = canonicalMindBoundary(before[id]);
    const next = canonicalMindBoundary(after[id]);
    if (prev !== next) writes[mindBoundaryPropKey(id)] = next;
  }
  return writes;
}

/* ---------------- MindMap Summary (fc.msu.<parentId>) ---------------- */

export interface MindSummary {
  label: string;
  color: string;
}

export type MindSummaries = Record<string, MindSummary>;

export const MIND_SUMMARY_COLORS = [
  "#722ed1",
  "#3370ff",
  "#2ea121",
  "#ff8800",
  "#d83931",
] as const;

export function mindSummaryPropKey(parentId: string): string {
  return `${MIND_SUMMARY_PROP_PREFIX}${parentId}`;
}

export function normalizeMindSummary(input: unknown): MindSummary | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  let color = "#722ed1";
  if (raw.color !== undefined && raw.color !== null) {
    if (typeof raw.color !== "string" || !HEX_COLOR_RE.test(raw.color)) return null;
    color = raw.color.toLowerCase();
  }
  let label = "概要";
  if (raw.label !== undefined && raw.label !== null) {
    if (typeof raw.label !== "string" || raw.label.includes("\0") || raw.label.length > 80) return null;
    const trimmed = raw.label.trim();
    if (trimmed) label = trimmed;
  }
  return { label, color };
}

export function canonicalMindSummary(summary: MindSummary | undefined): string {
  if (!summary) return "";
  const clean = normalizeMindSummary(summary);
  return clean ? JSON.stringify(clean) : "";
}

export function readMindSummariesFromProps(props: Record<string, string>): MindSummaries {
  const entries: [string, MindSummary][] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (!key.startsWith(MIND_SUMMARY_PROP_PREFIX) || !raw) continue;
    const parentId = key.slice(MIND_SUMMARY_PROP_PREFIX.length);
    if (!MIND_ID_RE.test(parentId)) continue;
    try {
      const clean = normalizeMindSummary(JSON.parse(raw));
      if (clean) entries.push([parentId, clean]);
    } catch {
      /* ignore corrupt summary entry */
    }
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(entries.slice(0, MAX_MIND_SUMMARIES));
}

export function mindSummaryPropWrites(
  before: MindSummaries,
  after: MindSummaries,
): Record<string, string> {
  const writes: Record<string, string> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const id of keys) {
    if (!MIND_ID_RE.test(id)) continue;
    const prev = canonicalMindSummary(before[id]);
    const next = canonicalMindSummary(after[id]);
    if (prev !== next) writes[mindSummaryPropKey(id)] = next;
  }
  return writes;
}

/* ---------------- MindMap Node Badges (fc.mg.<nodeId>) ---------------- */

export type MindPriority = 1 | 2 | 3;
export type MindProgress = 0 | 25 | 50 | 75 | 100;

export const MIND_PRIORITIES: readonly MindPriority[] = [1, 2, 3];
export const MIND_PROGRESS_STEPS: readonly MindProgress[] = [0, 25, 50, 75, 100];

export interface MindBadge {
  priority?: MindPriority;
  progress?: MindProgress;
  tag?: string;
}

export type MindBadges = Record<string, MindBadge>;

export function mindBadgePropKey(nodeId: string): string {
  return `${MIND_BADGE_PROP_PREFIX}${nodeId}`;
}

export function normalizeMindBadge(input: unknown): MindBadge | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: MindBadge = {};
  if (raw.priority !== undefined && raw.priority !== null) {
    if (raw.priority !== 1 && raw.priority !== 2 && raw.priority !== 3) return null;
    out.priority = raw.priority;
  }
  if (raw.progress !== undefined && raw.progress !== null) {
    if (
      raw.progress !== 0 &&
      raw.progress !== 25 &&
      raw.progress !== 50 &&
      raw.progress !== 75 &&
      raw.progress !== 100
    ) {
      return null;
    }
    out.progress = raw.progress;
  }
  if (raw.tag !== undefined && raw.tag !== null) {
    if (typeof raw.tag !== "string" || raw.tag.includes("\0") || raw.tag.length > 16) return null;
    const trimmed = raw.tag.trim();
    if (trimmed) out.tag = trimmed;
  }
  if (out.priority === undefined && out.progress === undefined && out.tag === undefined) {
    return null;
  }
  return out;
}

export function canonicalMindBadge(badge: MindBadge | undefined): string {
  if (!badge) return "";
  const clean = normalizeMindBadge(badge);
  return clean ? JSON.stringify(clean) : "";
}

export function readMindBadgesFromProps(props: Record<string, string>): MindBadges {
  const entries: [string, MindBadge][] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (!key.startsWith(MIND_BADGE_PROP_PREFIX) || !raw) continue;
    const nodeId = key.slice(MIND_BADGE_PROP_PREFIX.length);
    if (!MIND_ID_RE.test(nodeId)) continue;
    try {
      const clean = normalizeMindBadge(JSON.parse(raw));
      if (clean) entries.push([nodeId, clean]);
    } catch {
      /* ignore corrupt badge entry */
    }
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(entries.slice(0, MAX_MIND_BADGES));
}

export function mindBadgePropWrites(before: MindBadges, after: MindBadges): Record<string, string> {
  const writes: Record<string, string> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const id of keys) {
    if (!MIND_ID_RE.test(id)) continue;
    const prev = canonicalMindBadge(before[id]);
    const next = canonicalMindBadge(after[id]);
    if (prev !== next) writes[mindBadgePropKey(id)] = next;
  }
  return writes;
}

export function priorityBadgeMeta(priority: MindPriority): {
  label: string;
  bg: string;
  fg: string;
  border: string;
} {
  switch (priority) {
    case 1:
      return { label: "P1", bg: "#fde8e8", fg: "#d83931", border: "#f5b5b2" };
    case 2:
      return { label: "P2", bg: "#fff1e0", fg: "#de7802", border: "#ffd099" };
    case 3:
      return { label: "P3", bg: "#e8f0ff", fg: "#3370ff", border: "#b3cdff" };
  }
}

/** SVG path for a crisp clockwise pie wedge representing 0/25/50/75/100% progress. */
export function progressWedgePath(cx: number, cy: number, r: number, progress: MindProgress): string {
  if (progress <= 0) return "";
  if (progress >= 100) {
    return `M${cx},${cy - r} A${r},${r} 0 1,1 ${cx},${cy + r} A${r},${r} 0 1,1 ${cx},${cy - r} Z`;
  }
  const angle = (progress / 100) * Math.PI * 2 - Math.PI / 2;
  const ex = Math.round((cx + r * Math.cos(angle)) * 100) / 100;
  const ey = Math.round((cy + r * Math.sin(angle)) * 100) / 100;
  const largeArc = progress > 50 ? 1 : 0;
  return `M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${largeArc},1 ${ex},${ey} Z`;
}

/* ---------------- Unified Extras Bundle ---------------- */

export interface WhiteboardExtras {
  votes: BoardVotes;
  mindBoundaries: MindBoundaries;
  mindSummaries: MindSummaries;
  mindBadges: MindBadges;
}

export const EMPTY_WHITEBOARD_EXTRAS: WhiteboardExtras = {
  votes: {},
  mindBoundaries: {},
  mindSummaries: {},
  mindBadges: {},
};

export function readWhiteboardExtrasFromProps(props: Record<string, string>): WhiteboardExtras {
  return {
    votes: readBoardVotesFromProps(props),
    mindBoundaries: readMindBoundariesFromProps(props),
    mindSummaries: readMindSummariesFromProps(props),
    mindBadges: readMindBadgesFromProps(props),
  };
}

export function whiteboardExtrasPropWrites(
  before: WhiteboardExtras,
  after: WhiteboardExtras,
): Record<string, string> {
  return {
    ...boardVotePropWrites(before.votes, after.votes),
    ...mindBoundaryPropWrites(before.mindBoundaries, after.mindBoundaries),
    ...mindSummaryPropWrites(before.mindSummaries, after.mindSummaries),
    ...mindBadgePropWrites(before.mindBadges, after.mindBadges),
  };
}

/* ---------------- MindMap Geometry (Boundaries & Summary Braces) ---------------- */

export function collectSubtreeIds(rootId: string, topics: readonly MindTopic[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const t of topics) {
    if (!t.parent) continue;
    const list = children.get(t.parent);
    if (list) list.push(t.id);
    else children.set(t.parent, [t.id]);
  }
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const childId of children.get(cur) ?? []) {
      if (!seen.has(childId)) stack.push(childId);
    }
  }
  return seen;
}

export function computeBoundaryBox(
  rootId: string,
  topics: readonly MindTopic[],
  positioned: readonly PositionedTopic[],
): { x: number; y: number; w: number; h: number } | null {
  const subtree = collectSubtreeIds(rootId, topics);
  const visible = positioned.filter((p) => subtree.has(p.topic.id));
  if (!visible.length) return null;
  const minX = Math.min(...visible.map((p) => p.x));
  const minY = Math.min(...visible.map((p) => p.y));
  const maxX = Math.max(...visible.map((p) => p.x + p.w));
  const maxY = Math.max(...visible.map((p) => p.y + p.h));
  const padX = 14;
  const padTop = 24;
  const padBottom = 14;
  return {
    x: Math.round(minX - padX),
    y: Math.round(minY - padTop),
    w: Math.round(maxX - minX + padX * 2),
    h: Math.round(maxY - minY + padTop + padBottom),
  };
}

export interface SummaryBraceGeometry {
  path: string;
  labelX: number;
  labelY: number;
  anchor: "start" | "end" | "middle";
  box: { x: number; y: number; w: number; h: number };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Compute a crisp SVG cubic Bézier curly brace (`}` / `{` / bottom horizontal)
 * enclosing all visible children (and their visible descendants) of `parentId`.
 */
export function computeSummaryBrace(
  parentId: string,
  topics: readonly MindTopic[],
  positioned: readonly PositionedTopic[],
  structure: MindLayoutKind = "logic",
  labelText = "概要",
): SummaryBraceGeometry | null {
  const directChildren = topics.filter((t) => t.parent === parentId);
  if (!directChildren.length) return null;
  const covered = new Set<string>();
  for (const child of directChildren) {
    for (const id of collectSubtreeIds(child.id, topics)) covered.add(id);
  }
  const visible = positioned.filter((p) => covered.has(p.topic.id));
  if (!visible.length) return null;

  const minX = Math.min(...visible.map((p) => p.x));
  const minY = Math.min(...visible.map((p) => p.y));
  const maxX = Math.max(...visible.map((p) => p.x + p.w));
  const maxY = Math.max(...visible.map((p) => p.y + p.h));

  const pillW = Math.max(
    44,
    [...labelText].reduce((sum, ch) => sum + (/[\u2e80-\uffff]/.test(ch) ? 12 : 7), 0) + 20,
  );
  const pillH = 26;

  if (structure === "org") {
    const x0 = minX - 4;
    const x1 = maxX + 4;
    const xm = (x0 + x1) / 2;
    const yBase = maxY + 12;
    const yTip = yBase + 14;
    const yMid = (yBase + yTip) / 2;
    const r = Math.min(12, Math.max(4, (x1 - x0) / 6));
    const path = [
      `M${round1(x0)},${round1(yBase)}`,
      `C${round1(x0)},${round1(yMid)} ${round1(x0 + r)},${round1(yMid)} ${round1(xm - r)},${round1(yMid)}`,
      `C${round1(xm)},${round1(yMid)} ${round1(xm)},${round1(yTip)} ${round1(xm)},${round1(yTip)}`,
      `C${round1(xm)},${round1(yTip)} ${round1(xm)},${round1(yMid)} ${round1(xm + r)},${round1(yMid)}`,
      `C${round1(x1 - r)},${round1(yMid)} ${round1(x1)},${round1(yMid)} ${round1(x1)},${round1(yBase)}`,
    ].join(" ");
    const labelX = round1(xm);
    const labelY = round1(yTip + pillH / 2 + 6);
    return {
      path,
      labelX,
      labelY,
      anchor: "middle",
      box: {
        x: Math.min(x0, labelX - pillW / 2),
        y: yBase,
        w: Math.max(x1 - x0, pillW),
        h: yTip - yBase + pillH + 10,
      },
    };
  }

  const y0 = minY - 4;
  const y1 = maxY + 4;
  const ym = (y0 + y1) / 2;
  const r = Math.min(12, Math.max(4, (y1 - y0) / 6));
  const dir = structure === "fishbone" ? -1 : 1;
  const xBase = dir === 1 ? maxX + 14 : minX - 14;
  const xTip = xBase + dir * 14;
  const xMid = (xBase + xTip) / 2;

  const path = [
    `M${round1(xBase)},${round1(y0)}`,
    `C${round1(xMid)},${round1(y0)} ${round1(xMid)},${round1(y0 + r)} ${round1(xMid)},${round1(ym - r)}`,
    `C${round1(xMid)},${round1(ym)} ${round1(xTip)},${round1(ym)} ${round1(xTip)},${round1(ym)}`,
    `C${round1(xTip)},${round1(ym)} ${round1(xMid)},${round1(ym)} ${round1(xMid)},${round1(ym + r)}`,
    `C${round1(xMid)},${round1(y1 - r)} ${round1(xMid)},${round1(y1)} ${round1(xBase)},${round1(y1)}`,
  ].join(" ");

  const labelX = round1(xTip + dir * 8);
  const labelY = round1(ym);
  const boxX = dir === 1 ? xBase : labelX - pillW;
  return {
    path,
    labelX,
    labelY,
    anchor: dir === 1 ? "start" : "end",
    box: {
      x: boxX,
      y: Math.min(y0, labelY - pillH / 2),
      w: Math.abs(xTip - xBase) + 8 + pillW,
      h: Math.max(y1 - y0, pillH),
    },
  };
}
