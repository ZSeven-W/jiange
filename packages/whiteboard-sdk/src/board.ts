/**
 * AI-Native Board Facade for `@zseven-w/whiteboard-sdk`.
 *
 * Unifies flowcharts, mind maps, and freehand strokes with atomic `apply()` (dry-run & rollback),
 * undo/redo, token-budgeted `inspect()`, `query()`, layered auto-layout, align/distribute helpers,
 * structural `verify()` diagnostics, and Mermaid / SVG / XMind / CRDT-props I/O.
 */

import { fromMermaid, type FromMermaidOptions } from "./mermaid.js";
import type { MindTopic } from "./mindmap.js";
import {
  autoLayout,
  flowWrites,
  isContainer,
  measureLabel,
  readFlow,
  SHAPES,
  themeOf,
  toMermaid,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowStroke,
  type Shape,
} from "./model.js";
import { renderBoardToSvg, type BoardSvgOptions } from "./svg.js";
import {
  exportMindMapToXmind,
  exportMindMapToXmindAsync,
  parseXmindToMindMap,
  type XmindExportOptions,
} from "./xmind.js";

export type BoardDiagnosticSeverity = "error" | "warning" | "info";

export interface BoardDiagnostic {
  code:
    | "EMPTY_BOARD"
    | "DANGLING_EDGE"
    | "SELF_LOOP"
    | "ISOLATED_NODE"
    | "OVERLAPPING_NODES"
    | "CYCLE_DETECTED"
    | "ORPHAN_MIND_TOPIC";
  severity: BoardDiagnosticSeverity;
  entityId?: string;
  message: string;
  suggestion: string;
}

export type BoardOp =
  | { op: "addNode"; node: Omit<FlowNode, "id" | "x" | "y" | "w" | "h"> & Partial<Pick<FlowNode, "id" | "x" | "y" | "w" | "h">> }
  | { op: "updateNode"; id: string; patch: Partial<Omit<FlowNode, "id">> }
  | { op: "deleteNode"; id: string }
  | { op: "addEdge"; edge: Omit<FlowEdge, "id"> & { id?: string } }
  | { op: "updateEdge"; id: string; patch: Partial<Omit<FlowEdge, "id">> }
  | { op: "deleteEdge"; id: string }
  | { op: "addMindTopic"; topic: Omit<MindTopic, "id" | "order"> & { id?: string; order?: number } }
  | { op: "updateMindTopic"; id: string; patch: Partial<Omit<MindTopic, "id">> }
  | { op: "deleteMindTopic"; id: string }
  | { op: "addStroke"; stroke: Omit<FlowStroke, "id"> & { id?: string } }
  | { op: "deleteStroke"; id: string }
  | { op: "autoLayout"; direction?: "TB" | "LR"; gapX?: number; gapY?: number }
  | { op: "setTheme"; theme: string };

export interface BoardApplyOptions {
  dryRun?: boolean;
  atomic?: boolean;
  actor?: string;
}

export interface BoardApplyResult {
  ok: boolean;
  applied: number;
  undoToken: string | null;
  diff: Array<{ op: BoardOp["op"]; detail: string }>;
  warnings: string[];
  errors: string[];
}

export interface BoardInspectOptions {
  detail?: "summary" | "standard" | "full";
  maxTokens?: number;
}

export interface BoardInspectResult {
  theme: string;
  nodeCount: number;
  edgeCount: number;
  mindTopicCount: number;
  strokeCount: number;
  truncated: boolean;
  nodes?: Array<Pick<FlowNode, "id" | "shape" | "text"> & Partial<Pick<FlowNode, "x" | "y" | "w" | "h">>>;
  edges?: Array<Pick<FlowEdge, "id" | "from" | "to" | "label" | "dashed" | "arrow">>;
  mind?: MindTopic[];
}

export interface BoardQueryOptions {
  text?: string;
  shape?: Shape;
  connectedTo?: string;
}

export interface BoardQueryResult {
  nodes: FlowNode[];
  edges: FlowEdge[];
  mind: MindTopic[];
}

const SHAPE_DEFAULTS = new Map(SHAPES.map((s) => [s.id, { w: s.w, h: s.h }]));

