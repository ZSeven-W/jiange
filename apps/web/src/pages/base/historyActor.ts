import type { RecordHistoryEntry, User } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Display name for a history entry's actor, or "" when unknown (legacy events). */
export function historyActorName(e: RecordHistoryEntry, members: User[]): string {
  if (e.actor?.kind === "form") return t("表单提交");
  const id = e.actor?.id ?? (e.op === "add" ? e.by : undefined);
  if (!id) return "";
  return e.actor?.name || members.find((m) => m.id === id)?.name || t("已移除的成员");
}

/** Feishu-style headline: 「Kay 修改了记录」, 「表单提交 创建了记录」. */
export function historyHeadline(e: RecordHistoryEntry, members: User[]): string {
  const name = historyActorName(e, members);
  const verb = e.op === "add" ? t("创建了记录") : t("修改了记录");
  return name ? `${name} ${verb}` : verb;
}
