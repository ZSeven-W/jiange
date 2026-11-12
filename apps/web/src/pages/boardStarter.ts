import type { MdBlock } from "@/lib/markdown";

/**
 * 「新建画板」：与飞书一致，创建一篇只含一个画板（流程图块）的文档并直接进入画板。
 * 新文档打开后在空文档中插入画板块；标记按用户 + 文档暂存在当前标签页。
 */
const memory = new Set<string>();
const keyFor = (ownerId: number, docId: number) => `jiange:board:${ownerId}:${docId}`;

export const BOARD_TITLE = "未命名画板";
export const BOARD_SEED: MdBlock = { type: "flowchart", text: "", props: { "fc.v": "1", "fc.theme": "feishu", "fc.h": "560" }, spans: [] };

export function stageBoard(ownerId: number, docId: number) {
  const key = keyFor(ownerId, docId);
  memory.add(key);
  try { sessionStorage.setItem(key, "1"); } catch { /* memory fallback */ }
}
export function hasBoard(ownerId: number, docId: number): boolean {
  const key = keyFor(ownerId, docId);
  if (memory.has(key)) return true;
  try { return sessionStorage.getItem(key) === "1"; } catch { return false; }
}
export function takeBoard(ownerId: number, docId: number) {
  const key = keyFor(ownerId, docId);
  memory.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}
