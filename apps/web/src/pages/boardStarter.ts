import type { MdBlock } from "@/lib/markdown";

/**
 * 「新建画板」：与飞书一致，创建一篇只含一个画板（流程图块）的文档并直接进入画板。
 * 新文档打开后在空文档中插入画板块；标记按用户 + 文档暂存在当前标签页。
 */
export type BoardStarterKind = "board" | "mindmap";
const memory = new Map<string, BoardStarterKind>();
const keyFor = (ownerId: number, docId: number) => `jiange:board:${ownerId}:${docId}`;

export const BOARD_TITLE = "未命名画板";
export const BOARD_SEED: MdBlock = { type: "flowchart", text: "", props: { "fc.v": "1", "fc.theme": "feishu", "fc.h": "560" }, spans: [] };

export const MINDMAP_TITLE = "未命名思维导图";
export const MINDMAP_SEED: MdBlock = { type: "flowchart", text: "", props: {
  "fc.v": "1", "fc.theme": "feishu", "fc.h": "560",
  "fc.m.root": JSON.stringify({ parent: null, order: 0, text: "", x: 0, y: 0 }),
  ...Object.fromEntries([0, 1, 2].map((order) => [`fc.m.child${order}`, JSON.stringify({ parent: "root", order, text: "" })])),
}, spans: [] };

export function stageBoard(ownerId: number, docId: number, kind: BoardStarterKind = "board") {
  const key = keyFor(ownerId, docId);
  memory.set(key, kind);
  try { sessionStorage.setItem(key, kind); } catch { /* memory fallback */ }
}
export function peekBoardKind(ownerId: number, docId: number): BoardStarterKind | null {
  const key = keyFor(ownerId, docId), cached = memory.get(key);
  if (cached) return cached;
  try { const value = sessionStorage.getItem(key); return value === "mindmap" ? "mindmap" : value === "board" || value === "1" ? "board" : null; } catch { return null; }
}
export function hasBoard(ownerId: number, docId: number): boolean {
  return peekBoardKind(ownerId, docId) !== null;
}
export function takeBoard(ownerId: number, docId: number) {
  const key = keyFor(ownerId, docId);
  memory.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}