function cloneGraph(graph: FlowGraph): FlowGraph {
  return {
    theme: graph.theme,
    nodes: graph.nodes.map((n) => ({ ...n })),
    edges: graph.edges.map((e) => ({ ...e, pts: e.pts ? e.pts.map((p) => ({ ...p })) : undefined })),
    ...(graph.strokes ? { strokes: graph.strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })) } : {}),
    ...(graph.mind ? { mind: graph.mind.map((m) => ({ ...m })) } : {}),
    ...(graph.mindCollapsed ? { mindCollapsed: [...graph.mindCollapsed] } : {}),
    ...(graph.mindStyles ? { mindStyles: { ...graph.mindStyles } } : {}),
    ...(graph.mindPaints ? { mindPaints: { ...graph.mindPaints } } : {}),
    ...(graph.mindTextFormats ? { mindTextFormats: { ...graph.mindTextFormats } } : {}),
    ...(graph.mindDescriptions ? { mindDescriptions: { ...graph.mindDescriptions } } : {}),
    ...(graph.mindDescriptionStyles ? { mindDescriptionStyles: { ...graph.mindDescriptionStyles } } : {}),
  };
}

export class Board {
  private graph: FlowGraph;
  private seq = 1;
  private undoStack: Array<{ token: string; snapshot: FlowGraph }> = [];
  private redoStack: FlowGraph[] = [];
  private undoSeq = 1;

  private constructor(graph: FlowGraph) {
    this.graph = cloneGraph(graph);
  }

  static create(options?: { theme?: string }): Board {
    return new Board({ nodes: [], edges: [], theme: themeOf(options?.theme).id });
  }

  static fromGraph(graph: FlowGraph): Board {
    return new Board(graph);
  }

  static fromProps(props: Record<string, string>): Board {
    return new Board(readFlow(props));
  }

  static fromMermaid(code: string, options?: FromMermaidOptions): Board {
    return new Board(fromMermaid(code, options));
  }

  static async fromXmind(bytes: Uint8Array, options?: { theme?: string }): Promise<{ board: Board; warnings: string[] }> {
    const imported = await parseXmindToMindMap(bytes);
    const board = new Board({
      nodes: [],
      edges: [],
      mind: imported.mind,
      mindCollapsed: imported.mindCollapsed,
      mindStyles: imported.mindStyles,
      mindPaints: imported.mindPaints,
      mindTextFormats: imported.mindTextFormats,
      mindDescriptions: imported.mindDescriptions,
      theme: themeOf(options?.theme).id,
    });
    return { board, warnings: imported.warnings };
  }

  private nextId(prefix: string): string {
    return `${prefix}${this.seq++}`;
  }

  private pushUndo(before: FlowGraph): string {
    const token = `wb-undo-${this.undoSeq++}`;
    this.undoStack.push({ token, snapshot: before });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    return token;
  }

  toGraph(): FlowGraph {
    return cloneGraph(this.graph);
  }

  toProps(baseProps: Record<string, string> = {}): Record<string, string> {
    return { ...baseProps, ...flowWrites(baseProps, this.graph) };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const item = this.undoStack.pop();
    if (!item) return false;
    this.redoStack.push(cloneGraph(this.graph));
    this.graph = cloneGraph(item.snapshot);
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    this.undoStack.push({ token: `wb-undo-${this.undoSeq++}`, snapshot: cloneGraph(this.graph) });
    this.graph = cloneGraph(snap);
    return true;
  }

  autoLayout(opts?: { direction?: "TB" | "LR"; gapX?: number; gapY?: number }): FlowGraph {
    this.pushUndo(cloneGraph(this.graph));
    this.graph = autoLayout(this.graph, opts);
    return this.toGraph();
  }

