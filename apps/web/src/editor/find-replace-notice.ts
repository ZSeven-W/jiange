import type { SyncStatus } from "@zseven-w/collab";

/** The operation was applied locally. This is not a claim about its final
 * value when concurrent collaborators write to the same content. */
export type ReplacementNotice = { count: number; skipped: number; skippedMentions?: number; skippedTitles?: number; historyChanges: number; acknowledged?: boolean };
export type ReplacementSyncState = { status: SyncStatus; caughtUp: boolean; blocked: string | null; unacked: number; droppedOnResync: number };

export function replacementSyncNotice(result: ReplacementNotice, sync: ReplacementSyncState): string {
  const skipped = `${result.skipped ? `，${result.skipped} 处内容已变化并跳过` : ""}${result.skippedTitles ? `，跳过 ${result.skippedTitles} 处标题` : ""}${result.skippedMentions ? `，跳过 ${result.skippedMentions} 处提及内容` : ""}`;
  if (sync.droppedOnResync !== result.historyChanges) return `文档历史已变化，无法确认 ${result.count} 处替换的结果；请检查文档和未同步内容。`;
  if (result.acknowledged || (sync.status === "synced" && sync.caughtUp && !sync.blocked && sync.unacked === 0)) return `${result.count} 处替换操作已同步${skipped}；请检查并发修改后的内容。`;
  if (sync.blocked) return `本地已替换 ${result.count} 处${skipped}；同步受阻，尚未确认保存。`;
  if (sync.status === "offline" || sync.status === "connecting") return `本地已替换 ${result.count} 处${skipped}；连接中断或正在重连，同步结果尚未确认。`;
  return `本地已替换 ${result.count} 处${skipped}；正在同步。`;
}
