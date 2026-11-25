import { idKey, type Op } from "@zseven-w/collab";
import { useI18n } from "@/lib/i18n";

/** Only locally generated insertion text is shown; structural edits stay in the full backup. */
export function draftTextPreview(ops: readonly Op[], limit = 10000): { text: string; omitted: boolean; other: number } {
  let text = "", block = "", omitted = false, other = 0, count = 0;
  for (const op of ops) {
    if (op.t !== "tins") { other++; continue; }
    const next = idKey(op.block);
    if (text && next !== block && count < limit) { text += "\n"; count++; }
    block = next;
    for (const char of op.text) {
      if (count >= limit) { omitted = true; break; }
      text += char; count++;
    }
  }
  return { text, omitted, other };
}

export function PendingDraftPreview({ ops, onClose, onDownload }: { ops: readonly Op[]; onClose: () => void; onDownload: () => void }) {
  const { t } = useI18n();
  const preview = draftTextPreview(ops);
  return <section className="border-b bg-[#FFF9E8] px-5 py-4 text-[13px] text-foreground dark:bg-surface" aria-label={t("本地草稿预览")} data-pending-draft-preview>
    <div className="flex items-center gap-3"><h2 className="font-medium">{t("本地草稿中的新增文字")}</h2><button type="button" className="ml-auto text-primary" onClick={onClose}>{t("收起")}</button></div>
    <p className="mt-1 leading-5 text-muted-foreground">{t("文字按本地操作顺序展示，不代表最终排版。删除、格式和表格等操作请查看完整备份。")}</p>
    {preview.text ? <textarea readOnly aria-label={t("本地草稿新增文字")} className="mt-3 h-28 w-full resize-y rounded-md border bg-surface p-2 leading-5 outline-none focus:border-primary" value={preview.text} /> : <p className="mt-3 text-muted-foreground">{t("没有可预览的新增文字，草稿可能包含删除或其他操作。")}</p>}
    {preview.omitted && <p className="mt-1 text-muted-foreground">{t("预览较长，已截断；完整内容仍在备份中。")}</p>}
    <button type="button" className="mt-2 text-primary hover:underline" onClick={onDownload}>{t("下载完整备份")}</button>
  </section>;
}
