import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderInput, Import, X } from "lucide-react";
import { ApiError, driveApi, wikiApi, type DriveEntry, type WikiNodeEntry } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export function WikiMoveNodeDialog({
  node,
  workspaceId,
  userId,
  onClose,
  onMoved,
}: {
  node: WikiNodeEntry;
  workspaceId: number;
  userId: number;
  onClose: () => void;
  onMoved: (moved: WikiNodeEntry) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [targetSpaceId, setTargetSpaceId] = useState<number>(node.wikiSpaceId);
  const [targetParentId, setTargetParentId] = useState<number | null>(node.parentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const spacesQuery = useQuery({
    queryKey: ["wiki-spaces", workspaceId, userId],
    queryFn: () => wikiApi.listSpaces(workspaceId, userId),
  });
  const targetDetailQuery = useQuery({
    queryKey: ["wiki-space", targetSpaceId, userId],
    queryFn: () => wikiApi.getSpace(targetSpaceId, userId),
    enabled: targetSpaceId > 0,
  });

  const editableSpaces = useMemo(
    () => (spacesQuery.data ?? []).filter((s) => s.callerRole === "edit" || s.callerRole === "manage"),
    [spacesQuery.data],
  );

  // Exclude self and descendants when moving inside the same space.
  const forbiddenIds = useMemo(() => {
    const out = new Set<number>([node.id]);
    const list = targetDetailQuery.data?.nodes ?? [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of list) {
        if (n.parentId && out.has(n.parentId) && !out.has(n.id)) {
          out.add(n.id);
          changed = true;
        }
      }
    }
    return out;
  }, [node.id, targetDetailQuery.data?.nodes]);

  const parentChoices = useMemo(() => {
    const list = targetDetailQuery.data?.nodes ?? [];
    return list.filter((n) => {
      if (forbiddenIds.has(n.id)) return false;
      if (n.role !== "edit" && n.role !== "manage") return false;
      if (node.kind === "folder" && n.kind !== "folder") return false;
      return true;
    });
  }, [targetDetailQuery.data?.nodes, forbiddenIds, node.kind]);

  const submit = async () => {
    if (busy || targetSpaceId <= 0) return;
    setBusy(true);
    setError("");
    try {
      const moved = await wikiApi.moveNode(node.id, userId, {
        targetSpaceId,
        targetParentId,
        expectedRevision: node.revision,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["wiki-space", node.wikiSpaceId, userId] }),
        qc.invalidateQueries({ queryKey: ["wiki-space", targetSpaceId, userId] }),
        qc.invalidateQueries({ queryKey: ["wiki-spaces"] }),
        qc.invalidateQueries({ queryKey: ["docs"] }),
      ]);
      onMoved(moved);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("移动失败，请刷新后重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={t("移动或跨库迁移")}>
      <div className="w-full max-w-md rounded-xl border bg-surface p-5 shadow-xl" data-wiki-move-dialog>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold"><FolderInput size={17} />{t("移动 / 跨库迁移")}</h2>
          <button type="button" onClick={onClose} aria-label={t("关闭")} className="rounded p-1 text-subtle hover:bg-hover"><X size={16} /></button>
        </div>
        <p className="mt-1 text-[12px] text-subtle">{t("当前页面：{title}", { title: node.title })}</p>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-[13px] font-medium" htmlFor="wiki-move-space">{t("目标知识库")}</label>
            <select
              id="wiki-move-space"
              value={targetSpaceId}
              onChange={(e) => {
                setTargetSpaceId(Number(e.target.value));
                setTargetParentId(null);
              }}
              className="h-9 w-full rounded-md border bg-surface px-3 text-[13px]"
            >
              {editableSpaces.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[13px] font-medium" htmlFor="wiki-move-parent">{t("目标父级位置")}</label>
            <select
              id="wiki-move-parent"
              value={targetParentId ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                setTargetParentId(v > 0 ? v : null);
              }}
              className="h-9 w-full rounded-md border bg-surface px-3 text-[13px]"
            >
              <option value={0}>{t("知识库根目录")}</option>
              {parentChoices.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </div>
          {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="h-9 rounded-md border px-3.5 text-[13px] hover:bg-hover">{t("取消")}</button>
            <button type="button" disabled={busy} onClick={() => void submit()} className="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white disabled:opacity-50">
              {busy ? t("移动中…") : t("确定移动")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WikiImportDriveDialog({
  spaceId,
  nodes,
  userId,
  onClose,
  onImported,
}: {
  spaceId: number;
  nodes: WikiNodeEntry[];
  userId: number;
  onClose: () => void;
  onImported: (imported: WikiNodeEntry) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [scope, setScope] = useState<"shared" | "personal">("shared");
  const [selectedId, setSelectedId] = useState<number>(0);
  const [targetParentId, setTargetParentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const driveQuery = useQuery({
    queryKey: ["wiki-import-drive", scope, userId],
    queryFn: () => driveApi.children(null, scope === "personal"),
  });

  const candidates = useMemo(
    () => (driveQuery.data ?? []).filter((d: DriveEntry) => d.kind !== "file" && d.role === "manage"),
    [driveQuery.data],
  );
  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0] ?? null;

  const parentChoices = useMemo(
    () => nodes.filter((n) => (n.role === "edit" || n.role === "manage") && (selected?.kind !== "folder" || n.kind === "folder")),
    [nodes, selected?.kind],
  );

  const submit = async () => {
    if (busy || !selected) return;
    setBusy(true);
    setError("");
    try {
      const imported = await wikiApi.importFromDrive(spaceId, userId, {
        nodeId: selected.id,
        targetParentId,
        expectedRevision: selected.revision,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["wiki-space", spaceId, userId] }),
        qc.invalidateQueries({ queryKey: ["wiki-spaces"] }),
        qc.invalidateQueries({ queryKey: ["drive"] }),
        qc.invalidateQueries({ queryKey: ["drive-nav"] }),
        qc.invalidateQueries({ queryKey: ["docs"] }),
      ]);
      onImported(imported);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("迁入失败，请确认对该内容及子项拥有管理权限"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={t("从云盘迁入知识库")}>
      <div className="w-full max-w-md rounded-xl border bg-surface p-5 shadow-xl" data-wiki-import-dialog>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold"><Import size={17} />{t("从云盘迁入知识库")}</h2>
          <button type="button" onClick={onClose} aria-label={t("关闭")} className="rounded p-1 text-subtle hover:bg-hover"><X size={16} /></button>
        </div>
        <p className="mt-1 text-[12px] text-subtle">{t("迁入后将从云盘目录移入当前知识库，并遵循本知识库的权限设置。")}</p>

        <div className="mt-4 space-y-3">
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => { setScope("shared"); setSelectedId(0); }}
              className={`h-8 rounded-md px-3 text-[12px] font-medium ${scope === "shared" ? "bg-accent text-accent-foreground" : "border hover:bg-hover"}`}
            >
              {t("共享文件夹")}
            </button>
            <button
              type="button"
              onClick={() => { setScope("personal"); setSelectedId(0); }}
              className={`h-8 rounded-md px-3 text-[12px] font-medium ${scope === "personal" ? "bg-accent text-accent-foreground" : "border hover:bg-hover"}`}
            >
              {t("我的文件夹")}
            </button>
          </div>

          <div>
            <label className="mb-1 block text-[13px] font-medium" htmlFor="wiki-import-source">{t("选择要迁入的文档或目录")}</label>
            <select
              id="wiki-import-source"
              value={selected?.id ?? 0}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              disabled={candidates.length === 0}
              className="h-9 w-full rounded-md border bg-surface px-3 text-[13px]"
              data-wiki-import-source
            >
              {candidates.length === 0 ? (
                <option value={0}>{t("当前目录下暂无可迁入项")}</option>
              ) : (
                candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.title || t("未命名文档")}</option>
                ))
              )}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-[13px] font-medium" htmlFor="wiki-import-parent">{t("迁入位置")}</label>
            <select
              id="wiki-import-parent"
              value={targetParentId ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                setTargetParentId(v > 0 ? v : null);
              }}
              className="h-9 w-full rounded-md border bg-surface px-3 text-[13px]"
            >
              <option value={0}>{t("知识库根目录")}</option>
              {parentChoices.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </div>

          {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="h-9 rounded-md border px-3.5 text-[13px] hover:bg-hover">{t("取消")}</button>
            <button
              type="button"
              disabled={busy || !selected}
              onClick={() => void submit()}
              className="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white disabled:opacity-50"
              data-wiki-import-submit
            >
              {busy ? t("迁入中…") : t("确定迁入")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
