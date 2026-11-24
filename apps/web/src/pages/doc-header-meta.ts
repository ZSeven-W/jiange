import type { SyncStatus } from "@jiange/collab";
import { t } from "@/lib/i18n";

/** 飞书风格时间：今天 16:19 / 11月8日 09:05 / 2025年3月2日 09:05。 */
export function formatEditTime(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return t("今天 {time}", { time: hm });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t("昨天 {time}", { time: hm });
  return d.getFullYear() === now.getFullYear()
    ? t("{m}月{d}日 {time}", { m: d.getMonth() + 1, d: d.getDate(), time: hm })
    : t("{y}年{m}月{d}日 {time}", { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), time: hm });
}

/** 飞书标题下作者行的修改日期：今天修改 / 昨天修改 / 11月8日修改 / 2025年3月2日修改。 */
export function formatEditDay(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) return t("今天修改");
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t("昨天修改");
  return d.getFullYear() === now.getFullYear()
    ? t("{m}月{d}日修改", { m: d.getMonth() + 1, d: d.getDate() })
    : t("{y}年{m}月{d}日修改", { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
}

/**
 * 顶栏标题下方的一行状态。与飞书一致：打开文档时显示「最近修改：时间」，
 * 本次会话里自己编辑并保存后显示「已经保存到云端」；同步中/离线时显示状态。
 */
export function headerMetaText(status: SyncStatus, savedThisSession: boolean, updatedAt?: string, now?: Date) {
  if (status === "syncing") return t("保存中…");
  if (status === "connecting") return t("连接中…");
  if (status === "offline") return t("离线，恢复后自动同步");
  if (savedThisSession) return t("已经保存到云端");
  const time = updatedAt ? formatEditTime(updatedAt, now) : "";
  return time ? t("最近修改：{time}", { time }) : t("已经保存到云端");
}

/** 只有“已同步之后又进入同步中”才算本次会话的本地保存；首次连接的同步不算。 */
export function nextSavedFlag(prev: { seenSynced: boolean; saved: boolean }, status: SyncStatus) {
  if (status === "synced") return prev.seenSynced ? prev : { ...prev, seenSynced: true };
  if (status === "syncing" && prev.seenSynced && !prev.saved) return { ...prev, saved: true };
  return prev;
}
