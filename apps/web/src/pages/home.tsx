import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, baseApi, docsApi, driveApi, extrasApi, type DocMeta, type Me } from "@/lib/api";
import { DocumentGlyph } from "@/components/document-glyph";
import { go } from "@/lib/route";
import { docTitle, hrefOf, isBoardDoc } from "@/components/sidebar";
import { Avatar } from "@/components/brand";
import { colorFor } from "@/lib/presence";
import { BaseColorIcon, DocColorIcon, SheetColorIcon, SlidesColorIcon, WhiteboardIcon } from "@/components/feishu-icons";
import { NewDocGlyph, TemplateGlyph } from "@/components/drive-action-icons";
import { HomeUpload } from "@/components/home-upload";
import { ShareDialog } from "@/components/share-dialog";
import { FeishuSelect } from "@/components/feishu-select";
import { HomeDocumentActions } from "./home-document-actions";
import { canDuplicateHomeDocument, sameTrashSnapshot } from "./home-file-actions";
import type { DriveUploadManager } from "./drive-upload";
import { DocxImportError, isDocxFile, readDocxFile } from "@/lib/docx";
import { stagePendingWord } from "./pending-word";
import { parseMarkdown } from "@/lib/markdown";
import { type StarterTemplate } from "./starter-template-data";
import { TemplateLibrary } from "./template-library";
import { stageStarter } from "./pending-starter";
import { BOARD_TITLE, MINDMAP_TITLE, stageBoard, type BoardStarterKind } from "./board-starter";
import { hasUnsupportedImportBlocks } from "./starter-template-ops";
import { ask, askText } from "@/components/ui/ask";
import { Check, ChevronDown, ChevronRight, ClipboardList, FileText, Folder, FolderOpen, Grid2X2, List, ListTree, Pin, PinOff, Plus, Star, Trash2 } from "lucide-react";
import { t, useI18n } from "@/lib/i18n";
import { formatDriveTime } from "./drive-sort";
import { batchMessage, pruneSelection, runDriveBatch, toggleId } from "./drive-batch";
import { browserHomeViewStorage, homeViewKey, matchesHomeTypeFilter, readHomeView, writeHomeView, type HomeView } from "./home-view";

type HomeTab = "recent" | "updated" | "mine" | "shared" | "favorites";
const LIST_GRID = "grid grid-cols-[minmax(0,1fr)_100px] sm:grid-cols-[minmax(0,1fr)_112px_120px] lg:grid-cols-[minmax(150px,2fr)_minmax(90px,1fr)_minmax(92px,1fr)_110px_120px]";

