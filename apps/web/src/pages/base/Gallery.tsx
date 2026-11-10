import { baseApi, type BaseRecord, type Field, type User } from "@/lib/api";
import { t, useI18n } from "@/lib/i18n";
import { CellView } from "./cells";
import { displayValue, isAttachmentArray, recordTitle, recordTitleField, REGISTRY } from "./registry";
import { Image as ImageIcon } from "lucide-react";

/** Gallery (画册) view: card grid; first image attachment is the cover. */
export function Gallery({
  baseId,
  canEdit,
  fields,
  records,
  members,
  onMutate,
  onOpen,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  onMutate: () => void;
  onOpen: (r: BaseRecord) => void;
}) {
  const title = recordTitleField(fields);
  const extra = fields.filter((f) => f.id !== title?.id && f.type !== "attachment").slice(0, 3);
  const coverField = fields.find((f) => f.type === "attachment");

  const coverOf = (r: BaseRecord): { url: string; name: string } | null => {
    if (!coverField) return null;
    const v = r.cells[coverField.id];
    if (!isAttachmentArray(v)) return null;
    for (const a of v) if (a.mime.startsWith("image/")) return { url: `/api/files/${a.id}`, name: a.name };
    return null;
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-gallery>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {records.map((r) => {
          const cover = coverOf(r);
          const title = recordTitle(r, fields, members) || t("未命名");
          return (
            <div key={r.id} className="group cursor-pointer overflow-hidden rounded-lg border bg-surface transition-shadow hover:shadow-md" onClick={() => onOpen(r)} data-card={r.id}>
              <div className="grid h-32 place-items-center bg-sidebar text-[26px] font-semibold text-subtle" style={cover ? { padding: 0 } : undefined}>
                {cover ? <img src={cover.url} alt={cover.name} className="size-full object-cover" /> : <ImageIcon size={24} strokeWidth={1.3} className="text-subtle/60" />}
              </div>
              <div className="space-y-1 p-2.5 text-[13px]">
                <div className="truncate font-medium">{title}</div>
                {extra.map((f) => (
                  <div key={f.id} className="truncate text-[12px] text-muted-foreground">
                    <CellView field={f} record={r} members={members} canEdit={false} />
                  </div>
                ))}
              </div>
              {canEdit && (
                <button
                  className="w-full border-t py-1.5 text-[12px] text-subtle opacity-0 transition-opacity hover:bg-hover hover:text-destructive group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    baseApi.deleteRecord(baseId, r.id).then(onMutate);
                  }}
                >
                  {t("删除")}
                </button>
              )}
            </div>
          );
        })}
        {records.length === 0 && <p className="col-span-full py-12 text-center text-[13px] text-subtle">{t("暂无记录")}</p>}
      </div>
    </div>
  );
}

export const _galleryUsesRegistry = REGISTRY;
