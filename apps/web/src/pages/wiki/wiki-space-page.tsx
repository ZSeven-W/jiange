import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  CornerUpRight,
  FilePlus,
  Folder,
  FolderInput,
  Globe,
  GripVertical,
  Import,
  Link2,
  Lock,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Settings,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import {
  ApiError,
  driveApi,
  wikiApi,
  type DocMeta,
  type Me,
  type WikiNodeEntry,
  type WikiNodeKind,
  type WikiShortcut,
} from "@/lib/api";
import { go, nodeHref } from "@/lib/route";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { ask, askText } from "@/components/ui/ask";
import { BaseColorIcon, DocColorIcon, SheetColorIcon, SlidesColorIcon, WhiteboardIcon } from "@/components/feishu-icons";
import { ShareDialog } from "@/components/share-dialog";
import type { SearchGuardCapture } from "@/components/search-focus";
import { DocPage } from "@/pages/doc-page";
import { SheetPage } from "@/pages/sheet/sheet-page";
import { BasePage } from "@/pages/base-page";
import { SlidesDeck } from "@/pages/slides-page";
import { SurveyPage } from "@/pages/survey/survey-page";
import { stageBoard } from "@/pages/board-starter";
import { WikiSpaceSettingsDialog } from "./wiki-space-settings-dialog";
import { WikiImportDriveDialog, WikiMoveNodeDialog } from "./wiki-move-import-dialogs";
import { WikiShortcutDialog } from "./wiki-shortcut-dialog";
import { canDropWikiNode, computeStepReorder, computeWikiDropPlan, resolveRowDropZone, type WikiDropZone } from "./wiki-tree-dnd";

function WikiNodeGlyph({ kind, docType }: { kind: string; docType?: string }) {
  if (kind === "folder") return <Folder size={16} fill="#ffcc4d" stroke="#f5a623" className="shrink-0" />;
  if (kind === "sheet") return <SheetColorIcon className="size-4 shrink-0" />;
  if (kind === "base") return <BaseColorIcon className="size-4 shrink-0" />;
  if (kind === "slides") return <SlidesColorIcon className="size-4 shrink-0" />;
  if (kind === "doc" && docType === "board") return <WhiteboardIcon className="size-4 shrink-0 text-[#34c759]" />;
  return <DocColorIcon className="size-4 shrink-0" />;
}

function toDocMeta(node: WikiNodeEntry, spaceName: string): DocMeta {
  return {
    id: node.id,
    workspaceId: node.workspaceId,
    parentId: node.parentId,
    title: node.title,
    icon: node.icon ?? "",
    creatorId: node.creatorId,
    creatorName: node.creatorName,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    role: node.role,
    kind: node.kind,
    docType: node.docType,
    inheritParentAcl: node.inheritParentAcl,
    driveRevision: node.revision,
    wikiSpaceId: node.wikiSpaceId,
    wikiSpaceName: spaceName,
  };
}