export function Home({ me, uploads, recent, favorites }: { me: Me; uploads: DriveUploadManager; recent?: boolean; favorites?: boolean }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  useEffect(() => { document.title = `${favorites ? t("收藏") : recent ? t("最近访问") : t("主页")} - Jiange`; }, [favorites, recent, locale]);
  const [tab, setTab] = useState<HomeTab>("recent");
  const [kind, setKind] = useState("all");
  const [viewPreference, setViewPreference] = useState(() => ({ userId: me.user.id, view: readHomeView(browserHomeViewStorage(), me.user.id) }));
  const view = viewPreference.userId === me.user.id ? viewPreference.view : readHomeView(browserHomeViewStorage(), me.user.id);
  const setView = (next: HomeView) => { writeHomeView(browserHomeViewStorage(), me.user.id, next); setViewPreference({ userId: me.user.id, view: next }); };
  useEffect(() => {
    setViewPreference({ userId: me.user.id, view: readHomeView(browserHomeViewStorage(), me.user.id) });
    const sync = (event: StorageEvent) => { if (event.key === homeViewKey(me.user.id) || event.key === null) setViewPreference({ userId: me.user.id, view: readHomeView(browserHomeViewStorage(), me.user.id) }); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [me.user.id]);
  const [newMenu, setNewMenu] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importError, setImportError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [sharingDoc, setSharingDoc] = useState<DocMeta | null>(null);
  const [actionError, setActionError] = useState("");
  const [copyResult, setCopyResult] = useState<DocMeta | null>(null);
  const [uncertainCopies, setUncertainCopies] = useState<Set<number>>(() => new Set());
  const [uncertainTrash, setUncertainTrash] = useState<Set<number>>(() => new Set());
  const [actionBusy, setActionBusy] = useState(false);
  const [pinsCollapsed, setPinsCollapsed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [batchPending, setBatchPending] = useState(false);
  useEffect(() => { if (!actionNotice) return; const timer = window.setTimeout(() => setActionNotice(""), 4000); return () => window.clearTimeout(timer); }, [actionNotice]);
  const actionLock = useRef(false);
  const actionGeneration = useRef(0);
  useEffect(() => { actionGeneration.current++; return () => { actionGeneration.current++; }; }, [me.user.id]);
  const [importing, setImporting] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const contentLock = useRef(false);
  const importGeneration = useRef(0);
  useEffect(() => { importGeneration.current++; return () => { importGeneration.current++; }; }, [me.user.id]);
  useEffect(() => {
    if (!newMenu) return;
    const close = (event: MouseEvent) => { if (!newMenuRef.current?.contains(event.target as Node)) setNewMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setNewMenu(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [newMenu]);
  useEffect(() => {
    if (!libraryOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setLibraryOpen(false); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [libraryOpen]);
  const selected = favorites ? "favorites" : recent ? "recent" : tab;
  const docs = useQuery({ queryKey: ["docs"], queryFn: docsApi.list });
  const recentDocs = useQuery({ queryKey: ["recent", me.user.id], queryFn: docsApi.recent, enabled: selected === "recent", refetchInterval: 15000, refetchIntervalInBackground: false });
  const shared = useQuery({ queryKey: ["shared"], queryFn: docsApi.shared, enabled: selected === "shared" });
  const favs = useQuery({ queryKey: ["home-favorites", me.user.id], queryFn: () => extrasApi.favoritesForAccount(me.user.id), refetchOnWindowFocus: true, retry: false });
  const pins = useQuery({ queryKey: ["home-pins", me.user.id], queryFn: () => extrasApi.pinsForAccount(me.user.id), refetchOnWindowFocus: true, retry: false });
  const create = useMutation({
    mutationFn: (type: "doc" | "base") => type === "base" ? baseApi.create() : docsApi.create(""),
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ["docs"] }); go(hrefOf(d)); },
  });
  const currentUser = useRef(me.user.id); currentUser.current = me.user.id;
  useEffect(() => { setSharingDoc(null); setActionNotice(""); setActionBusy(false); setActionError(""); setCopyResult(null); setUncertainCopies(new Set()); setUncertainTrash(new Set()); setSelectedIds(new Set()); }, [me.user.id]);
  const toggleShortcut = async (doc: DocMeta, type: "favorite" | "pin") => {
    if (actionLock.current || favs.isFetching || pins.isFetching || favs.isError || pins.isError || !favs.data || !pins.data) return;
    const owner = me.user.id;
    const old = type === "favorite" ? favs.data.some((item) => item.id === doc.id) : pins.data.some((item) => item.id === doc.id);
    actionLock.current = true; setActionBusy(true); setActionNotice("");
    try {
      if (type === "favorite") await extrasApi.favoriteForAccount(doc.id, owner, !old); else await extrasApi.pinForAccount(doc.id, owner, !old);
      const key = [type === "favorite" ? "home-favorites" : "home-pins", owner];
      await qc.cancelQueries({ queryKey: key });
      const verified = type === "favorite" ? await extrasApi.favoritesForAccount(owner) : await extrasApi.pinsForAccount(owner);
      if (verified.some((item) => item.id === doc.id) !== !old) throw new Error("shortcut state not confirmed");
      qc.setQueryData(key, verified);
      void qc.invalidateQueries({ queryKey: [type === "favorite" ? "favorites" : "pins"] });
      if (currentUser.current === owner) setActionNotice(t("操作已完成"));
    } catch {
      void qc.invalidateQueries({ queryKey: [type === "favorite" ? "home-favorites" : "home-pins", owner] });
      if (currentUser.current === owner) setActionNotice(t("操作结果未确认，请刷新后检查。"));
    } finally { actionLock.current = false; if (currentUser.current === owner) setActionBusy(false); }
  };
  const copyDocumentLink = async (doc: DocMeta) => {
    try {
      if (!navigator.clipboard || !Number.isSafeInteger(doc.id) || doc.id <= 0) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}${hrefOf(doc)}`);
      setActionNotice(t("链接已复制，访问者仍需具备权限。"));
    } catch { setActionNotice(t("复制失败，请检查浏览器剪贴板权限。")); }
  };
  const refreshHome = () => { for (const key of ["docs", "recent", "shared", "drive", "drive-nav", "trash", "favorites", "pins", "home-favorites", "home-pins"]) void qc.invalidateQueries({ queryKey: [key] }); };
  const duplicateHomeDocument = async (doc: DocMeta) => {
    if (actionLock.current || uncertainCopies.has(doc.id)) return;
    const owner = me.user.id, generation = actionGeneration.current;
    const stillHere = () => currentUser.current === owner && actionGeneration.current === generation;
    actionLock.current = true; setActionBusy(true); setActionError(""); setActionNotice(""); setCopyResult(null);
    let submitted = false;
    try {
      const latest = await docsApi.getForAccount(doc.id, owner);
      if (!stillHere()) return;
      if (latest.id !== doc.id || !canDuplicateHomeDocument(latest)) throw new Error(t("当前文档无法创建副本。"));
      submitted = true;
      const copy = await docsApi.duplicateForAccount(doc.id, owner);
      if (!copy || !Number.isSafeInteger(copy.id) || copy.id <= 0 || copy.id === doc.id || copy.kind !== latest.kind || copy.creatorId !== owner) throw new Error("invalid copy receipt");
      refreshHome();
      if (stillHere()) setCopyResult(copy);
    } catch (error) {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (stillHere()) {
        if (submitted && !known) { setUncertainCopies((old) => new Set(old).add(doc.id)); setActionError(t("创建结果未确认，请刷新并检查云盘中的副本。")); }
        else setActionError(error instanceof Error ? error.message : t("创建副本失败，请检查网络后重试。"));
      }
      refreshHome();
    } finally { actionLock.current = false; if (stillHere()) setActionBusy(false); }
  };
  const trashHomeDocument = async (doc: DocMeta) => {
    if (actionLock.current || uncertainTrash.has(doc.id)) return;
    const owner = me.user.id, generation = actionGeneration.current;
    const stillHere = () => currentUser.current === owner && actionGeneration.current === generation;
    actionLock.current = true; setActionBusy(true); setActionError(""); setActionNotice(""); setCopyResult(null);
    let submitted = false;
    try {
      const before = await docsApi.getForAccount(doc.id, owner);
      if (!stillHere()) return;
      if (before.id !== doc.id || !sameTrashSnapshot(before, before)) throw new Error(t("无法确认删除权限或文档版本。"));
      if (!await ask(t("删除「{title}」？", { title: docTitle(before) }), t("可在回收站还原。"))) return;
      if (!stillHere()) return;
      const after = await docsApi.getForAccount(doc.id, owner);
      if (!stillHere()) return;
      if (!sameTrashSnapshot(before, after)) throw new Error(t("文档已发生变化，请重新确认后删除。"));
      submitted = true;
      await driveApi.trashForAccount(doc.id, owner, before.driveRevision as number);
      refreshHome();
      if (stillHere()) setActionNotice(t("已移到回收站"));
    } catch (error) {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (stillHere()) {
        if (submitted && !known) { setUncertainTrash((old) => new Set(old).add(doc.id)); setActionError(t("删除结果未确认，请刷新并检查回收站。")); }
        else setActionError(error instanceof Error ? error.message : t("删除失败，请检查网络后重试。"));
      }
      refreshHome();
    } finally { actionLock.current = false; if (stillHere()) setActionBusy(false); }
  };
  const documentActions = (doc: DocMeta) => <HomeDocumentActions doc={doc} starred={!!favs.data?.some((item) => item.id === doc.id)} pinned={!!pins.data?.some((item) => item.id === doc.id)} ready={!!favs.data && !!pins.data && !favs.isFetching && !pins.isFetching && !favs.isError && !pins.isError} busy={actionBusy} onFavorite={() => void toggleShortcut(doc, "favorite")} onPin={() => void toggleShortcut(doc, "pin")} onCopy={() => void copyDocumentLink(doc)} onShare={() => setSharingDoc(doc)} onDuplicate={() => void duplicateHomeDocument(doc)} onTrash={() => void trashHomeDocument(doc)} copyEnabled={["doc", "slides", "sheet", "base", "survey"].includes(doc.kind ?? "") && !uncertainCopies.has(doc.id)} trashEnabled={doc.role === "manage" && ["doc", "base", "slides", "sheet", "survey", "file"].includes(doc.kind ?? "") && !uncertainTrash.has(doc.id)}/>;
  const createBoard = useMutation({
    mutationFn: async (kind: BoardStarterKind) => {
      const owner = me.user.id;
      const doc = kind === "mindmap"
        ? await driveApi.createWordImportNode(MINDMAP_TITLE, null, true, owner)
        : await driveApi.createWordImportNode(BOARD_TITLE, null, true, owner, "board");
      if (!Number.isSafeInteger(doc.id) || doc.id <= 0 || doc.kind !== "doc" || (kind === "board" && doc.docType !== "board") || ("creatorId" in doc && doc.creatorId !== undefined && doc.creatorId !== owner)) throw new Error("invalid document response");
      stageBoard(owner, doc.id, kind); return { doc, owner };
    },
    onSuccess: ({ doc, owner }) => { void qc.invalidateQueries({ queryKey: ["docs"] }); void qc.invalidateQueries({ queryKey: ["drive"] }); void qc.invalidateQueries({ queryKey: ["drive-nav"] }); if (currentUser.current === owner) go(hrefOf({ id: doc.id, kind: "doc" })); else setImportError(t("创建结果未确认，请检查文档库。")); },
    onError: () => setImportError(t("创建结果未确认，请检查文档库。")),
  });
  const createDriveItem = useMutation({
    mutationFn: ({ kind, title }: { kind: "slides" | "sheet" | "survey" | "folder"; title: string }) => driveApi.createNode(kind, title, null, true),
    onSuccess: (entry) => {
      void qc.invalidateQueries({ queryKey: ["docs"] });
      void qc.invalidateQueries({ queryKey: ["drive"] });
      void qc.invalidateQueries({ queryKey: ["drive-nav"] });
      go(entry.kind === "folder" ? `#/drive/${entry.id}` : hrefOf({ id: entry.id, kind: entry.kind }));
    },
  });
  const createWithContent = useMutation({
    mutationFn: async ({ title, markdown }: { title: string; markdown: string }) => {
      const doc = await docsApi.create(title);
      stageStarter(me.user.id, doc.id, markdown);
      return doc;
    },
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ["docs"] }); setLibraryOpen(false); go(hrefOf(d)); },
    onError: () => setImportError(t("创建文档失败，请稍后重试。")),
  });
  const importFile = async (file: File) => {
    if (contentLock.current) return;
    contentLock.current = true;
    const generation = importGeneration.current;
    const stillHere = () => generation === importGeneration.current;
    setImportError(""); setImporting(true);
    try {
      if (isDocxFile(file)) {
        const result = await readDocxFile(file, { images: true });
        if (result.warnings.length && !await ask(t("Word 导入可能丢失内容"), `${result.warnings.join("；")}。${t("仍要导入其余内容吗？")}`, false)) return;
        if (!stillHere()) return;
        const title = file.name.replace(/\.docx$/i, "").trim() || result.title || t("导入文档");
        const doc = await driveApi.createWordImportNode(title, null, true, me.user.id);
        await stagePendingWord(me.user.id, doc.id, file);
        if (!stillHere()) return;
        void qc.invalidateQueries({ queryKey: ["docs"] }); void qc.invalidateQueries({ queryKey: ["drive"] });
        go(hrefOf({ id: doc.id, kind: "doc" }));
        return;
      }
      if (file.size > 5 * 1024 * 1024) throw new Error(t("Markdown 文件不能超过 5 MB。"));
      const markdown = await file.text();
      if (!parseMarkdown(markdown).length) throw new Error(t("文件没有可导入的内容。"));
      if (hasUnsupportedImportBlocks(markdown)) throw new Error(t("暂不支持导入图片，请先移除图片内容。"));
      if (!stillHere()) return;
      const title = file.name.replace(/\.(md|markdown)$/i, "") || t("导入文档");
      // The guarded import endpoint also accepts Markdown and binds creation
      // to the account that selected the file, even if another tab signs in.
      const doc = await driveApi.createWordImportNode(title, null, true, me.user.id);
      stageStarter(me.user.id, doc.id, markdown);
      if (!stillHere()) return;
      void qc.invalidateQueries({ queryKey: ["docs"] }); void qc.invalidateQueries({ queryKey: ["drive"] });
      go(hrefOf({ id: doc.id, kind: "doc" }));
    } catch (error) {
      if (stillHere()) setImportError(error instanceof DocxImportError || (error instanceof Error && !isDocxFile(file)) ? error.message : t("导入未完成，请检查目录后重试。"));
    } finally { contentLock.current = false; if (stillHere()) setImporting(false); }
  };
  const chooseTemplate = (template: StarterTemplate) => {
    if (contentLock.current) return;
    contentLock.current = true;
    createWithContent.mutate({ title: template.name, markdown: template.body }, { onSettled: () => { contentLock.current = false; } });
  };
  const query = selected === "favorites" ? favs : selected === "shared" ? shared : selected === "recent" ? recentDocs : docs;
  const items = [...(query.data ?? [])]
    .filter((d) => matchesHomeTypeFilter(d, kind) && (selected !== "mine" || d.creatorId === me.user.id))
    .sort((a, b) => selected === "recent" ? 0 : Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const itemIdsKey = items.map((item) => item.id).join(",");
  useEffect(() => {
    setSelectedIds((prev) => pruneSelection(prev, items.map((item) => item.id)));
  }, [itemIdsKey]);
  const chosenDocs = items.filter((item) => selectedIds.has(item.id));
  const finishHomeBatch = (verb: string, result: { done: number[]; failed: number[] }) => {
    const { notice: n, error: e } = batchMessage(verb, result);
    if (n) setActionNotice(n);
    if (e) setActionError(e);
    setSelectedIds(new Set(result.failed));
    refreshHome();
  };
  const batchHomeFavorite = async () => {
    if (!chosenDocs.length || batchPending) return;
    const owner = me.user.id;
    const starredIds = new Set((favs.data ?? []).map((item) => item.id));
    setBatchPending(true); setActionError(""); setActionNotice("");
    try {
      const result = await runDriveBatch(chosenDocs, (doc) => starredIds.has(doc.id) ? Promise.resolve() : extrasApi.favoriteForAccount(doc.id, owner, true));
      if (currentUser.current === owner) finishHomeBatch("收藏", result);
    } finally { if (currentUser.current === owner) setBatchPending(false); }
  };
  const batchHomePin = async () => {
    if (!chosenDocs.length || batchPending) return;
    const owner = me.user.id;
    const pinnedIds = new Set((pins.data ?? []).map((item) => item.id));
    setBatchPending(true); setActionError(""); setActionNotice("");
    try {
      const result = await runDriveBatch(chosenDocs, (doc) => pinnedIds.has(doc.id) ? Promise.resolve() : extrasApi.pinForAccount(doc.id, owner, true));
      if (currentUser.current === owner) finishHomeBatch("置顶", result);
    } finally { if (currentUser.current === owner) setBatchPending(false); }
  };
  const batchHomeTrash = async () => {
    if (!chosenDocs.length || batchPending) return;
    const owner = me.user.id;
    if (!await ask(t("删除选中的 {n} 项？", { n: chosenDocs.length }), t("可在回收站还原。"))) return;
    if (currentUser.current !== owner) return;
    setBatchPending(true); setActionError(""); setActionNotice("");
    try {
      const result = await runDriveBatch(chosenDocs, async (doc) => {
        const latest = await docsApi.getForAccount(doc.id, owner);
        if (!sameTrashSnapshot(latest, latest)) throw new Error("cannot trash");
        await driveApi.trashForAccount(doc.id, owner, latest.driveRevision as number);
      });
      if (currentUser.current === owner) finishHomeBatch("删除", result);
    } finally { if (currentUser.current === owner) setBatchPending(false); }
  };
  const pinnedDocs = !recent && !favorites ? (pins.data ?? []) : [];
  const pageTitle = favorites ? t("收藏") : recent ? t("最近访问") : t("主页");
  const menu = newMenu && <div role="menu" aria-label={t("新建")} className={`absolute top-[calc(100%+4px)] z-30 max-h-[min(70dvh,520px)] w-full min-w-44 overflow-y-auto rounded-md border bg-surface py-1 shadow-[0_6px_22px_rgba(31,35,41,0.16)] ${recent || favorites ? "right-0" : "left-0"}`}>
    <button role="menuitem" disabled={create.isPending} onClick={() => { setNewMenu(false); create.mutate("doc"); }} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover"><FileBadge kind="doc" />{t("文档")}</button>
    <button role="menuitem" disabled={createDriveItem.isPending} onClick={() => { setNewMenu(false); createDriveItem.mutate({ kind: "sheet", title: t("未命名表格") }); }} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover" data-new-sheet><FileBadge kind="sheet" />{t("表格")}</button>
    <button role="menuitem" disabled={createDriveItem.isPending} onClick={() => { setNewMenu(false); createDriveItem.mutate({ kind: "survey", title: t("未命名问卷") }); }} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover" data-new-survey><FileBadge kind="survey" />{t("问卷")}</button>
    <button role="menuitem" disabled={createDriveItem.isPending} onClick={() => { setNewMenu(false); createDriveItem.mutate({ kind: "slides", title: t("未命名幻灯片") }); }} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover"><FileBadge kind="slides" />{t("幻灯片")}</button>
    <button role="menuitem" disabled={create.isPending} onClick={() => { setNewMenu(false); create.mutate("base"); }} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover"><FileBadge kind="base" />{t("多维表格")}</button>
    <div className="my-1 border-t" />
    <button role="menuitem" disabled={createDriveItem.isPending} onClick={async () => { setNewMenu(false); const title = await askText(t("新建文件夹"), t("文件夹名称"), t("未命名文件夹")); if (title?.trim()) createDriveItem.mutate({ kind: "folder", title: title.trim() }); }} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover"><FileBadge kind="folder" />{t("文件夹")}</button>
    <div className="mt-1 border-t px-4 pb-1 pt-3 text-[13px] text-subtle">{t("文档应用")}</div>
    <button role="menuitem" disabled={createBoard.isPending} onClick={() => { setNewMenu(false); createBoard.mutate("board"); }} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover" data-new-board><BoardBadge />{t("画板")}</button>
    <button role="menuitem" disabled={createBoard.isPending} onClick={() => { setNewMenu(false); createBoard.mutate("mindmap"); }} className="flex h-10 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover" data-new-mindmap><ListTree size={20} className="shrink-0 text-[#1caff0]"/>{t("思维导图")}</button>
  </div>;
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between pl-16 pr-5 md:px-7 xl:px-6">
        <h1 className="text-[20px] font-semibold leading-7">{pageTitle}</h1>
        {(recent || favorites) && <div ref={newMenuRef} className="relative">
          <button onClick={() => setNewMenu((v) => !v)} aria-expanded={newMenu} aria-haspopup="menu" className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-hover"><Plus size={15} /> {t("新建")} <ChevronDown size={13} /></button>
          {menu}
        </div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full px-5 pb-16 pt-2 sm:px-7 xl:px-6">
          {!recent && !favorites && <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-[repeat(3,305px)]">
            <div ref={newMenuRef} className="relative">
              <button onClick={() => setNewMenu((v) => !v)} aria-expanded={newMenu} aria-haspopup="menu" className="flex h-16 w-full items-center gap-3 rounded-lg border bg-surface px-4 text-left transition-colors hover:bg-hover/50 focus-visible:outline-2 focus-visible:outline-primary">
                <span className="grid size-8 shrink-0 place-items-center"><NewDocGlyph /></span>
                <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{t("新建")}</span><span className="mt-0.5 hidden truncate text-[11px] text-subtle sm:block">{t("新建文档开始协作")}</span></span><ChevronDown size={15} className={`shrink-0 text-subtle ${newMenu ? "rotate-180" : ""}`} />
              </button>{menu}
            </div>
            <HomeUpload uploads={uploads} importing={importing || createWithContent.isPending} onImport={(file) => { void importFile(file); }} />
            <ActionCard icon={<TemplateGlyph />} title={t("模板库")} subtitle={t("选择模板快速新建")} onClick={() => setLibraryOpen(true)} disabled={createWithContent.isPending} />
          </div>}
          {create.isError && <p role="alert" className="mt-3 text-[13px] text-destructive">{t("新建失败，请检查网络后重试。")}</p>}
          {createDriveItem.isError && <p role="alert" className="mt-3 text-[13px] text-destructive">{t("新建结果未能确认，请刷新后检查。")}</p>}
          {importError && <p role="alert" className="mt-3 text-[13px] text-destructive">{importError}</p>}
          {actionError && <p role="alert" className="mt-3 flex items-center gap-2 text-[13px] text-destructive"><span>{actionError}</span><button type="button" aria-label={t("关闭")} onClick={() => setActionError("")}>×</button></p>}
          {copyResult && <div role="status" className="fixed bottom-5 left-1/2 z-[110] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-lg bg-[#30343b] px-4 py-2 text-[13px] text-white shadow-lg"><span>{t("副本已创建")}</span><button type="button" className="whitespace-nowrap text-[#9ab8ff] underline" onClick={() => go(hrefOf(copyResult))}>{t("打开副本")}</button><button type="button" aria-label={t("关闭")} onClick={() => setCopyResult(null)} className="text-white/70 hover:text-white">×</button></div>}
          {actionNotice && <p role="status" className="fixed bottom-5 left-1/2 z-[110] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-[#30343b] px-4 py-2 text-[13px] text-white shadow-lg">{actionNotice}</p>}
          {(createWithContent.isPending || importing) && <p role="status" className="mt-3 text-[13px] text-subtle">{t("正在创建文档…")}</p>}
          {pinnedDocs.length > 0 && <section aria-label={t("置顶文档")} className="mt-5" data-home-pins>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => setPinsCollapsed((v) => !v)} aria-expanded={!pinsCollapsed} className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[13px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground">
                {pinsCollapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}
                <Pin size={13} className="text-[#3370ff]"/>
                <span>{t("置顶文档")}</span>
                <span className="rounded-full bg-sidebar px-1.5 py-0.2 text-[11px] font-normal text-subtle">{pinnedDocs.length}</span>
              </button>
            </div>
            {!pinsCollapsed && <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {pinnedDocs.map((pin) => <div key={pin.id} data-home-pin-card={pin.id} className="group relative flex items-center gap-3 rounded-lg border border-[#dee0e3] bg-surface px-3.5 py-2.5 transition-all hover:border-[#3370ff]/40 hover:shadow-[0_2px_10px_rgba(31,35,41,0.08)]">
                <button type="button" onClick={() => go(hrefOf(pin))} className="flex min-w-0 flex-1 items-center gap-3 pr-7 text-left focus-visible:outline-2 focus-visible:outline-primary">
                  <FileBadge kind={pin.kind ?? "doc"} docType={pin.docType} icon={pin.icon}/>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground group-hover:text-primary">{docTitle(pin)}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-subtle">{pin.workspaceName || me.workspaces.find((w) => w.id === pin.workspaceId)?.name || "—"} · {dateLabel(pin.updatedAt)}</span>
                  </span>
                </button>
                <button type="button" disabled={actionBusy} title={t("取消置顶")} aria-label={`${docTitle(pin)} ${t("取消置顶")}`} onClick={() => void toggleShortcut(pin, "pin")} className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded text-subtle opacity-100 hover:bg-hover hover:text-foreground disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"><PinOff size={14}/></button>
              </div>)}
            </div>}
          </section>}
          {!recent && !favorites ? <div className="mt-5 flex min-h-12 flex-wrap items-end gap-x-3 border-b">
            <nav aria-label={t("文档分类")} className="flex min-w-0 flex-1 basis-full items-center gap-5 overflow-x-auto whitespace-nowrap text-[14px] sm:basis-auto sm:gap-7">
              {([ ["recent", "最近访问"], ["updated", "最近更新"], ["mine", "我创建的"], ["shared", "与我共享"], ["favorites", "收藏"] ] as const).map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`relative shrink-0 pb-3 pt-2 ${selected === id ? "font-medium text-primary after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary" : "text-muted-foreground hover:text-foreground"}`}>{t(label)}</button>)}
            </nav>
            <div className="flex items-center gap-1"><TypeFilter kind={kind} onChange={setKind} /><HomeViewToggle view={view} onChange={setView}/></div>
          </div> : <div className="mt-2 flex min-h-12 items-end justify-between border-b"><div className="pb-3 text-[14px] font-medium">{favorites ? t("收藏的文档") : t("最近访问")}</div><div className="flex items-center gap-1"><TypeFilter kind={kind} onChange={setKind} /><HomeViewToggle view={view} onChange={setView}/></div></div>}
          {chosenDocs.length > 0 && <div role="toolbar" aria-label={t("批量操作")} data-home-batch className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-[#3370ff]/25 bg-[#f0f4ff] px-3 py-1.5 text-[13px] text-foreground">
            <HomeSelectBox checked={chosenDocs.length === items.length ? true : "mixed"} label={chosenDocs.length === items.length ? t("取消全选") : t("全选")} onToggle={() => setSelectedIds(chosenDocs.length === items.length ? new Set() : new Set(items.map((item) => item.id)))}/>
            <span className="ml-1 mr-2 font-medium">{t("已选择 {n} 项", { n: chosenDocs.length })}</span>
            <button type="button" disabled={batchPending} onClick={() => void batchHomeFavorite()} className="inline-flex h-7 items-center gap-1 rounded px-2 hover:bg-white/80 disabled:opacity-40"><Star size={14}/>{t("收藏")}</button>
            <button type="button" disabled={batchPending} onClick={() => void batchHomePin()} className="inline-flex h-7 items-center gap-1 rounded px-2 hover:bg-white/80 disabled:opacity-40"><Pin size={14}/>{t("置顶")}</button>
            <button type="button" disabled={batchPending} onClick={() => void batchHomeTrash()} className="inline-flex h-7 items-center gap-1 rounded px-2 text-destructive hover:bg-white/80 disabled:opacity-40"><Trash2 size={14}/>{t("删除")}</button>
            <button type="button" onClick={() => setSelectedIds(new Set())} className="ml-auto h-7 rounded px-2 text-muted-foreground hover:bg-white/80">{t("取消选择")}</button>
          </div>}
          {view === "list" && chosenDocs.length === 0 && <div className="group/homelist flex h-10 items-center border-b px-2 pr-10 text-[12px] text-subtle">
            <span className="mr-2 shrink-0 opacity-0 focus-within:opacity-100 group-hover/homelist:opacity-100">{items.length > 0 && <HomeSelectBox checked={false} label={t("全选")} onToggle={() => setSelectedIds(new Set(items.map((item) => item.id)))}/>}</span>
            <div className={`${LIST_GRID} min-w-0 flex-1 items-center gap-3`}>
              <span>{t("标题")}</span><span className="hidden truncate lg:block">{t("位置")}</span><span className="hidden truncate sm:block">{t("所有者")}</span><span className="hidden truncate lg:block">{t("创建时间")}</span><span className="truncate">{selected === "recent" ? t("最近访问") : t("最近更新")}</span>
            </div>
          </div>}
          {query.isPending ? <p className="px-2 py-14 text-center text-[13px] text-subtle">{t("加载中…")}</p> : query.isError ? <p role="alert" className="px-2 py-14 text-center text-[13px] text-destructive">{t("加载失败，请检查网络。")} <button type="button" className="underline" onClick={() => void query.refetch()}>{t("重试")}</button></p> : items.length ? view === "grid" ? <div className="grid grid-cols-1 gap-3 pt-4 sm:grid-cols-2 xl:grid-cols-3" data-home-grid>{items.map((d) => <DocumentCard key={d.id} doc={d} selected={selectedIds.has(d.id)} selecting={chosenDocs.length > 0} onSelect={() => setSelectedIds((prev) => toggleId(prev, d.id))} actions={documentActions(d)}/>)}</div> : items.map((d) => <DocumentRow key={d.id} doc={d} selected={selectedIds.has(d.id)} selecting={chosenDocs.length > 0} onSelect={() => setSelectedIds((prev) => toggleId(prev, d.id))} viewedAt={selected === "recent" && "viewedAt" in d && typeof d.viewedAt === "string" ? d.viewedAt : undefined} workspaceName={d.workspaceName || me.workspaces.find((w) => w.id === d.workspaceId)?.name} actions={documentActions(d)} />) : <div className="grid place-items-center px-5 py-20 text-center" data-empty-guide>
            <span className="grid size-14 place-items-center rounded-full bg-sidebar text-subtle">{selected === "favorites" ? <Star size={23} strokeWidth={1.4} /> : <FolderOpen size={24} strokeWidth={1.4} />}</span>
            <p className="mt-4 text-[13px] text-muted-foreground">{kind !== "all" ? t("没有此类型的文档") : selected === "favorites" ? t("还没有收藏的文档") : selected === "shared" ? t("还没有与我共享的文档") : selected === "mine" ? t("暂无我创建的文档") : selected === "recent" ? t("还没有最近访问的文档") : t("暂无文档")}</p>
            {selected === "recent" && kind === "all" && <button onClick={() => create.mutate("doc")} disabled={create.isPending} className="mt-3 text-[13px] text-primary hover:underline">{t("新建文档")}</button>}
          </div>}
        </div>
      </div>
      {sharingDoc && <ShareDialog key={`${me.user.id}:${sharingDoc.id}`} meta={sharingDoc} userId={me.user.id} onClose={() => setSharingDoc(null)}/>}
      {libraryOpen && <TemplateLibrary disabled={createWithContent.isPending} onChoose={chooseTemplate} onClose={() => setLibraryOpen(false)} />}
    </main>
  );
}
function HomeViewToggle({ view, onChange }: { view: HomeView; onChange: (view: HomeView) => void }) {
  return <div role="group" aria-label={t("展示方式")} className="mb-2 flex h-8 items-center rounded-md bg-[#f5f6f7] p-0.5"><button type="button" title={t("列表视图")} aria-label={t("列表视图")} aria-pressed={view === "list"} onClick={() => onChange("list")} className={`grid size-7 place-items-center rounded ${view === "list" ? "bg-white text-[#3370ff] shadow-sm" : "text-[#646a73] hover:bg-white/70"}`}><List size={16}/></button><button type="button" title={t("卡片视图")} aria-label={t("卡片视图")} aria-pressed={view === "grid"} onClick={() => onChange("grid")} className={`grid size-7 place-items-center rounded ${view === "grid" ? "bg-white text-[#3370ff] shadow-sm" : "text-[#646a73] hover:bg-white/70"}`}><Grid2X2 size={15}/></button></div>;
}
function TypeFilter({ kind, onChange }: { kind: string; onChange: (kind: string) => void }) {
  return (
    <FeishuSelect
      value={kind}
      onChange={onChange}
      ariaLabel={t("文档类型")}
      chevronSize={12}
      menuMinWidth={108}
      className="mb-2 h-8 bg-transparent px-2 text-[12px] text-muted-foreground"
      options={[
        { value: "all", label: t("所有类型") },
        { value: "doc", label: t("文档") },
        { value: "sheet", label: t("表格") },
        { value: "board", label: t("画板") },
        { value: "base", label: t("多维表格") },
        { value: "slides", label: t("幻灯片") },
        { value: "survey", label: t("问卷") },
        { value: "file", label: t("文件") },
      ]}
    />
  );
}
function BoardBadge() {
  return <WhiteboardIcon className="size-5 shrink-0 text-[#34c759]" />;
}

