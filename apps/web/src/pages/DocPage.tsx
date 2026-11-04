import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpId, SyncStatus } from "@jiange/collab";
import { docsApi, type DocMeta, type Me } from "@/lib/api";
import { colorFor, type Presence } from "@/lib/presence";
import { useSyncDoc, type RemotePeer } from "@/lib/useSyncDoc";
import { CollabText } from "@/components/CollabText";
import { Editor } from "@/editor/Editor";
import { Avatar } from "@/components/brand";
import { BaseIcon, docTitle, DocIcon } from "@/components/Sidebar";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./NotificationBell";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/ShareDialog";
import { VersionPanel } from "./VersionPanel";
import { CommentsPanel, type CommentAnchor } from "./CommentsPanel";
import { commentsApi, extrasApi } from "@/lib/api";
import { viewToMarkdown } from "@/lib/markdown";
import { importMarkdownOps } from "@/lib/mdImport";

// Every document starts with these two blocks (server: syncsrv.InitialOps).
const TITLE: OpId = { client: 0, clock: 1 };

export function DocPage({ id, me }: { id: number; me: Me }) {
  const qc = useQueryClient();
  const meta = useQuery({
    queryKey: ["doc", id],
    queryFn: () => docsApi.get(id),
  });
  const sync = useSyncDoc(id);
  const presence = useMemo<Presence>(() => ({ name: me.user.name, color: colorFor(me.user.id - 1) }), [me.user]);
  const body = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);
  const [history, setHistory] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [draft, setDraft] = useState<CommentAnchor | null>(null);
  const [activeThread, setActiveThread] = useState<number | null>(null);
  const comments = useQuery({ queryKey: ["comments", id], queryFn: () => commentsApi.list(id) });
  const ancestors = useQuery({ queryKey: ["ancestors", id], queryFn: () => extrasApi.ancestors(id) });
  const exportMd = () => {
    const d = sync.client.doc;
    if (!d) return;
    const md = viewToMarkdown(d.view());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = `${(title || meta.data?.title || "未命名").trim() || "未命名"}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importMd = async (file: File) => {
    const d = sync.client.doc;
    if (!d) return;
    const md = await file.text();
    if (!confirm(`导入将替换当前文档内容（可用撤销恢复），继续？`)) return;
    const tx = importMarkdownOps(d, md);
    if (tx.ops.length) sync.client.push(tx.ops);
  };
  const allDocs = useQuery({ queryKey: ["docs"], queryFn: docsApi.list });
  const mentionDocs = useMemo(() => (allDocs.data ?? []).filter((d) => d.id !== id).map((d) => ({ id: d.id, title: d.title })), [allDocs.data, id]);
  const readOnly = meta.data?.role === "view";

  useEffect(() => {
    qc.invalidateQueries({ queryKey: ["docs"] });
  }, [qc, id]);
  useEffect(() => {
    sync.client.setAwareness({ ...presence, cursor: null });
  }, [sync.client, presence]);

  // mirror the collaborative title into directory metadata (debounced)
  const renameTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onTitle = (t: string) => {
    clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(async () => {
      const d = await docsApi.rename(id, t);
      qc.setQueryData(["doc", id], d);
      qc.setQueryData<DocMeta[]>(["docs"], (old) => old?.map((x) => (x.id === id ? d : x)));
    }, 400);
  };
  const live = sync.client.doc?.hasBlock(TITLE) ? sync.client.doc : null;
  const title = live ? live.text(TITLE) : (meta.data?.title ?? "");
  useEffect(() => {
    document.title = `${title.trim() || "未命名文档"} - Jiange`;
  }, [title]);

  if (meta.isError) return <div className="grid flex-1 place-items-center text-muted-foreground">文档不存在或无权访问</div>;

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          ancestors={ancestors.data ?? []}
          onShare={() => setSharing((v) => !v)}
          onHistory={() => setHistory((v) => !v)}
          onExport={exportMd}
          onImport={importMd}
          readOnly={readOnly}
          meta={meta.data}
          title={title}
          workspace={meta.data?.workspaceName || me.workspaces[0]?.name || "我的空间"}
          status={sync.status}
          peers={sync.peers}
          me={presence}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <article className="mx-auto max-w-[820px] px-16 pb-40 pt-14">
            <CollabText
              sync={sync}
              block={TITLE}
              me={presence}
              singleLine
              readOnly={readOnly}
              placeholder="请输入标题"
              onLocalEdit={onTitle}
              onEnter={() => body.current?.querySelector<HTMLElement>("[data-editor]")?.focus()}
              className="text-[34px] font-semibold leading-[1.3] tracking-tight [&_textarea]:font-semibold [&_textarea]:leading-[1.3]"
            />
            <div className="mt-4 flex items-center gap-2 text-[13px] text-subtle">
              {meta.data && (
                <>
                  <Avatar name={meta.data.creatorName} color={colorFor(meta.data.creatorId - 1)} size={18} />
                  <span>{meta.data.creatorName}</span>
                  <span>·</span>
                  <span>最近修改于 {formatTime(meta.data.updatedAt)}</span>
                </>
              )}
            </div>
            <div ref={body} className="mt-8 pl-1">
              <Editor
                sync={sync}
                me={presence}
                readOnly={readOnly}
                docs={mentionDocs}
                upload={readOnly ? undefined : (f) => docsApi.upload(id, f)}
                comments={comments.data ?? []}
                activeThread={activeThread}
                onActivateThread={(cid) => {
                  setActiveThread(cid);
                  if (cid !== null) setCommentsOpen(true);
                }}
                onComment={(anchor) => {
                  setDraft(anchor);
                  setCommentsOpen(true);
                }}
              />
            </div>
          </article>
        </div>
      </div>
      {sharing && meta.data && <ShareDialog meta={meta.data} onClose={() => setSharing(false)} />}
      {history && <VersionPanel id={id} canEdit={!readOnly} onClose={() => setHistory(false)} />}
      {commentsOpen && (
        <CommentsPanel
          id={id}
          meId={me.user.id}
          canEdit={!readOnly}
          draft={draft}
          activeThread={activeThread}
          onActivate={setActiveThread}
          onClose={() => {
            setCommentsOpen(false);
            setDraft(null);
            setActiveThread(null);
          }}
        />
      )}
    </div>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return d.toDateString() === now.toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

const STATUS: Record<SyncStatus, { label: string; color: string }> = {
  synced: { label: "已同步", color: "#00B42A" },
  syncing: { label: "同步中…", color: "#3370FF" },
  connecting: { label: "连接中…", color: "#FF8800" },
  offline: { label: "离线，恢复后自动同步", color: "#8F959E" },
};

function TopBar({
  ancestors,
  meta,
  title,
  workspace,
  status,
  peers,
  me,
  onShare,
  onHistory,
  onExport,
  onImport,
  readOnly,
}: {
  ancestors: import("@/lib/api").DocMeta[];
  onShare: () => void;
  onHistory: () => void;
  onExport: () => void;
  onImport: (f: File) => void;
  readOnly: boolean;
  meta?: DocMeta;
  title: string;
  workspace: string;
  status: SyncStatus;
  peers: RemotePeer[];
  me: Presence;
}) {
  const s = STATUS[status];
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b px-4">
      <nav className="flex min-w-0 items-center gap-1.5 text-[14px]">
        <a href="#/" className="truncate text-muted-foreground hover:text-foreground">
          {workspace}
        </a>
        <span className="shrink-0 text-primary">
          {meta?.kind === "base" ? <BaseIcon /> : <DocIcon />}
        </span>
        {ancestors.map((a) => (
          <span key={a.id} className="flex min-w-0 items-center gap-1.5">
            <span className="text-subtle">/</span>
            <a href={a.kind === "base" ? `#/base/${a.id}` : `#/doc/${a.id}`} className="truncate text-muted-foreground hover:text-foreground">
              {docTitle(a)}
            </a>
          </span>
        ))}
        <span className="text-subtle">/</span>
        <span className="truncate font-medium text-foreground">{meta ? docTitle({ title }) : "…"}</span>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <NotificationBell onOpenDoc={(id) => (location.hash = `#/doc/${id}`)} />
        <div className="mr-1 flex items-center -space-x-1.5" aria-label="协作者">
          <Avatar name={me.name} color={me.color} size={26} ring title={`${me.name}（你）`} />
          {peers.slice(0, 5).map((p) => (
            <Avatar key={p.clientId} name={p.state.name} color={p.state.color} size={26} ring />
          ))}
          {peers.length > 5 && <span className="grid size-[26px] place-items-center rounded-full bg-hover text-[11px] ring-2 ring-white">+{peers.length - 5}</span>}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-xs text-subtle" data-status={status}>
          <span className="size-1.5 rounded-full" style={{ background: s.color }} />
          {s.label}
        </span>
        {meta && <StarButton docId={meta.id} />}
        {readOnly && <span className="rounded bg-hover px-2 py-0.5 text-xs text-muted-foreground">只读</span>}
        <Button size="sm" className="h-8 px-4" onClick={onShare}>
          分享
        </Button>
        <DocMenu meta={meta} onHistory={onHistory} onExport={onExport} onImport={onImport} />
      </div>
    </header>
  );
}

