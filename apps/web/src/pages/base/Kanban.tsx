import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { ask, askText } from "@/components/ui/ask";
import { deleteOption, moveOption, recolorOption, renameOption, type OptionPatch } from "./optionOps";
import { baseApi, type BaseRecord, type Cell, type Field, type User } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CellView, Tag } from "./cells";
import { displayValue, isAttachmentArray, optionColor, PALETTE, recordTitle, recordTitleField, REGISTRY } from "./registry";

const isBlankCell = (v: Cell | undefined) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export interface KanbanColumn {
  /** option value; "" is the ungrouped bucket */
  key: string;
  records: BaseRecord[];
}

/** Group records by a select field; unknown/empty values land in 未分类 (first column). */
export function groupRecords(records: BaseRecord[], field: Field): KanbanColumn[] {
  // Feishu lists the 未分类 bucket first, then one column per option.
  const cols: KanbanColumn[] = [{ key: "", records: [] }, ...(field.options ?? []).map((o) => ({ key: o, records: [] }))];
  for (const r of records) {
    const v = r.cells[field.id];
    const key = typeof v === "string" && (field.options ?? []).includes(v) ? v : "";
    const col = cols.find((c) => c.key === key);
    if (col) col.records.push(r);
  }
  for (const c of cols) c.records.sort((a, b) => a.position - b.position);
  return cols;
}

/** Kanban view: one column per option of the group field; dragging a card
 * between columns rewrites the cell, dragging within a column repositions. */
