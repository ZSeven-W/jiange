import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Folder, Link2, Search, X } from "lucide-react";
import { ApiError, docsApi, wikiApi, type DocMeta, type WikiNodeEntry } from "@/lib/api";
import { BaseColorIcon, DocColorIcon, SheetColorIcon, SlidesColorIcon, WhiteboardIcon } from "@/components/feishu-icons";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function TargetGlyph({ kind, docType }: { kind: string; docType?: string }) {
  if (kind === "folder") return <Folder size={15} fill="#ffcc4d" stroke="#f5a623" className="shrink-0" />;
  if (kind === "sheet") return <SheetColorIcon className="size-4 shrink-0" />;
  if (kind === "base") return <BaseColorIcon className="size-4 shrink-0" />;
  if (kind === "slides") return <SlidesColorIcon className="size-4 shrink-0" />;
  if (kind === "doc" && docType === "board") return <WhiteboardIcon className="size-4 shrink-0 text-[#34c759]" />;
  return <DocColorIcon className="size-4 shrink-0" />;
}

export function WikiShortcutDialog({
  spaceId,
  workspaceId,
  userId,
  nodes,
  initialParentId = null,
  onClose,
  onCreated,
}: {
  spaceId: number;
  workspaceId: number;
  userId: number;
  nodes: WikiNodeEntry[];
  initialParentId?: number | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [sourceTab, setSourceTab] = useState<"wiki" | "drive">("wiki");
  const [selectedSourceSpaceId, setSelectedSourceSpaceId] = useState<number>(0);
  const [parentId, setParentId] = useState<number | null>(initialParentId);
  const [selectedTarget, setSelectedTarget] = useState<{ id: number; title: string } | null>(null);
  const [customTitle, setCustomTitle] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const spacesQuery = useQuery({
    queryKey: ["wiki-spaces", workspaceId, userId],
    queryFn: () => wikiApi.listSpaces(workspaceId, userId),
  });

  const otherSpaces = useMemo(
    () => (spacesQuery.data ?? []).filter((s) => s.id !== spaceId),
    [spacesQuery.data, spaceId],
  );
  const effectiveSourceSpaceId = selectedSourceSpaceId || otherSpaces[0]?.id || 0;

  const sourceSpaceDetail = useQuery({
    queryKey: ["wiki-space", effectiveSourceSpaceId, userId],
    queryFn: () => wikiApi.getSpace(effectiveSourceSpaceId, userId),
    enabled: sourceTab === "wiki" && effectiveSourceSpaceId > 0,
  });

  const driveDocsQuery = useQuery({
    queryKey: ["wiki-shortcut-drive-docs", userId],
    queryFn: () => docsApi.list(),
    enabled: sourceTab === "drive",
  });

  const editableParents = useMemo(
    () => nodes.filter((n) => n.role === "edit" || n.role === "manage"),
    [nodes],
  );

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (sourceTab === "wiki") {
      const list = sourceSpaceDetail.data?.nodes ?? [];
      return list
        .filter((n) => !q || n.title.toLowerCase().includes(q))
        .map((n) => ({
          id: n.id,
          title: n.title || t("未命名文档"),
          kind: n.kind,
          docType: n.docType,
          subtitle: sourceSpaceDetail.data?.space.name ?? "",
        }));
    }
    const list: DocMeta[] = (driveDocsQuery.data ?? []).filter((d) => !d.wikiSpaceId);
    return list
      .filter((d) => !q || (d.title || "").toLowerCase().includes(q))
      .map((d) => ({
        id: d.id,
        title: d.title || t("未命名文档"),
        kind: d.kind ?? "doc",
        docType: d.docType,
        subtitle: t("云盘"),
      }));
  }, [sourceTab, sourceSpaceDetail.data, driveDocsQuery.data, search, t]);

  const submit = async () => {
    if (busy || !selectedTarget) return;
    setBusy(true);
    setError("");
    try {
      await wikiApi.createShortcut(spaceId, userId, {
        parentId,
        targetNodeId: selectedTarget.id,
        title: customTitle.trim() || undefined,
      });
      await qc.invalidateQueries({ queryKey: ["wiki-space", spaceId, userId] });
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("添加快捷方式失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={t("添加快捷方式")}>
      <div className="w-full max-w-lg rounded-xl border bg-surface p-5 shadow-xl" data-wiki-shortcut-dialog>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold">
            <Link2 size={17} className="text-primary" />
            {t("添加快捷方式（跨库 / 云盘）")}
          </h2>
          <button type="button" onClick={onClose} aria-label={t("关闭")} className="rounded p-1 text-subtle hover:bg-hover">
            <X size={16} />
          </button>
        </div>
        <p className="mt-1 text-[12px] text-subtle">
          {t("在不复制原文件的前提下引用其他知识库页面或云盘文档；目标权限实时校验，无权访问时自动隐藏原内容。")}
        </p>

        <div className="mt-3 flex gap-1.5">
          <button
            type="button"
            data-wiki-shortcut-tab="wiki"
            onClick={() => { setSourceTab("wiki"); setSelectedTarget(null); }}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors",
              sourceTab === "wiki" ? "bg-primary text-white" : "border bg-surface text-foreground hover:bg-hover",
            )}
          >
            <BookOpen size={14} />{t("其他知识库")}
          </button>
          <button
            type="button"
            data-wiki-shortcut-tab="drive"
            onClick={() => { setSourceTab("drive"); setSelectedTarget(null); }}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors",
              sourceTab === "drive" ? "bg-primary text-white" : "border bg-surface text-foreground hover:bg-hover",
            )}
          >
            <Folder size={14} />{t("云盘与文档")}
          </button>
        </div>

        <div className="mt-3 space-y-3">
          {sourceTab === "wiki" && (
            <div>
              <label className="mb-1 block text-[12px] font-medium text-muted-foreground" htmlFor="wiki-shortcut-source-space">
                {t("来源知识库")}
              </label>
              {otherSpaces.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-[12px] text-subtle">
                  {t("当前工作区暂无其他可访问的知识库，可切换到「云盘与文档」引用云盘文件。")}
                </p>
              ) : (
                <select
                  id="wiki-shortcut-source-space"
                  value={effectiveSourceSpaceId}
                  onChange={(e) => { setSelectedSourceSpaceId(Number(e.target.value)); setSelectedTarget(null); }}
                  data-wiki-shortcut-space-select
                  className="h-9 w-full rounded-md border bg-surface px-3 text-[13px]"
                >
                  {otherSpaces.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("搜索页面或文档名称…")}
              data-wiki-shortcut-search
              className="h-9 w-full rounded-md border bg-surface pl-8 pr-3 text-[13px] outline-none focus:border-primary"
            />
          </div>

          <div className="max-h-48 overflow-y-auto rounded-lg border bg-surface">
            {(sourceTab === "wiki" ? sourceSpaceDetail.isPending : driveDocsQuery.isPending) ? (
              <p className="py-6 text-center text-[12px] text-subtle">{t("正在加载可引用内容…")}</p>
            ) : candidates.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-subtle">{t("暂无匹配的可引用页面或文档")}</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {candidates.map((item) => {
                  const chosen = selectedTarget?.id === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        data-wiki-shortcut-option={item.id}
                        onClick={() => setSelectedTarget({ id: item.id, title: item.title })}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors",
                          chosen ? "bg-primary/10 font-medium text-primary" : "hover:bg-hover",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <TargetGlyph kind={item.kind} docType={item.docType} />
                          <span className="truncate">{item.title}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-subtle">{item.subtitle}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-muted-foreground" htmlFor="wiki-shortcut-parent">
                {t("放置位置")}
              </label>
              <select
                id="wiki-shortcut-parent"
                value={parentId ?? ""}
                onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}
                data-wiki-shortcut-parent
                className="h-9 w-full rounded-md border bg-surface px-2.5 text-[13px]"
              >
                <option value="">{t("知识库根目录")}</option>
                {editableParents.map((n) => (
                  <option key={n.id} value={n.id}>{n.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-muted-foreground" htmlFor="wiki-shortcut-alias">
                {t("显示名称（可选）")}
              </label>
              <input
                id="wiki-shortcut-alias"
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder={selectedTarget?.title || t("默认使用原名称")}
                maxLength={100}
                data-wiki-shortcut-title
                className="h-9 w-full rounded-md border bg-surface px-2.5 text-[13px] outline-none focus:border-primary"
              />
            </div>
          </div>

          {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-md border px-4 text-[13px] hover:bg-hover">
            {t("取消")}
          </button>
          <button
            type="button"
            disabled={busy || !selectedTarget}
            onClick={() => void submit()}
            data-wiki-shortcut-submit
            className="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? t("添加中…") : t("添加快捷方式")}
          </button>
        </div>
      </div>
    </div>
  );
}
