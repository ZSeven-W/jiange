import { useCallback, useEffect, useState } from "react";
import { FileText, FolderTree, Plus, RefreshCw, Trash2 } from "lucide-react";
import { docsApi, subpagesApi, type DocSubpage } from "@/lib/api";

function subpageHref(item: DocSubpage): string {
  if (item.kind === "sheet") return `#/sheet/${item.id}`;
  if (item.kind === "base") return `#/base/${item.id}`;
  if (item.kind === "slides") return `#/slides/${item.id}`;
  if (item.kind === "file") return `#/file/${item.id}`;
  return `#/doc/${item.id}`;
}

export function SubpagesBlockView({
  docId,
  readOnly,
  onDelete,
}: {
  docId?: number;
  readOnly?: boolean;
  onDelete?: () => void;
}) {
  const [items, setItems] = useState<DocSubpage[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!docId) return;
    setLoading(true);
    try {
      const list = await subpagesApi.list(docId);
      setItems(list);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载子页面列表失败");
    } finally {
      setLoading(false);
    }
  }, [docId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreateChild = async () => {
    if (!docId || creating) return;
    setCreating(true);
    try {
      await docsApi.create("未命名子页面", docId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "新建子页面失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div contentEditable={false} data-subpages-block className="my-2 rounded-lg border bg-sidebar/30 p-3.5 text-[13px]">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <FolderTree size={15} className="text-primary" />
          <span>子页面列表</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
            {items.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!readOnly && docId && (
            <button
              type="button"
              disabled={creating}
              onClick={() => void handleCreateChild()}
              data-create-subpage
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-[12px] text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              <Plus size={13} />新建子页面
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            title="刷新子页面列表"
            data-refresh-subpages
            className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          </button>
          {!readOnly && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="删除子页面列表块"
              className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {error && <p className="mb-2 text-[12px] text-destructive">{error}</p>}

      {items.length === 0 ? (
        <div className="rounded border border-dashed py-4 text-center text-[12px] text-muted-foreground">
          {loading ? "正在加载子页面…" : "当前文档暂无可见子页面（按阅读权限自动过滤）"}
        </div>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id} data-subpage-item={item.id}>
              <a
                href={subpageHref(item)}
                className="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-foreground transition-colors hover:bg-hover"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText size={14} className="shrink-0 text-primary" />
                  <span className="truncate font-medium">{item.title || "未命名文档"}</span>
                </span>
                <span className="shrink-0 text-[11px] text-subtle">
                  {item.updatedAt ? item.updatedAt.slice(0, 10) : ""}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