export function Kanban({
  baseId,
  canEdit,
  fields,
  records,
  members,
  groupFieldId,
  cardFields,
  coverField,
  onMutate,
}: {
  baseId: number;
  canEdit: boolean;
  fields: Field[];
  records: BaseRecord[];
  members: User[];
  groupFieldId?: number;
  /** 卡片配置: fields shown on cards (undefined = first two editable fields). */
  cardFields?: number[];
  /** 卡片配置: attachment field used as the card cover. */
  coverField?: number | null;
  onMutate: () => void;
}) {
  const [colDrag, setColDrag] = useState<string | null>(null);
  const [colOver, setColOver] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const groupFields = fields.filter((f) => f.type === "select");
  const [drag, setDrag] = useState<{ rid: number } | null>(null);
  const [over, setOver] = useState<{ col: string; index: number } | null>(null);

  const field = groupFields.find((f) => f.id === groupFieldId) ?? groupFields[0];
  if (!field) {
    return (
      <div className="grid flex-1 place-items-center text-[14px] text-muted-foreground">
        <div className="space-y-2 text-center">
          <p>看板需要一个单选字段来分列</p>
          {canEdit && <p className="text-[13px] text-subtle">请先在表格视图中添加一个单选字段</p>}
        </div>
      </div>
    );
  }
  const title = recordTitleField(fields);
  const extra = cardFields
    ? cardFields.map((id) => fields.find((f) => f.id === id)).filter((f): f is Field => !!f && f.id !== title?.id)
    : fields.filter((f) => f.id !== field.id && f.id !== title?.id && !REGISTRY[f.type].readonly).slice(0, 2);
  const cover = coverField ? fields.find((f) => f.id === coverField && f.type === "attachment") : undefined;
  const coverOf = (r: BaseRecord) => {
    if (!cover) return null;
    const v = r.cells[cover.id];
    if (!isAttachmentArray(v)) return null;
    const a = v.find((x) => x.mime.startsWith("image/"));
    return a ? { url: `/api/files/${a.id}`, name: a.name } : null;
  };
  const patchOptions = async (patch: OptionPatch | null) => {
    if (!patch || !canEdit) return;
    setError("");
    try { await baseApi.patchField(baseId, field.id, patch as Partial<Field>); }
    catch { setError("分组修改未能确认，请刷新后核对。"); }
    onMutate();
  };
  const dropColumn = (to: number) => {
    const key = colDrag;
    setColDrag(null);
    setColOver(null);
    if (key) void patchOptions(moveOption(field, key, to));
  };
  const cols = groupRecords(records, field);

  const drop = async (colKey: string, index: number, rid?: number) => {
    setDrag(null);
    setOver(null);
    if (!rid || !canEdit) return;
    const rec = records.find((r) => r.id === rid);
    if (!rec) return;
    // position between neighbors in the target column (or at the ends)
    const col = cols.find((c) => c.key === colKey);
    const others = (col?.records ?? []).filter((r) => r.id !== rid);
    const prev = index > 0 ? others[index - 1].position : (others[0]?.position ?? 0) - 1;
    const next = index < others.length ? others[index].position : (others[others.length - 1]?.position ?? 0) + 1;
    const position = (prev + next) / 2;
    const value: Cell | null = colKey === "" ? null : colKey;
    if (rec.cells[field.id] !== value) await baseApi.setCells(baseId, rid, { [field.id]: value }).catch(() => {});
    if (position !== rec.position) await baseApi.moveRecord(baseId, rid, position).catch(() => {});
    onMutate();
  };

  const addGroup = async () => {
    const name = (await askText("新建分组", "分组名称"))?.trim();
    if (!name || (field.options ?? []).includes(name)) return;
    await baseApi.patchField(baseId, field.id, { options: [...(field.options ?? []), name] }).catch(() => {});
    onMutate();
  };
  const tint = (key: string) => {
    if (!key) return "#F5F6F7";
    const [bg] = optionColor(field, key);
    return `color-mix(in srgb, ${bg} 40%, white)`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
    {error && <p role="alert" className="px-5 py-1 text-[12px] text-destructive">{error}</p>}
    <div className="flex min-h-0 flex-1 items-start gap-2 overflow-x-auto px-5 py-1" data-kanban>
      {cols.map((col, ci) => {
        const optionIndex = (field.options ?? []).indexOf(col.key);
        const [tagBg, tagFg] = col.key ? optionColor(field, col.key) : ["#E4E5E7", "#646A73"];
        return (
        <div
          key={col.key || "__ungrouped"}
          style={{ background: tint(col.key) }}
          className={cn(
            "relative flex max-h-full w-[256px] shrink-0 flex-col rounded-lg",
            over?.col === col.key && over.index === col.records.length && "outline outline-2 outline-primary/50",
            colDrag === col.key && "opacity-50",
            colOver === ci && colDrag && "before:absolute before:-left-[5px] before:inset-y-0 before:w-0.5 before:rounded before:bg-primary",
          )}
          data-kanban-col={col.key}
          onDragOver={(e) => {
            e.preventDefault();
            if (colDrag) { if (col.key) setColOver(ci); return; }
            setOver({ col: col.key, index: col.records.length });
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (colDrag) { if (col.key) dropColumn(optionIndex); return; }
            void drop(col.key, over?.index ?? col.records.length, Number(e.dataTransfer.getData("text/rid")) || undefined);
          }}
        >
          <div
            className={cn("relative flex h-9 shrink-0 items-center gap-2 px-3 text-[13px] text-muted-foreground", canEdit && col.key && "cursor-grab")}
            draggable={canEdit && !!col.key}
            onDragStart={(e) => { e.dataTransfer.setData("text/col", col.key); e.dataTransfer.effectAllowed = "move"; setColDrag(col.key); }}
            onDragEnd={() => { setColDrag(null); setColOver(null); }}
            data-kanban-col-head={col.key}
          >
            {col.key ? <Tag colorIndex={optionIndex} bg={tagBg} fg={tagFg} value={col.key} /> : <span className="rounded bg-[#E4E5E7] px-2 py-0.5 text-[12px] font-medium text-[#646A73]">未分类</span>}
            <span className="text-subtle">{col.records.length}</span>
            {canEdit && col.key ? (
              <button type="button" className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground" aria-label={`分组菜单 ${col.key}`} aria-expanded={menuFor === col.key} onClick={() => setMenuFor((v) => (v === col.key ? null : col.key))} data-kanban-col-menu={col.key}>
                <MoreHorizontal size={16} />
              </button>
            ) : <MoreHorizontal size={16} className="ml-auto text-subtle opacity-40" aria-hidden />}
            {menuFor === col.key && col.key && (
              <ColumnMenu
                field={field}
                option={col.key}
                count={col.records.length}
                onClose={() => setMenuFor(null)}
                onRename={async () => { setMenuFor(null); const name = await askText("重命名分组", "分组名称", col.key); if (name !== null) await patchOptions(renameOption(field, col.key, name)); }}
                onColor={(c) => { setMenuFor(null); void patchOptions(recolorOption(field, col.key, c)); }}
                onDelete={async () => { setMenuFor(null); if (await ask(`删除分组「${col.key}」？`, col.records.length ? `该分组的 ${col.records.length} 张卡片将移到「未分类」。` : undefined)) await patchOptions(deleteOption(field, col.key)); }}
              />
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
            {col.records.map((rec, i) => (
              <div
                key={rec.id}
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/rid", String(rec.id));
                  e.dataTransfer.effectAllowed = "move";
                  setDrag({ rid: rec.id });
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  if (colDrag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const before = e.clientY < e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2;
                  setOver({ col: col.key, index: before ? i : i + 1 });
                }}
                onDrop={(e) => {
                  if (colDrag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  void drop(col.key, over?.index ?? i, Number(e.dataTransfer.getData("text/rid")) || undefined);
                }}
                className={cn(
                  "cursor-grab rounded-md border border-[#DEE0E3] bg-white px-3 py-[11px] text-[14px] hover:shadow-[0_2px_8px_rgba(31,35,41,0.08)]",
                  drag?.rid === rec.id && "opacity-40",
                  over?.col === col.key && over.index === i && "border-t-2 border-t-primary",
                )}
                data-card={rec.id}
              >
                {(() => {
                  const c = coverOf(rec);
                  return c ? <img src={c.url} alt={c.name} className="-mx-3 -mt-[11px] mb-2 block h-28 w-[calc(100%+24px)] max-w-none rounded-t-md object-cover" data-card-cover /> : null;
                })()}
                {(() => {
                  const t = recordTitle(rec, fields, members);
                  return <div className={cn("truncate leading-[22px]", t ? "font-medium" : "text-subtle")}>{t || "未命名记录"}</div>;
                })()}
                {extra.some((f) => !isBlankCell(rec.cells[f.id])) && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[12px] text-muted-foreground">
                    {extra.filter((f) => !isBlankCell(rec.cells[f.id])).map((f) => (
                      <span key={f.id} className="max-w-[120px] truncate">
                        <CellView field={f} record={rec} members={members} canEdit={false} />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {over?.col === col.key && over.index === col.records.length && <div className="h-1.5 rounded bg-primary/40" />}
          </div>
          {canEdit ? (
            <button
              className="mx-2 mb-1.5 mt-1 grid h-8 shrink-0 place-items-center rounded-md text-subtle hover:bg-black/5 hover:text-foreground"
              title="添加卡片"
              aria-label="添加卡片"
              data-kanban-add={col.key}
              onClick={() => baseApi.addRecord(baseId, col.key ? { [field.id]: col.key } : {}).then(onMutate)}
            >
              <Plus size={16} />
            </button>
          ) : (
            <div className="h-2 shrink-0" />
          )}
        </div>
        );
      })}
      {canEdit && (
        <button
          className={cn("flex h-11 shrink-0 items-center gap-1 rounded-md px-3 text-[14px] text-muted-foreground hover:bg-hover", colDrag && colOver === cols.length && "outline outline-2 outline-primary/40")}
          onClick={addGroup}
          onDragOver={(e) => { if (colDrag) { e.preventDefault(); setColOver(cols.length); } }}
          onDrop={(e) => { if (colDrag) { e.preventDefault(); dropColumn((field.options ?? []).length); } }}
          data-kanban-add-group
        >
          <Plus size={16} /> 新建分组
        </button>
      )}
    </div>
    </div>
  );
}

function ColumnMenu({ field, option, count, onClose, onRename, onColor, onDelete }: { field: Field; option: string; count: number; onClose: () => void; onRename: () => void; onColor: (c: number) => void; onDelete: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, [onClose]);
  const current = optionColor(field, option)[0];
  return (
    <div ref={ref} role="menu" aria-label={`分组 ${option}`} className="absolute right-1 top-9 z-30 w-52 rounded-lg border bg-surface p-1 text-[13px] text-foreground shadow-[0_6px_24px_rgba(31,35,41,0.12)]" data-kanban-col-pop>
      <button type="button" role="menuitem" className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover" onClick={onRename} data-col-action="rename"><Pencil size={15} strokeWidth={1.6} className="text-muted-foreground" />重命名</button>
      <div className="px-2 pb-1 pt-1.5 text-[12px] text-subtle">分组颜色</div>
      <div className="grid grid-cols-5 gap-1.5 px-2 pb-2">
        {PALETTE.map(([bg, fg], i) => <button key={i} type="button" aria-label={`颜色 ${i + 1}`} onClick={() => onColor(i)} className={cn("h-6 rounded border", current === bg && "ring-2 ring-primary ring-offset-1")} style={{ background: bg, borderColor: fg + "33" }} data-col-color={i} />)}
      </div>
      <div className="mx-1 my-1 h-px bg-border" role="separator" />
      <button type="button" role="menuitem" className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-destructive hover:bg-hover" onClick={onDelete} data-col-action="delete"><Trash2 size={15} strokeWidth={1.6} />删除分组{count ? <span className="ml-auto text-[12px] text-subtle">{count} 张卡片</span> : null}</button>
    </div>
  );
}