/** 收藏星标：同步 favorites 查询缓存。 */
function StarButton({ docId }: { docId: number }) {
  const qc = useQueryClient();
  const favs = useQuery({ queryKey: ["favorites"], queryFn: () => extrasApi.favorites() });
  const starred = favs.data?.some((d) => d.id === docId) ?? false;
  return (
    <button
      className={cn("grid size-8 place-items-center rounded-md hover:bg-hover", starred ? "text-amber-400" : "text-muted-foreground hover:text-foreground")}
      title={starred ? "取消收藏" : "收藏"}
      onClick={() => {
        (starred ? extrasApi.unstar(docId) : extrasApi.star(docId)).then(() => qc.invalidateQueries({ queryKey: ["favorites"] }));
      }}
      data-star-doc
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill={starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
        <path d="m8 2 1.7 3.4 3.8.6-2.7 2.6.6 3.8L8 10.6l-3.4 1.8.6-3.8L2.5 6l3.8-.6z" />
      </svg>
    </button>
  );
}

function DocMenu({
  meta,
  onHistory,
  onExport,
  onImport,
}: {
  meta?: DocMeta;
  onHistory: () => void;
  onExport: () => void;
  onImport: (f: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const close = () => setOpen(false);
  const trash = async () => {
    if (!meta) return;
    await docsApi.trash(meta.id);
    qc.invalidateQueries({ queryKey: ["docs"] });
    location.hash = "#/";
  };
  const toRoot = async () => {
    if (!meta) return;
    await docsApi.move(meta.id, null);
    qc.invalidateQueries({ queryKey: ["docs"] });
    setOpen(false);
  };
  const item = "block w-full rounded px-3 py-1.5 text-left text-[13px] hover:bg-hover";
  return (
    <div className="relative">
      <button className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground" title="更多" onClick={() => setOpen((o) => !o)} data-more-menu>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-44 rounded-lg border bg-surface p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          {onHistory && (
            <button className={item} onClick={() => { close(); onHistory(); }}>
              历史版本
            </button>
          )}
          {onExport && (
            <button className={item} onClick={() => { close(); onExport(); }}>
              导出 Markdown
            </button>
          )}
          {onImport && (
            <label className={cn(item, "block cursor-pointer")} data-import-md>
              导入 Markdown
              <input
                type="file"
                accept=".md,.markdown,text/markdown"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onImport(f);
                  e.target.value = "";
                  close();
                }}
              />
            </label>
          )}
          {meta?.parentId && <div className="my-1 border-t" />}
          {meta?.parentId && (
            <button className={item} onClick={toRoot}>
              移到顶层
            </button>
          )}
          <button className="block w-full rounded px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-hover" onClick={trash}>
            删除（移到回收站）
          </button>
        </div>
      )}
    </div>
  );
}
