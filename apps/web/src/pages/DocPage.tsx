import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpId, SyncStatus } from "@jiange/collab";
import { docsApi, type DocMeta, type Me } from "@/lib/api";
import { colorFor, type Presence } from "@/lib/presence";
import { useSyncDoc, type RemotePeer } from "@/lib/useSyncDoc";
import { CollabText } from "@/components/CollabText";
import { Editor } from "@/editor/Editor";
import { Avatar } from "@/components/brand";
import { docTitle } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/ShareDialog";

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
          onShare={() => setSharing((v) => !v)}
          readOnly={readOnly}
          meta={meta.data}
          title={title}
          workspace={me.workspaces[0]?.name ?? ""}
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
              className="text-[34px] font-bold leading-[1.3] tracking-tight [&_textarea]:leading-[1.3]"
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
              <Editor sync={sync} me={presence} readOnly={readOnly} docs={mentionDocs} upload={readOnly ? undefined : (f) => docsApi.upload(id, f)} />
            </div>
          </article>
        </div>
      </div>
      {sharing && meta.data && <ShareDialog meta={meta.data} onClose={() => setSharing(false)} />}
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
  meta,
  title,
  workspace,
  status,
  peers,
  me,
  onShare,
  readOnly,
}: {
  onShare: () => void;
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
        <span className="text-subtle">/</span>
        <span className="truncate font-medium">{meta ? docTitle({ title }) : "…"}</span>
      </nav>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-subtle" data-status={status}>
        <span className="size-1.5 rounded-full" style={{ background: s.color }} />
        {s.label}
      </span>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center -space-x-1.5" aria-label="协作者">
          <Avatar name={me.name} color={me.color} size={26} ring title={`${me.name}（你）`} />
          {peers.slice(0, 5).map((p) => (
            <Avatar key={p.clientId} name={p.state.name} color={p.state.color} size={26} ring />
          ))}
          {peers.length > 5 && <span className="grid size-[26px] place-items-center rounded-full bg-hover text-[11px] ring-2 ring-white">+{peers.length - 5}</span>}
        </div>
        {readOnly && <span className="rounded bg-hover px-2 py-0.5 text-xs text-muted-foreground">只读</span>}
        <Button size="sm" className="h-8 px-4" onClick={onShare}>
          分享
        </Button>
        {meta?.role === "manage" && <DocMenu meta={meta} />}
      </div>
    </header>
  );
}

function DocMenu({ meta }: { meta?: DocMeta }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
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
  return (
    <div className="relative">
      <button className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover" title="更多" onClick={() => setOpen((o) => !o)}>
        ···
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-40 rounded-lg border bg-white p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          {meta?.parentId && (
            <button className="block w-full rounded px-3 py-1.5 text-left text-[13px] hover:bg-hover" onClick={toRoot}>
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