  alignNodes(ids: readonly string[], mode: "left" | "center" | "right" | "top" | "middle" | "bottom"): void {
    const set = new Set(ids);
    const targets = this.graph.nodes.filter((n) => set.has(n.id));
    if (targets.length < 2) return;
    this.pushUndo(cloneGraph(this.graph));
    if (mode === "left") {
      const ref = Math.min(...targets.map((n) => n.x));
      targets.forEach((n) => { n.x = ref; });
    } else if (mode === "right") {
      const ref = Math.max(...targets.map((n) => n.x + n.w));
      targets.forEach((n) => { n.x = ref - n.w; });
    } else if (mode === "center") {
      const ref = targets.reduce((s, n) => s + n.x + n.w / 2, 0) / targets.length;
      targets.forEach((n) => { n.x = Math.round(ref - n.w / 2); });
    } else if (mode === "top") {
      const ref = Math.min(...targets.map((n) => n.y));
      targets.forEach((n) => { n.y = ref; });
    } else if (mode === "bottom") {
      const ref = Math.max(...targets.map((n) => n.y + n.h));
      targets.forEach((n) => { n.y = ref - n.h; });
    } else {
      const ref = targets.reduce((s, n) => s + n.y + n.h / 2, 0) / targets.length;
      targets.forEach((n) => { n.y = Math.round(ref - n.h / 2); });
    }
  }

  distributeNodes(ids: readonly string[], axis: "horizontal" | "vertical"): void {
    const set = new Set(ids);
    const targets = this.graph.nodes.filter((n) => set.has(n.id));
    if (targets.length < 3) return;
    this.pushUndo(cloneGraph(this.graph));
    if (axis === "horizontal") {
      targets.sort((a, b) => a.x - b.x);
      const first = targets[0];
      const last = targets[targets.length - 1];
      const totalNodeW = targets.reduce((s, n) => s + n.w, 0);
      const span = last.x + last.w - first.x;
      const gap = (span - totalNodeW) / (targets.length - 1);
      let cursor = first.x;
      for (const n of targets) {
        n.x = Math.round(cursor);
        cursor += n.w + gap;
      }
    } else {
      targets.sort((a, b) => a.y - b.y);
      const first = targets[0];
      const last = targets[targets.length - 1];
      const totalNodeH = targets.reduce((s, n) => s + n.h, 0);
      const span = last.y + last.h - first.y;
      const gap = (span - totalNodeH) / (targets.length - 1);
      let cursor = first.y;
      for (const n of targets) {
        n.y = Math.round(cursor);
        cursor += n.h + gap;
      }
    }
  }

  inspect(options: BoardInspectOptions = {}): BoardInspectResult {
    const detail = options.detail ?? "standard";
    const maxChars = Math.max(200, (options.maxTokens ?? 4000) * 4);
    const base: BoardInspectResult = {
      theme: this.graph.theme,
      nodeCount: this.graph.nodes.length,
      edgeCount: this.graph.edges.length,
      mindTopicCount: this.graph.mind?.length ?? 0,
      strokeCount: this.graph.strokes?.length ?? 0,
      truncated: false,
    };
    if (detail === "summary") return base;

    let used = 160;
    const nodes: NonNullable<BoardInspectResult["nodes"]> = [];
    for (const n of this.graph.nodes) {
      const entry =
        detail === "full"
          ? { id: n.id, shape: n.shape, text: n.text, x: n.x, y: n.y, w: n.w, h: n.h }
          : { id: n.id, shape: n.shape, text: n.text };
      const sz = JSON.stringify(entry).length;
      if (used + sz > maxChars) {
        base.truncated = true;
        break;
      }
      used += sz;
      nodes.push(entry);
    }

    const edges: NonNullable<BoardInspectResult["edges"]> = [];
    for (const e of this.graph.edges) {
      const entry = { id: e.id, from: e.from, to: e.to, label: e.label, dashed: e.dashed, arrow: e.arrow };
      const sz = JSON.stringify(entry).length;
      if (used + sz > maxChars) {
        base.truncated = true;
        break;
      }
      used += sz;
      edges.push(entry);
    }

    base.nodes = nodes;
    base.edges = edges;
    if (this.graph.mind && this.graph.mind.length > 0 && !base.truncated) {
      base.mind = this.graph.mind.map((m) => ({ ...m }));
    }
    return base;
  }

