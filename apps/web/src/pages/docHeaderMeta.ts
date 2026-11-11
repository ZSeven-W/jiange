import type { SyncStatus } from "@jiange/collab";

/** 飞书风格时间：今天 16:19 / 11月8日 09:05 / 2025年3月2日 09:05。 */
export function formatEditTime(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 飞书标题下作者行的修改日期：今天修改 / 昨天修改 / 11月8日修改 / 2025年3月2日修改。 */
export function formatEditDay(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) return "今天修改";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "昨天修改";
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日修改` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日修改`;
}

/**
 * 顶栏标题下方的一行状态。与飞书一致：打开文档时显示「最近修改：时间」，
 * 本次会话里自己编辑并保存后显示「已经保存到云端」；同步中/离线时显示状态。
 */
export function headerMetaText(status: SyncStatus, savedThisSession: boolean, updatedAt?: string, now?: Date) {
  if (status === "syncing") return "保存中…";
  if (status === "connecting") return "连接中…";
  if (status === "offline") return "离线，恢复后自动同步";
  if (savedThisSession) return "已经保存到云端";
  const t = updatedAt ? formatEditTime(updatedAt, now) : "";
  return t ? `最近修改：${t}` : "已经保存到云端";
}

/** 只有“已同步之后又进入同步中”才算本次会话的本地保存；首次连接的同步不算。 */
export function nextSavedFlag(prev: { seenSynced: boolean; saved: boolean }, status: SyncStatus) {
  if (status === "synced") return prev.seenSynced ? prev : { ...prev, seenSynced: true };
  if (status === "syncing" && prev.seenSynced && !prev.saved) return { ...prev, saved: true };
  return prev;
}