function FileBadge({ kind, docType, icon, large = false }: { kind: "doc" | "base" | "slides" | "sheet" | "survey" | "folder" | "file"; docType?: string; icon?: string; large?: boolean }) {
  const sizeClass = large ? "size-14" : "size-5";
  if (kind === "folder") return <Folder size={large ? 56 : 20} fill="#ffcc4d" stroke="#f5a623" />;
  if (kind === "sheet") return <SheetColorIcon className={`${sizeClass} shrink-0`} />;
  if (kind === "survey") return <span className={`grid ${sizeClass} shrink-0 place-items-center rounded bg-violet-600 text-white`}><ClipboardList size={large ? 32 : 13} /></span>;
  if (kind === "slides") return <SlidesColorIcon className={`${sizeClass} shrink-0`} />;
  if (kind === "file") return <span className={`grid ${sizeClass} shrink-0 place-items-center rounded bg-[#e8efff] text-[#3370ff]`}><FileText size={large ? 36 : 15}/></span>;
  if (isBoardDoc({ kind, docType })) return <DocumentGlyph icon={icon} className={`${sizeClass} ${large ? "text-[48px]" : "text-[18px]"}`} fallback={<WhiteboardIcon className={`${sizeClass} shrink-0 text-[#34c759]`} />} />;
  return kind === "doc" ? <DocumentGlyph icon={icon} className={`${sizeClass} ${large ? "text-[48px]" : "text-[18px]"}`} fallback={<DocColorIcon className={`${sizeClass} shrink-0`} />} /> : <BaseColorIcon className={`${sizeClass} shrink-0`} />;
}
function ActionCard({ icon, title, subtitle, disabled, onClick }: { icon: React.ReactNode; title: string; subtitle?: string; disabled?: boolean; onClick: () => void }) {
  return <button onClick={onClick} disabled={disabled} className="flex h-16 w-full items-center gap-3 rounded-lg border bg-surface px-4 text-left transition-colors hover:bg-hover/50 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"><span className="grid size-8 shrink-0 place-items-center">{icon}</span><span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{title}</span>{subtitle && <span className="mt-0.5 hidden truncate text-[11px] text-subtle sm:block">{subtitle}</span>}</span></button>;
}
function dateLabel(value: string) {
  return formatDriveTime(value) || "—";
}
function HomeSelectBox({ checked, label, onToggle }: { checked: boolean | "mixed"; label: string; onToggle: () => void }) {
  return <button type="button" role="checkbox" aria-checked={checked} aria-label={label} title={label} onClick={(event) => { event.stopPropagation(); onToggle(); }} className="grid size-5 shrink-0 place-items-center" data-home-select>
    <span className={`grid size-4 place-items-center rounded-[3px] border ${checked ? "border-[#3370ff] bg-[#3370ff] text-white" : "border-[#bbbfc4] bg-white hover:border-[#3370ff]"}`}>{checked === "mixed" ? <span className="h-0.5 w-2 rounded bg-white"/> : checked ? <Check size={12} strokeWidth={3}/> : null}</span>
  </button>;
}
function DocumentRow({ doc, selected, selecting, onSelect, viewedAt, workspaceName, actions }: { doc: DocMeta; selected: boolean; selecting: boolean; onSelect: () => void; viewedAt?: string; workspaceName?: string; actions: React.ReactNode }) {
  return <div className={`group relative flex items-center border-b px-2 pr-10 transition-colors ${selected ? "bg-[#f0f4ff]" : "hover:bg-hover/60"}`} data-home-row={doc.id} aria-selected={selected}>
    <span className={`mr-2 shrink-0 ${!selected && !selecting ? "opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" : ""}`}><HomeSelectBox checked={selected} label={t("选择「{title}」", { title: docTitle(doc) })} onToggle={onSelect}/></span>
    <button type="button" onClick={() => go(hrefOf(doc))} className={`${LIST_GRID} h-14 min-w-0 flex-1 items-center gap-3 text-left focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-primary`}>
      <span className="flex min-w-0 items-center gap-3"><FileBadge kind={doc.kind ?? "doc"} docType={doc.docType} icon={doc.icon} /><span className="truncate text-[13px] group-hover:text-primary">{docTitle(doc)}</span></span>
      <span className="hidden min-w-0 truncate text-[12px] text-muted-foreground lg:block">{workspaceName || "—"}</span>
      <span className="hidden min-w-0 items-center gap-2 truncate text-[12px] text-muted-foreground sm:flex"><Avatar name={doc.creatorName || t("未知")} color={colorFor(doc.creatorId - 1)} size={20} /><span className="truncate">{doc.creatorName || "—"}</span></span>
      <span className="hidden truncate text-[12px] text-subtle lg:block">{dateLabel(doc.createdAt)}</span>
      <span className="truncate text-[12px] text-subtle">{dateLabel(viewedAt ?? doc.updatedAt)}</span>
    </button>
    <span className="absolute right-1 top-3 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">{actions}</span>
  </div>;
}

