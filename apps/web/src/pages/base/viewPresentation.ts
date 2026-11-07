/** The latest modification we can substantiate from the current Base snapshot. */
export function lastBaseChange(meta: string, records: readonly { updatedAt?: string }[]): string | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of [meta, ...records.map((record) => record.updatedAt)]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

export function formatBaseChange(value: string | null, now = new Date()): string {
  if (!value) return "修改时间未知";
  const date = new Date(value);
  const elapsed = now.getTime() - date.getTime();
  if (!Number.isFinite(date.getTime())) return "修改时间未知";
  if (elapsed >= 0 && elapsed < 60_000) return "刚刚";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
}