export function WikiSpacePage({
  spaceId,
  nodeId,
  me,
  onGlobalSearch,
  onSearchGuardRegistrar,
}: {
  spaceId: number;
  nodeId: number | null;
  me: Me;
  onGlobalSearch?: () => void;
  onSearchGuardRegistrar?: (capture: SearchGuardCapture | null) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [rowMenuId, setRowMenuId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shortcutParentId, setShortcutParentId] = useState<number | null | undefined>(undefined);
  const [movingNode, setMovingNode] = useState<WikiNodeEntry | null>(null);
  const [sharingNode, setSharingNode] = useState<WikiNodeEntry | null>(null);
  const [dragNodeId, setDragNodeId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ targetId: number; zone: WikiDropZone } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const createMenuRef = useRef<HTMLDivElement>(null);

  const queryKey = ["wiki-space", spaceId, me.user.id];
  const spaceQuery = useQuery({
    queryKey,
    queryFn: () => wikiApi.getSpace(spaceId, me.user.id),
    refetchOnWindowFocus: true,
    retry: false,
  });

  const detail = spaceQuery.data;
  const space = detail?.space;
  const nodes = detail?.nodes ?? [];
  const shortcuts = detail?.shortcuts ?? [];

  useEffect(() => {
    document.title = space ? `${space.name} - ${t("知识库")} - Jiange` : `${t("知识库")} - Jiange`;
  }, [space?.name, locale, t]);

  useEffect(() => {
    setMobileDrawerOpen(false);
    setRowMenuId(null);
  }, [spaceId, nodeId]);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        e.preventDefault();
        setMobileDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileDrawerOpen]);

  useEffect(() => {
    if (!createMenuOpen && rowMenuId === null) return;
    const onDown = (e: MouseEvent) => {
      if (createMenuOpen && !createMenuRef.current?.contains(e.target as Node)) setCreateMenuOpen(false);
      if (rowMenuId !== null && !(e.target as HTMLElement | null)?.closest("[data-wiki-row-menu]")) setRowMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCreateMenuOpen(false);
        setRowMenuId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [createMenuOpen, rowMenuId]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const childrenMap = useMemo(() => {
    const map = new Map<number | null, WikiNodeEntry[]>();
    for (const n of nodes) {
      const parent = n.parentId && byId.has(n.parentId) ? n.parentId : null;
      map.set(parent, [...(map.get(parent) ?? []), n]);
    }
    return map;
  }, [nodes, byId]);

  const shortcutsMap = useMemo(() => {
    const map = new Map<number | null, WikiShortcut[]>();
    for (const sc of shortcuts) {
      const parent = sc.parentId && byId.has(sc.parentId) ? sc.parentId : null;
      map.set(parent, [...(map.get(parent) ?? []), sc]);
    }
    return map;
  }, [shortcuts, byId]);

  const activeNode = nodeId ? byId.get(nodeId) ?? null : null;

  const activeAncestors = useMemo(() => {
    const set = new Set<number>();
    let cur = activeNode;
    while (cur?.parentId && byId.has(cur.parentId) && !set.has(cur.parentId)) {
      set.add(cur.parentId);
      cur = byId.get(cur.parentId)!;
    }
    return set;
  }, [activeNode, byId]);

  const canEditSpace = space?.callerRole === "edit" || space?.callerRole === "manage";
  const canManageSpace = space?.callerRole === "manage";

  const refreshSpace = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey }),
      qc.invalidateQueries({ queryKey: ["wiki-spaces"] }),
      qc.invalidateQueries({ queryKey: ["docs"] }),
    ]);
  };

  const handleCreateNode = async (kind: WikiNodeKind | "board", parentId: number | null) => {
    if (busy || !space) return;
    setCreateMenuOpen(false);
    let title: string | undefined;
    if (kind === "folder") {
      const input = await askText(t("新建目录分组"), t("分组名称"));
      if (!input?.trim()) return;
      title = input.trim();
    }
    setBusy(true);
    setError("");
    try {
      const created = await wikiApi.createNode(space.id, me.user.id, { kind, parentId, title });
      if (kind === "board") stageBoard(me.user.id, created.id, "board");
      if (parentId) setExpanded((prev) => ({ ...prev, [parentId]: true }));
      await refreshSpace();
      go(`#/wiki/${space.id}/node/${created.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("新建内容失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  const handleRenameNode = async (node: WikiNodeEntry) => {
    setRowMenuId(null);
    const next = await askText(t("重命名"), t("页面名称"), node.title);
    if (!next?.trim() || next.trim() === node.title) return;
    setBusy(true);
    setError("");
    try {
      await driveApi.rename(node.id, next.trim(), node.revision);
      await refreshSpace();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("重命名失败，请刷新后重试"));
    } finally {
      setBusy(false);
    }
  };

  const handleTrashNode = async (node: WikiNodeEntry) => {
    setRowMenuId(null);
    const ok = await ask(t("删除「{title}」？", { title: node.title }), t("可在回收站还原。"));
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      await driveApi.trash(node.id, node.revision);
      await refreshSpace();
      await qc.invalidateQueries({ queryKey: ["trash"] });
      if (nodeId === node.id) go(`#/wiki/${spaceId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("删除失败，请刷新后重试"));
    } finally {
      setBusy(false);
    }
  };

  const handleReorderNode = async (node: WikiNodeEntry, targetParentId: number | null, position: number) => {
    if (busy || !space) return;
    setRowMenuId(null);
    setBusy(true);
    setError("");
    try {
      await wikiApi.reorderNode(space.id, node.id, me.user.id, {
        targetParentId,
        position,
        expectedRevision: node.revision,
      });
      if (targetParentId !== null) setExpanded((prev) => ({ ...prev, [targetParentId]: true }));
      await refreshSpace();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("调整目录顺序失败，请刷新后重试"));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteShortcut = async (sc: WikiShortcut) => {
    if (busy || !space) return;
    const label = sc.targetAccessible ? (sc.title || sc.targetTitle || t("快捷方式")) : t("失效快捷方式");
    const ok = await ask(t("移除快捷方式「{title}」？", { title: label }), t("不会删除原文档内容。"));
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      await wikiApi.deleteShortcut(space.id, sc.id, me.user.id);
      await refreshSpace();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("移除快捷方式失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  const canDeleteShortcut = (sc: WikiShortcut) => {
    if (sc.creatorId === me.user.id || canManageSpace) return true;
    if (sc.parentId === null) return canEditSpace;
    const parent = byId.get(sc.parentId);
    return parent?.role === "edit" || parent?.role === "manage";
  };

  const openShortcutTarget = (sc: WikiShortcut) => {
    if (!sc.targetAccessible) {
      setError(t("该快捷方式目标已删除或当前无权访问。"));
      return;
    }
    setError("");
    go(nodeHref({
      id: sc.targetNodeId,
      kind: sc.targetKind ?? "doc",
      wikiSpaceId: sc.targetWikiSpaceId ?? null,
    }));
  };

  const renderShortcuts = (parentId: number | null, depth: number): React.ReactNode =>
    (shortcutsMap.get(parentId) ?? []).map((sc) => {
      const displayTitle = sc.targetAccessible ? (sc.title || sc.targetTitle || t("快捷方式")) : t("无权访问或已删除");
      const sourceBadge = sc.targetAccessible
        ? sc.targetWikiSpaceId && sc.targetWikiSpaceId !== space?.id
          ? (sc.targetWikiSpaceName || t("跨库"))
          : sc.targetWikiSpaceId === space?.id
            ? t("本库")
            : t("云盘")
        : "";
      return (
        <div
          key={`sc-${sc.id}`}
          data-wiki-shortcut-row={sc.id}
          data-wiki-shortcut-locked={!sc.targetAccessible ? sc.id : undefined}
          className="group relative flex h-8 items-center rounded-md pr-1 text-[13px] text-foreground transition-colors hover:bg-hover"
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          <span aria-hidden className="size-5 shrink-0" />
          <button
            type="button"
            onClick={() => openShortcutTarget(sc)}
            title={sc.targetAccessible ? `${displayTitle}${sourceBadge ? ` · ${sourceBadge}` : ""}` : t("无权访问或已删除")}
            className={cn(
              "flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left",
              !sc.targetAccessible && "text-subtle",
            )}
          >
            <span className="relative grid size-4 shrink-0 place-items-center">
              {sc.targetAccessible ? (
                <>
                  <WikiNodeGlyph kind={sc.targetKind ?? "doc"} docType={sc.targetDocType} />
                  <CornerUpRight size={9} strokeWidth={2.5} className="absolute -bottom-0.5 -right-0.5 rounded-xs bg-surface text-primary" />
                </>
              ) : (
                <Lock size={13} className="text-subtle" />
              )}
            </span>
            <span className="min-w-0 truncate">{displayTitle}</span>
            {sourceBadge && (
              <span className="shrink-0 rounded bg-muted px-1 py-0 text-[10px] text-subtle">{sourceBadge}</span>
            )}
          </button>
          {canDeleteShortcut(sc) && (
            <button
              type="button"
              title={t("移除快捷方式")}
              aria-label={t("移除快捷方式")}
              onClick={() => void handleDeleteShortcut(sc)}
              data-wiki-delete-shortcut={sc.id}
              className="grid size-5 shrink-0 place-items-center rounded text-subtle opacity-0 transition-opacity hover:bg-black/5 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      );
    });

  const renderTree = (parentId: number | null, depth: number): React.ReactNode => {
    const siblings = childrenMap.get(parentId) ?? [];
    return (
      <>
        {siblings.map((node) => {
          const kids = childrenMap.get(node.id) ?? [];
          const kidShortcuts = shortcutsMap.get(node.id) ?? [];
          const hasChildren = kids.length > 0 || kidShortcuts.length > 0;
          const active = nodeId === node.id;
          const isOpen = expanded[node.id] ?? (activeAncestors.has(node.id) || active);
          const canEditNode = node.role === "edit" || node.role === "manage";
          const canManageNode = node.role === "manage";
          const canDrag = canEditNode && !busy;
          const stepUp = canEditNode ? computeStepReorder(siblings, node.id, -1) : null;
          const stepDown = canEditNode ? computeStepReorder(siblings, node.id, 1) : null;
          const showMenu = canManageNode || canEditNode;
          const activeDrop = dropTarget?.targetId === node.id ? dropTarget.zone : null;
          const isDragging = dragNodeId === node.id;

          return (
            <div key={node.id}>
              <div
                data-wiki-tree-row={node.id}
                data-wiki-drop-indicator={activeDrop ?? undefined}
                draggable={canDrag}
                onDragStart={(e) => {
                  if (!canDrag) { e.preventDefault(); return; }
                  e.stopPropagation();
                  setDragNodeId(node.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(node.id));
                }}
                onDragOver={(e) => {
                  if (dragNodeId === null || dragNodeId === node.id) return;
                  const dragged = byId.get(dragNodeId);
                  if (!dragged) return;
                  const zone = resolveRowDropZone(e.clientY, e.currentTarget.getBoundingClientRect());
                  if (!canDropWikiNode(byId, dragged, node, zone, space?.callerRole)) {
                    if (dropTarget?.targetId === node.id) setDropTarget(null);
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  if (dropTarget?.targetId !== node.id || dropTarget.zone !== zone) {
                    setDropTarget({ targetId: node.id, zone });
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropTarget?.targetId === node.id) {
                    setDropTarget(null);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const sourceId = dragNodeId ?? Number(e.dataTransfer.getData("text/plain"));
                  const dragged = Number.isSafeInteger(sourceId) ? byId.get(sourceId) : undefined;
                  const zone = dropTarget?.targetId === node.id ? dropTarget.zone : resolveRowDropZone(e.clientY, e.currentTarget.getBoundingClientRect());
                  setDragNodeId(null);
                  setDropTarget(null);
                  if (!dragged) return;
                  const plan = computeWikiDropPlan(childrenMap, byId, dragged, node, zone, space?.callerRole);
                  if (!plan) return;
                  void handleReorderNode(dragged, plan.targetParentId, plan.position);
                }}
                onDragEnd={() => {
                  setDragNodeId(null);
                  setDropTarget(null);
                }}
                className={cn(
                  "group relative flex h-8 items-center rounded-md pr-1 text-[13px] transition-colors",
                  active ? "bg-accent font-medium text-accent-foreground" : "text-foreground hover:bg-hover",
                  isDragging && "opacity-45",
                  activeDrop === "inside" && "bg-primary/10 ring-1 ring-primary",
                )}
                style={{ paddingLeft: 6 + depth * 14 }}
              >
                {activeDrop === "before" && (
                  <span aria-hidden className="pointer-events-none absolute inset-x-2 top-0 z-20 h-[2px] rounded-full bg-primary" />
                )}
                {activeDrop === "after" && (
                  <span aria-hidden className="pointer-events-none absolute inset-x-2 bottom-0 z-20 h-[2px] rounded-full bg-primary" />
                )}
                {hasChildren ? (
                  <button
                    type="button"
                    aria-label={isOpen ? t("收起") : t("展开")}
                    aria-expanded={isOpen}
                    onClick={() => setExpanded((prev) => ({ ...prev, [node.id]: !isOpen }))}
                    className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-black/5"
                  >
                    <ChevronRight size={12} className={cn("transition-transform", isOpen && "rotate-90")} />
                  </button>
                ) : (
                  <span aria-hidden className="grid size-5 shrink-0 place-items-center text-subtle/50">
                    {canDrag && <GripVertical size={11} className="opacity-0 transition-opacity group-hover:opacity-100" />}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => go(`#/wiki/${spaceId}/node/${node.id}`)}
                  className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <WikiNodeGlyph kind={node.kind} docType={node.docType} />
                  <span className="min-w-0 truncate">{node.title || t("未命名文档")}</span>
                  {!node.inheritParentAcl && (
                    <Lock size={11} className="shrink-0 text-amber-600" aria-label={t("独立权限")} />
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  {canEditNode && (
                    <button
                      type="button"
                      title={t("新建子页面")}
                      aria-label={t("在{title}下新建子页面", { title: node.title })}
                      onClick={() => void handleCreateNode("doc", node.id)}
                      className="grid size-5 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground"
                      data-wiki-add-child={node.id}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                  {showMenu && (
                    <div className="relative" data-wiki-row-menu>
                      <button
                        type="button"
                        title={t("更多操作")}
                        aria-label={t("更多操作")}
                        onClick={() => setRowMenuId((cur) => (cur === node.id ? null : node.id))}
                        className="grid size-5 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground"
                        data-wiki-node-more={node.id}
                      >
                        <MoreHorizontal size={13} />
                      </button>
                      {rowMenuId === node.id && (
                        <div className="absolute right-0 top-6 z-40 w-44 rounded-lg border bg-surface py-1 text-[13px] shadow-lg">
                          {stepUp !== null && (
                            <button
                              type="button"
                              onClick={() => void handleReorderNode(node, parentId, stepUp)}
                              data-wiki-move-up={node.id}
                              className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover"
                            >
                              <ArrowUp size={13} />{t("上移")}
                            </button>
                          )}
                          {stepDown !== null && (
                            <button
                              type="button"
                              onClick={() => void handleReorderNode(node, parentId, stepDown)}
                              data-wiki-move-down={node.id}
                              className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover"
                            >
                              <ArrowDown size={13} />{t("下移")}
                            </button>
                          )}
                          {canEditNode && (
                            <button
                              type="button"
                              onClick={() => { setRowMenuId(null); setShortcutParentId(node.id); }}
                              data-wiki-add-child-shortcut={node.id}
                              className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover"
                            >
                              <Link2 size={13} />{t("添加快捷方式")}
                            </button>
                          )}
                          {canManageNode && (
                            <>
                              {(stepUp !== null || stepDown !== null || canEditNode) && <div className="my-1 border-t" />}
                              <button
                                type="button"
                                onClick={() => { setRowMenuId(null); setSharingNode(node); }}
                                className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover"
                              >
                                <Share2 size={13} />{t("权限与分享")}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRenameNode(node)}
                                className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover"
                              >
                                <Pencil size={13} />{t("重命名")}
                              </button>
                              <button
                                type="button"
                                onClick={() => { setRowMenuId(null); setMovingNode(node); }}
                                className="flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-hover"
                              >
                                <FolderInput size={13} />{t("移动 / 跨库迁移")}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleTrashNode(node)}
                                className="flex h-8 w-full items-center gap-2 px-3 text-left text-destructive hover:bg-hover"
                              >
                                <Trash2 size={13} />{t("移至回收站")}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {hasChildren && isOpen && renderTree(node.id, depth + 1)}
            </div>
          );
        })}
        {renderShortcuts(parentId, depth)}
      </>
    );
  };

  if (spaceQuery.isPending) {
    return <div className="grid flex-1 place-items-center text-[14px] text-subtle">{t("正在加载知识库…")}</div>;
  }
  if (spaceQuery.isError || !space) {
    return (
      <div className="grid flex-1 place-items-center px-6" role="alert">
        <div className="max-w-md text-center">
          <p className="text-[14px] text-muted-foreground">
            {spaceQuery.error instanceof ApiError && [403, 404].includes(spaceQuery.error.status)
              ? t("知识库不存在或无权访问。")
              : t("无法加载知识库，请稍后重试。")}
          </p>
          <button
            type="button"
            onClick={() => go("#/wiki")}
            className="mt-4 h-9 rounded-md border px-4 text-[13px] hover:bg-hover"
          >
            {t("返回知识库列表")}
          </button>
        </div>
      </div>
    );
  }

  const sidebarContent = (
    <aside className="flex h-full w-[264px] max-w-[85vw] shrink-0 flex-col border-r bg-sidebar shadow-xl md:shadow-none" data-wiki-sidebar>
      <div className="flex h-12 items-center justify-between border-b px-3">
        <button
          type="button"
          onClick={() => go("#/wiki")}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <ArrowLeft size={15} />
          {t("知识库")}
        </button>
        <div className="flex items-center gap-1">
          {canManageSpace && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label={t("知识库设置")}
              title={t("知识库设置")}
              className="grid size-7 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground"
              data-wiki-space-settings
            >
              <Settings size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setSidebarCollapsed(true)}
            aria-label={t("收起目录")}
            title={t("收起目录")}
            className="hidden size-7 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground md:grid"
          >
            <PanelLeftClose size={15} />
          </button>
          <button
            type="button"
            onClick={() => setMobileDrawerOpen(false)}
            aria-label={t("关闭目录")}
            className="grid size-7 place-items-center rounded text-subtle hover:bg-hover hover:text-foreground md:hidden"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="border-b px-3 py-3">
        <button
          type="button"
          onClick={() => go(`#/wiki/${space.id}`)}
          className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-hover"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-[18px] shadow-xs">
            {space.icon || "📚"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-foreground">{space.name}</p>
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-subtle">
              {space.visibility === "private" ? <Lock size={11} /> : <Globe size={11} />}
              {space.visibility === "private" ? t("私有知识库") : t("全员可见")}
            </p>
          </div>
        </button>

        {canEditSpace && (
          <div ref={createMenuRef} className="relative mt-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => setCreateMenuOpen((v) => !v)}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-[13px] font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              data-wiki-create-menu
            >
              <Plus size={14} />
              {t("新建")}
            </button>
            {createMenuOpen && (
              <div className="absolute left-0 right-0 top-9 z-40 rounded-lg border bg-surface py-1 text-[13px] shadow-lg">
                <button type="button" onClick={() => void handleCreateNode("doc", null)} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-hover" data-wiki-new-doc>
                  <DocColorIcon className="size-4" />{t("新建文档")}
                </button>
                <button type="button" onClick={() => void handleCreateNode("sheet", null)} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-hover" data-wiki-new-sheet>
                  <SheetColorIcon className="size-4" />{t("新建表格")}
                </button>
                <button type="button" onClick={() => void handleCreateNode("base", null)} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-hover" data-wiki-new-base>
                  <BaseColorIcon className="size-4" />{t("新建多维表格")}
                </button>
                <button type="button" onClick={() => void handleCreateNode("slides", null)} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-hover" data-wiki-new-slides>
                  <SlidesColorIcon className="size-4" />{t("新建幻灯片")}
                </button>
                <button type="button" onClick={() => void handleCreateNode("board", null)} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-hover" data-wiki-new-board>
                  <WhiteboardIcon className="size-4 text-[#34c759]" />{t("新建画板")}
                </button>
                <button type="button" onClick={() => void handleCreateNode("folder", null)} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-hover" data-wiki-new-folder>
                  <Folder size={15} className="text-[#f5a623]" />{t("新建目录分组")}
                </button>
                <div className="my-1 border-t" />
                <button
                  type="button"
                  onClick={() => { setCreateMenuOpen(false); setShortcutParentId(null); }}
                  className="flex h-8 w-full items-center gap-2 px-3 hover:bg-hover"
                  data-wiki-add-shortcut
                >
                  <Link2 size={14} className="text-primary" />{t("添加快捷方式")}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreateMenuOpen(false); setImportOpen(true); }}
                  className="flex h-8 w-full items-center gap-2 px-3 text-primary hover:bg-hover"
                  data-wiki-import-drive
                >
                  <Import size={14} />{t("从云盘迁入")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error && <p role="alert" className="mb-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[12px] text-destructive">{error}</p>}
        {nodes.length === 0 && shortcuts.length === 0 ? (
          <p className="px-2 py-4 text-center text-[12px] text-subtle">{t("暂无页面，点击上方「新建」开始沉淀知识")}</p>
        ) : (
          renderTree(null, 0)
        )}
      </div>
    </aside>
  );

  const renderMainPane = () => {
    if (nodeId !== null && !activeNode) {
      return (
        <div className="grid flex-1 place-items-center p-6 text-center" role="alert">
          <div>
            <p className="text-[14px] text-muted-foreground">{t("该页面不存在或当前无权访问。")}</p>
            <button type="button" onClick={() => go(`#/wiki/${spaceId}`)} className="mt-3 h-8 rounded-md border px-3 text-[13px] hover:bg-hover">
              {t("返回知识库首页")}
            </button>
          </div>
        </div>
      );
    }

    if (!activeNode) {
      const topLevel = childrenMap.get(null) ?? [];
      const topShortcuts = shortcutsMap.get(null) ?? [];
      return (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-8" data-wiki-overview>
          <div className="mx-auto max-w-3xl">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
              <div className="flex min-w-0 items-center gap-3.5">
                <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-[#f2f5fc] text-[28px]">
                  {space.icon || "📚"}
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-[22px] font-semibold text-foreground">{space.name}</h1>
                  <p className="mt-1 text-[13px] text-muted-foreground">{space.description || t("团队结构化知识空间")}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canEditSpace && (
                  <button
                    type="button"
                    onClick={() => void handleCreateNode("doc", null)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary/90"
                  >
                    <FilePlus size={14} />{t("新建文档")}
                  </button>
                )}
                {canEditSpace && (
                  <button
                    type="button"
                    onClick={() => setShortcutParentId(null)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[13px] hover:bg-hover"
                    data-wiki-overview-add-shortcut
                  >
                    <Link2 size={14} />{t("添加快捷方式")}
                  </button>
                )}
                {canEditSpace && (
                  <button
                    type="button"
                    onClick={() => setImportOpen(true)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[13px] hover:bg-hover"
                  >
                    <Import size={14} />{t("从云盘迁入")}
                  </button>
                )}
                {canManageSpace && (
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[13px] hover:bg-hover"
                  >
                    <Settings size={14} />{t("空间设置")}
                  </button>
                )}
              </div>
            </div>

            <div className="mt-6">
              <h2 className="mb-3 text-[13px] font-medium text-subtle">{t("目录总览")}（{topLevel.length + topShortcuts.length}）</h2>
              {topLevel.length === 0 && topShortcuts.length === 0 ? (
                <p className="rounded-xl border border-dashed bg-surface py-12 text-center text-[13px] text-subtle">
                  {t("该知识库暂无页面")}
                </p>
              ) : (
                <div className="divide-y rounded-xl border bg-surface">
                  {topLevel.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => go(`#/wiki/${space.id}/node/${item.id}`)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-hover"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <WikiNodeGlyph kind={item.kind} docType={item.docType} />
                        <span className="truncate text-[14px] font-medium text-foreground">{item.title}</span>
                        {!item.inheritParentAcl && <Lock size={12} className="shrink-0 text-amber-600" />}
                      </span>
                      <span className="shrink-0 text-[12px] text-subtle">{item.creatorName}</span>
                    </button>
                  ))}
                  {topShortcuts.map((sc) => (
                    <button
                      key={`ov-sc-${sc.id}`}
                      type="button"
                      onClick={() => openShortcutTarget(sc)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-hover"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        {sc.targetAccessible ? (
                          <span className="relative grid size-4 shrink-0 place-items-center">
                            <WikiNodeGlyph kind={sc.targetKind ?? "doc"} docType={sc.targetDocType} />
                            <CornerUpRight size={9} strokeWidth={2.5} className="absolute -bottom-0.5 -right-0.5 rounded-xs bg-surface text-primary" />
                          </span>
                        ) : (
                          <Lock size={14} className="shrink-0 text-subtle" />
                        )}
                        <span className={cn("truncate text-[14px] font-medium", sc.targetAccessible ? "text-foreground" : "text-subtle")}>
                          {sc.targetAccessible ? (sc.title || sc.targetTitle || t("快捷方式")) : t("无权访问或已删除")}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-subtle">
                          {sc.targetAccessible
                            ? sc.targetWikiSpaceId && sc.targetWikiSpaceId !== space.id
                              ? (sc.targetWikiSpaceName || t("跨库"))
                              : t("快捷方式")
                            : t("已失效")}
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-subtle">{sc.creatorName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (activeNode.kind === "folder") {
      const kids = childrenMap.get(activeNode.id) ?? [];
      const kidShortcuts = shortcutsMap.get(activeNode.id) ?? [];
      const canEditFolder = activeNode.role === "edit" || activeNode.role === "manage";
      return (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-8" data-wiki-folder-view>
          <div className="mx-auto max-w-3xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <Folder size={24} fill="#ffcc4d" stroke="#f5a623" className="shrink-0" />
                <h1 className="truncate text-[20px] font-semibold">{activeNode.title}</h1>
                {!activeNode.inheritParentAcl && (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                    <Lock size={11} />{t("独立权限")}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canEditFolder && (
                  <button
                    type="button"
                    onClick={() => void handleCreateNode("doc", activeNode.id)}
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[13px] text-white hover:bg-primary/90"
                  >
                    <Plus size={14} />{t("新建子文档")}
                  </button>
                )}
                {canEditFolder && (
                  <button
                    type="button"
                    onClick={() => setShortcutParentId(activeNode.id)}
                    className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-[13px] hover:bg-hover"
                  >
                    <Link2 size={14} />{t("添加快捷方式")}
                  </button>
                )}
                {activeNode.role === "manage" && (
                  <button
                    type="button"
                    onClick={() => setSharingNode(activeNode)}
                    className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-[13px] hover:bg-hover"
                  >
                    <Share2 size={14} />{t("权限与分享")}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-5">
              {kids.length === 0 && kidShortcuts.length === 0 ? (
                <p className="rounded-xl border border-dashed bg-surface py-12 text-center text-[13px] text-subtle">{t("该目录下暂无子页面")}</p>
              ) : (
                <div className="divide-y rounded-xl border bg-surface">
                  {kids.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      onClick={() => go(`#/wiki/${space.id}/node/${child.id}`)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-hover"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <WikiNodeGlyph kind={child.kind} docType={child.docType} />
                        <span className="truncate text-[14px]">{child.title}</span>
                      </span>
                      <span className="shrink-0 text-[12px] text-subtle">{child.creatorName}</span>
                    </button>
                  ))}
                  {kidShortcuts.map((sc) => (
                    <button
                      key={`f-sc-${sc.id}`}
                      type="button"
                      onClick={() => openShortcutTarget(sc)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-hover"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        {sc.targetAccessible ? (
                          <span className="relative grid size-4 shrink-0 place-items-center">
                            <WikiNodeGlyph kind={sc.targetKind ?? "doc"} docType={sc.targetDocType} />
                            <CornerUpRight size={9} strokeWidth={2.5} className="absolute -bottom-0.5 -right-0.5 rounded-xs bg-surface text-primary" />
                          </span>
                        ) : (
                          <Lock size={14} className="shrink-0 text-subtle" />
                        )}
                        <span className={cn("truncate text-[14px]", !sc.targetAccessible && "text-subtle")}>
                          {sc.targetAccessible ? (sc.title || sc.targetTitle || t("快捷方式")) : t("无权访问或已删除")}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-subtle">
                          {sc.targetAccessible
                            ? sc.targetWikiSpaceId && sc.targetWikiSpaceId !== space.id
                              ? (sc.targetWikiSpaceName || t("跨库"))
                              : t("快捷方式")
                            : t("已失效")}
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-subtle">{sc.creatorName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (activeNode.kind === "sheet") {
      return <SheetPage key={`${me.user.id}:${activeNode.id}`} sheetId={activeNode.id} me={me} onGlobalSearch={onGlobalSearch} />;
    }
    if (activeNode.kind === "base") {
      return <BasePage key={`${activeNode.id}:${me.user.id}`} id={activeNode.id} userId={me.user.id} />;
    }
    if (activeNode.kind === "slides") {
      return <SlidesDeck key={`${me.user.id}:${activeNode.id}`} deckId={activeNode.id} userId={me.user.id} />;
    }
    if (activeNode.kind === "survey") {
      return <SurveyPage key={`${me.user.id}:${activeNode.id}`} surveyId={activeNode.id} />;
    }
    return (
      <DocPage
        key={activeNode.id}
        id={activeNode.id}
        me={me}
        sidebarDocked={true}
        onGlobalSearch={onGlobalSearch}
        onSearchGuardRegistrar={onSearchGuardRegistrar}
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden bg-background" data-wiki-space-page data-wiki-tree-open={mobileDrawerOpen ? "true" : "false"}>
      {!sidebarCollapsed && <div className="hidden md:flex">{sidebarContent}</div>}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden" data-wiki-tree-drawer>
          <div className="relative z-10 flex">{sidebarContent}</div>
          <button
            type="button"
            aria-label={t("关闭目录")}
            className="flex-1 bg-black/35 backdrop-blur-[1px]"
            onClick={() => setMobileDrawerOpen(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b bg-surface px-3 pl-14 md:h-11 md:pl-3", !sidebarCollapsed && "md:hidden")}>
          <button
            type="button"
            onClick={() => {
              if (window.matchMedia("(min-width: 768px)").matches) setSidebarCollapsed(false);
              else setMobileDrawerOpen(true);
            }}
            aria-label={t("打开知识库目录")}
            aria-expanded={mobileDrawerOpen}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-foreground hover:bg-hover"
            data-wiki-open-tree
          >
            <span className="md:hidden"><Menu size={14} /></span>
            <span className="hidden md:inline"><PanelLeftOpen size={14} /></span>
            {t("目录")}
          </button>
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{space.name}</span>
          {activeNode && <span className="min-w-0 truncate text-[12px] text-subtle">/ {activeNode.title}</span>}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-wiki-main-pane>{renderMainPane()}</div>
      </div>

      {settingsOpen && canManageSpace && (
        <WikiSpaceSettingsDialog
          space={space}
          grants={detail.grants}
          userId={me.user.id}
          onClose={() => setSettingsOpen(false)}
          onDeleted={() => {
            setSettingsOpen(false);
            go("#/wiki");
          }}
        />
      )}

      {importOpen && canEditSpace && (
        <WikiImportDriveDialog
          spaceId={space.id}
          nodes={nodes}
          userId={me.user.id}
          onClose={() => setImportOpen(false)}
          onImported={(imported) => {
            setImportOpen(false);
            go(`#/wiki/${space.id}/node/${imported.id}`);
          }}
        />
      )}

      {shortcutParentId !== undefined && canEditSpace && (
        <WikiShortcutDialog
          spaceId={space.id}
          workspaceId={space.workspaceId}
          userId={me.user.id}
          nodes={nodes}
          initialParentId={shortcutParentId}
          onClose={() => setShortcutParentId(undefined)}
          onCreated={() => {
            if (shortcutParentId !== null) setExpanded((prev) => ({ ...prev, [shortcutParentId]: true }));
            setShortcutParentId(undefined);
            void refreshSpace();
          }}
        />
      )}

      {movingNode && (
        <WikiMoveNodeDialog
          node={movingNode}
          workspaceId={space.workspaceId}
          userId={me.user.id}
          onClose={() => setMovingNode(null)}
          onMoved={(moved) => {
            setMovingNode(null);
            go(`#/wiki/${moved.wikiSpaceId}/node/${moved.id}`);
          }}
        />
      )}

      {sharingNode && (
        <ShareDialog
          meta={toDocMeta(sharingNode, space.name)}
          userId={me.user.id}
          onClose={() => {
            setSharingNode(null);
            void refreshSpace();
          }}
        />
      )}
    </div>
  );
}