function DocumentCard({ doc, selected, selecting, onSelect, actions }: { doc: DocMeta; selected: boolean; selecting: boolean; onSelect: () => void; actions: React.ReactNode }) {
  return <div className={`group relative min-w-0 overflow-hidden rounded-md border bg-white transition-all hover:shadow-[0_3px_12px_rgba(31,35,41,0.12)] ${selected ? "border-[#3370ff] ring-1 ring-[#3370ff]/30" : "border-[#dee0e3]"}`} data-home-card={doc.id} aria-selected={selected}>
    <span className={`absolute left-2.5 top-2.5 z-10 ${!selected && !selecting ? "opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" : ""}`}><HomeSelectBox checked={selected} label={t("选择「{title}」", { title: docTitle(doc) })} onToggle={onSelect}/></span>
    <button type="button" onClick={() => go(hrefOf(doc))} className="block w-full text-left focus-visible:outline-2 focus-visible:outline-primary">
      <span className={`grid h-36 place-items-center ${selected ? "bg-[#f0f4ff]" : "bg-[#f5f6f7]"}`}><FileBadge kind={doc.kind ?? "doc"} docType={doc.docType} icon={doc.icon} large/></span>
      <span className="flex h-[54px] items-center gap-3 border-t border-[#e5e6eb] pl-3 pr-10"><FileBadge kind={doc.kind ?? "doc"} docType={doc.docType} icon={doc.icon}/><span className="min-w-0 flex-1"><span className="block truncate text-[13px] text-foreground group-hover:text-primary">{docTitle(doc)}</span><span className="mt-0.5 block truncate text-[11px] text-subtle">{doc.creatorName || "—"} {t("最近修改于")} {dateLabel(doc.updatedAt)}</span></span></span>
    </button>
    <span className="absolute bottom-[11px] right-1">{actions}</span>
  </div>;
}