  query(options: BoardQueryOptions = {}): BoardQueryResult {
    const needle = options.text?.trim().toLowerCase();
    const connectedSet = new Set<string>();
    if (options.connectedTo) {
      connectedSet.add(options.connectedTo);
      for (const e of this.graph.edges) {
        if (e.from === options.connectedTo) connectedSet.add(e.to);
        if (e.to === options.connectedTo) connectedSet.add(e.from);
      }
    }

    const nodes = this.graph.nodes.filter((n) => {
      if (options.shape && n.shape !== options.shape) return false;
      if (options.connectedTo && !connectedSet.has(n.id)) return false;
      if (needle && !n.text.toLowerCase().includes(needle) && !n.id.toLowerCase().includes(needle)) return false;
      return true;
    });

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = this.graph.edges.filter((e) => {
      if (options.connectedTo && e.from !== options.connectedTo && e.to !== options.connectedTo) return false;
      if (needle) {
        const lbl = (e.label ?? "").toLowerCase();
        return lbl.includes(needle) || nodeIds.has(e.from) || nodeIds.has(e.to);
      }
      return !options.shape || nodeIds.has(e.from) || nodeIds.has(e.to);
    });

    const mind = (this.graph.mind ?? []).filter((m) => {
      if (needle) return m.text.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle);
      return !options.shape && !options.connectedTo;
    });

    return { nodes: nodes.map((n) => ({ ...n })), edges: edges.map((e) => ({ ...e })), mind: mind.map((m) => ({ ...m })) };
  }

  apply(ops: readonly BoardOp[], options: BoardApplyOptions = {}): BoardApplyResult {
    const atomic = options.atomic !== false;
    const dryRun = Boolean(options.dryRun);
    const before = cloneGraph(this.graph);
    const diff: BoardApplyResult["diff"] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let applied = 0;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      try {
        switch (op.op) {
          case "addNode": {
            const id = op.node.id ?? this.nextId("n");
            if (this.graph.nodes.some((n) => n.id === id)) throw new Error(`duplicate node id "${id}"`);
            const dims = SHAPE_DEFAULTS.get(op.node.shape) ?? { w: 140, h: 60 };
            const node: FlowNode = {
              ...op.node,
              id,
              x: op.node.x ?? 40 + this.graph.nodes.length * 180,
              y: op.node.y ?? 40,
              w: op.node.w ?? measureLabel(op.node.text, dims.w),
              h: op.node.h ?? dims.h,
            };
            this.graph.nodes.push(node);
            diff.push({ op: op.op, detail: `added node "${id}" (${node.shape})` });
            applied++;
            break;
          }
          case "updateNode": {
            const target = this.graph.nodes.find((n) => n.id === op.id);
            if (!target) throw new Error(`node "${op.id}" not found`);
            Object.assign(target, op.patch);
            diff.push({ op: op.op, detail: `updated node "${op.id}"` });
            applied++;
            break;
          }
          case "deleteNode": {
            const idx = this.graph.nodes.findIndex((n) => n.id === op.id);
            if (idx < 0) throw new Error(`node "${op.id}" not found`);
            this.graph.nodes.splice(idx, 1);
            this.graph.edges = this.graph.edges.filter((e) => e.from !== op.id && e.to !== op.id);
            diff.push({ op: op.op, detail: `deleted node "${op.id}"` });
            applied++;
            break;
          }
          case "addEdge": {
            const id = op.edge.id ?? this.nextId("e");
            if (this.graph.edges.some((e) => e.id === id)) throw new Error(`duplicate edge id "${id}"`);
            if (!this.graph.nodes.some((n) => n.id === op.edge.from)) {
              throw new Error(`edge source node "${op.edge.from}" not found`);
            }
            if (!this.graph.nodes.some((n) => n.id === op.edge.to)) {
              throw new Error(`edge target node "${op.edge.to}" not found`);
            }
            this.graph.edges.push({ ...op.edge, id });
            diff.push({ op: op.op, detail: `added edge "${id}" (${op.edge.from} -> ${op.edge.to})` });
            applied++;
            break;
          }
          case "updateEdge": {
            const target = this.graph.edges.find((e) => e.id === op.id);
            if (!target) throw new Error(`edge "${op.id}" not found`);
            Object.assign(target, op.patch);
            diff.push({ op: op.op, detail: `updated edge "${op.id}"` });
            applied++;
            break;
          }
          case "deleteEdge": {
            const idx = this.graph.edges.findIndex((e) => e.id === op.id);
            if (idx < 0) throw new Error(`edge "${op.id}" not found`);
            this.graph.edges.splice(idx, 1);
            diff.push({ op: op.op, detail: `deleted edge "${op.id}"` });
            applied++;
            break;
          }
          case "addMindTopic": {
            const list = (this.graph.mind ??= []);
            const id = op.topic.id ?? this.nextId("m");
            if (list.some((m) => m.id === id)) throw new Error(`duplicate mind topic id "${id}"`);
            if (op.topic.parent !== null && !list.some((m) => m.id === op.topic.parent)) {
              throw new Error(`parent mind topic "${op.topic.parent}" not found`);
            }
            const siblings = list.filter((m) => m.parent === op.topic.parent);
            const topic: MindTopic = {
              id,
              parent: op.topic.parent,
              order: op.topic.order ?? siblings.length,
              text: op.topic.text,
              ...(op.topic.parent === null ? { x: op.topic.x ?? 120, y: op.topic.y ?? 120 } : {}),
            };
            list.push(topic);
            diff.push({ op: op.op, detail: `added mind topic "${id}"` });
            applied++;
            break;
          }
          case "updateMindTopic": {
            const target = (this.graph.mind ?? []).find((m) => m.id === op.id);
            if (!target) throw new Error(`mind topic "${op.id}" not found`);
            Object.assign(target, op.patch);
            diff.push({ op: op.op, detail: `updated mind topic "${op.id}"` });
            applied++;
            break;
          }
          case "deleteMindTopic": {
            const list = this.graph.mind ?? [];
            if (!list.some((m) => m.id === op.id)) throw new Error(`mind topic "${op.id}" not found`);
            const toDelete = new Set<string>([op.id]);
            let grown = true;
            while (grown) {
              grown = false;
              for (const m of list) {
                if (m.parent && toDelete.has(m.parent) && !toDelete.has(m.id)) {
                  toDelete.add(m.id);
                  grown = true;
                }
              }
            }
            this.graph.mind = list.filter((m) => !toDelete.has(m.id));
            diff.push({ op: op.op, detail: `deleted mind subtree "${op.id}" (${toDelete.size} topics)` });
            applied++;
            break;
          }
          case "addStroke": {
            const id = op.stroke.id ?? this.nextId("s");
            const list = (this.graph.strokes ??= []);
            list.push({ ...op.stroke, id });
            diff.push({ op: op.op, detail: `added stroke "${id}"` });
            applied++;
            break;
          }
          case "deleteStroke": {
            const list = this.graph.strokes ?? [];
            const idx = list.findIndex((s) => s.id === op.id);
            if (idx < 0) throw new Error(`stroke "${op.id}" not found`);
            list.splice(idx, 1);
            diff.push({ op: op.op, detail: `deleted stroke "${op.id}"` });
            applied++;
            break;
          }
          case "autoLayout": {
            this.graph = autoLayout(this.graph, {
              direction: op.direction,
              gapX: op.gapX,
              gapY: op.gapY,
            });
            diff.push({ op: op.op, detail: `auto-layout (${op.direction ?? "TB"})` });
            applied++;
            break;
          }
          case "setTheme": {
            this.graph.theme = themeOf(op.theme).id;
            diff.push({ op: op.op, detail: `theme set to "${this.graph.theme}"` });
            applied++;
            break;
          }
        }
      } catch (err) {
        errors.push(`op[${i}] (${op.op}): ${err instanceof Error ? err.message : String(err)}`);
        if (atomic) break;
      }
    }

    if (dryRun || (errors.length > 0 && atomic)) {
      this.graph = before;
      return {
        ok: errors.length === 0,
        applied: errors.length > 0 && atomic ? 0 : applied,
        undoToken: null,
        diff: errors.length > 0 && atomic ? [] : diff,
        warnings,
        errors,
      };
    }

    const undoToken = applied > 0 ? this.pushUndo(before) : null;
    return { ok: errors.length === 0, applied, undoToken, diff, warnings, errors };
  }

  /** Structural & geometric diagnostics for AI verification loops. */
  verify(): BoardDiagnostic[] {
    const diagnostics: BoardDiagnostic[] = [];
    const totalEntities =
      this.graph.nodes.length + (this.graph.mind?.length ?? 0) + (this.graph.strokes?.length ?? 0);
    if (totalEntities === 0) {
      diagnostics.push({
        code: "EMPTY_BOARD",
        severity: "warning",
        message: "Board has no nodes, mind map topics, or strokes.",
        suggestion: "Add flowchart nodes or mind map topics before exporting.",
      });
      return diagnostics;
    }

    const nodeIds = new Set(this.graph.nodes.map((n) => n.id));
    const degree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const e of this.graph.edges) {
      if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
        diagnostics.push({
          code: "DANGLING_EDGE",
          severity: "error",
          entityId: e.id,
          message: `Edge "${e.id}" references missing node (${e.from} -> ${e.to}).`,
          suggestion: "Delete the dangling edge or create the missing endpoint node.",
        });
        continue;
      }
      if (e.from === e.to) {
        diagnostics.push({
          code: "SELF_LOOP",
          severity: "warning",
          entityId: e.id,
          message: `Edge "${e.id}" connects node "${e.from}" to itself.`,
          suggestion: "Verify whether the self-loop is intentional.",
        });
      }
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
      const list = adj.get(e.from) ?? [];
      list.push(e.to);
      adj.set(e.from, list);
    }

    if (this.graph.nodes.length >= 2 && this.graph.edges.length > 0) {
      for (const n of this.graph.nodes) {
        if ((degree.get(n.id) ?? 0) === 0 && !isContainer(n.shape) && n.shape !== "text" && n.shape !== "note") {
          diagnostics.push({
            code: "ISOLATED_NODE",
            severity: "info",
            entityId: n.id,
            message: `Node "${n.id}" ("${n.text}") is disconnected from the flowchart.`,
            suggestion: "Connect it with an edge or remove it if unused.",
          });
        }
      }
    }

    // Overlap check among non-container nodes
    const solid = this.graph.nodes.filter((n) => !isContainer(n.shape));
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) {
        const a = solid[i];
        const b = solid[j];
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const inter = ix * iy;
        const minArea = Math.min(a.w * a.h, b.w * b.h);
        if (inter > 0 && minArea > 0 && inter / minArea > 0.2) {
          diagnostics.push({
            code: "OVERLAPPING_NODES",
            severity: "warning",
            entityId: b.id,
            message: `Nodes "${a.id}" and "${b.id}" overlap visually.`,
            suggestion: "Run autoLayout() or reposition one of the nodes.",
          });
        }
      }
    }

    // Cycle detection (3-color DFS)
    const color = new Map<string, number>();
    let cycleFound = false;
    const dfs = (u: string) => {
      color.set(u, 1);
      for (const v of adj.get(u) ?? []) {
        if (v === u) continue;
        if (color.get(v) === 1) {
          cycleFound = true;
        } else if (!color.get(v)) {
          dfs(v);
        }
      }
      color.set(u, 2);
    };
    for (const n of this.graph.nodes) {
      if (!color.get(n.id)) dfs(n.id);
    }
    if (cycleFound) {
      diagnostics.push({
        code: "CYCLE_DETECTED",
        severity: "info",
        message: "Flowchart contains a directed cycle.",
        suggestion: "Confirm feedback loop edges are intentional and labeled clearly.",
      });
    }

    // Mindmap orphan check
    const mindIds = new Set((this.graph.mind ?? []).map((m) => m.id));
    for (const m of this.graph.mind ?? []) {
      if (m.parent !== null && !mindIds.has(m.parent)) {
        diagnostics.push({
          code: "ORPHAN_MIND_TOPIC",
          severity: "error",
          entityId: m.id,
          message: `Mind map topic "${m.id}" references missing parent "${m.parent}".`,
          suggestion: "Re-parent the topic to an existing root or delete it.",
        });
      }
    }

    return diagnostics;
  }

  toMermaid(): string {
    return toMermaid(this.graph);
  }

  toSvg(options?: BoardSvgOptions): string {
    return renderBoardToSvg(this.graph, options);
  }

  toXmind(options?: XmindExportOptions): Uint8Array {
    return exportMindMapToXmind(this.graph, options);
  }

  async toXmindAsync(options?: XmindExportOptions): Promise<Uint8Array> {
    return exportMindMapToXmindAsync(this.graph, options);
  }
}
