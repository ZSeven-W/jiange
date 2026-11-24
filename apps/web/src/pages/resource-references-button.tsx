import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Network, RefreshCw, X } from "lucide-react";
import { navigateDocumentHash } from "@/editor/block-handle";
import { useI18n } from "@/lib/i18n";
import {
  fetchDocumentReferenceGraph,
  fetchDocumentReferences,
  referenceContextHref,
  ReferenceKindIcon,
  referenceKindMeta,
  referenceNodeHref,
} from "./document-references";
import { DocumentReferenceGraph } from "./document-reference-graph";

export function ResourceReferencesButton({
  id,
  userId,
  title,
  kind,
  docType,
  className,
}: {
  id: number;
  userId: number;
  title: string;
  kind: "sheet" | "base" | "slides" | "survey";
  docType?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [tab, setTab] = useState<"incoming" | "outgoing">("incoming");
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const query = useQuery({
    queryKey: ["document-references", userId, id],
    queryFn: ({ signal }) => fetchDocumentReferences(id, userId, signal),
    enabled: drawerOpen && !graphOpen && id > 0 && userId > 0,
    retry: false,
  });

  const toggle = (key: number) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openHash = (e: React.MouseEvent<HTMLAnchorElement>, hash: string) => {
    e.preventDefault();
    setDrawerOpen(false);
    navigateDocumentHash(hash);
  };

  const data = query.isSuccess && !query.isFetching ? query.data : undefined;

  return (
    <>
      <button
        type="button"
        data-resource-references-btn
        aria-label={t("双向链接与关系图")}
        title={t("双向链接与关系图")}
        onClick={() => setDrawerOpen(true)}
        className={
          className ??
          "inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-[#646A73] hover:bg-[#F2F3F5] hover:text-[#1F2329] dark:text-muted-foreground dark:hover:bg-hover dark:hover:text-foreground"
        }
      >
        <Network size={15} />
        <span className="hidden md:inline">{t("引用")}</span>
      </button>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/25"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDrawerOpen(false);
          }}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t("双向链接")}
            data-resource-references-drawer
            className="flex h-full w-full max-w-[380px] flex-col bg-surface text-foreground shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Network size={16} className="text-[#3370FF]" />
              <h2 className="text-[15px] font-medium">{t("双向链接")}</h2>
              <button
                type="button"
                data-open-reference-graph
                onClick={() => {
                  setDrawerOpen(false);
                  setGraphOpen(true);
                }}
                className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-[#3370FF] hover:bg-hover"
              >
                <Network size={13} />
                {t("关系图")}
              </button>
              <button
                type="button"
                aria-label={t("刷新双向链接")}
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover disabled:opacity-40"
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                aria-label={t("关闭双向链接")}
                onClick={() => setDrawerOpen(false)}
                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex border-b border-border px-4 text-[13px]">
              <button
                type="button"
                onClick={() => setTab("incoming")}
                className={`relative py-2.5 pr-4 ${tab === "incoming" ? "font-medium text-[#3370FF] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#3370FF]" : "text-muted-foreground"}`}
              >
                {data ? t("反向引用 ({n})", { n: data.incoming.length }) : t("反向引用")}
              </button>
              <button
                type="button"
                onClick={() => setTab("outgoing")}
                className={`relative px-4 py-2.5 ${tab === "outgoing" ? "font-medium text-[#3370FF] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#3370FF]" : "text-muted-foreground"}`}
              >
                {data ? t("本页引用 ({n})", { n: data.outgoing.length }) : t("本页引用")}
              </button>
            </div>

            <div className="flex-1 overflow-auto p-3 text-[13px]">
              {(query.isFetching || query.isPending) && (
                <p role="status" className="py-6 text-center text-muted-foreground">
                  {t("正在加载引用关系…")}
                </p>
              )}
              {query.isError && !query.isFetching && (
                <p role="alert" className="py-6 text-center text-muted-foreground">
                  {t("引用查询未完成，请点击刷新重试。")}
                </p>
              )}
              {data && tab === "incoming" && (
                data.incoming.length === 0 ? (
                  <p className="py-6 text-center text-muted-foreground">{t("暂无其他资源引用当前内容")}</p>
                ) : (
                  <div className="space-y-1">
                    {data.incoming.map((item) => {
                      const href = referenceNodeHref(item);
                      const km = referenceKindMeta(item.kind, item.docType);
                      return (
                        <div key={item.id} className="rounded-md hover:bg-hover" data-reference-incoming-item={item.id}>
                          <div className="flex min-w-0 items-center px-1 py-1">
                            <button
                              type="button"
                              aria-expanded={expanded.has(item.id)}
                              onClick={() => toggle(item.id)}
                              className="grid size-6 shrink-0 place-items-center text-muted-foreground"
                            >
                              {expanded.has(item.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                            <ReferenceKindIcon kind={item.kind} docType={item.docType} />
                            <a
                              href={href}
                              onClick={(e) => openHash(e, href)}
                              className="min-w-0 flex-1 truncate pl-1.5 text-[#3370FF] hover:underline"
                            >
                              {item.title.trim() || t("未命名文档")}
                            </a>
                            <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-muted-foreground dark:bg-white/10">
                              {km.short}
                            </span>
                            {item.relationKind === "embed" && (
                              <span className="ml-1 shrink-0 rounded bg-[#EEF2FF] px-1.5 py-0.5 text-[11px] font-medium text-[#5B4CE6] dark:bg-indigo-500/20 dark:text-indigo-300">
                                {t("内嵌")}
                              </span>
                            )}
                          </div>
                          {expanded.has(item.id) && (
                            <div className="pb-1.5 pl-8 pr-2">
                              {item.contexts?.map((ctx) => {
                                const chref = referenceContextHref(item, ctx.block);
                                return (
                                  <a
                                    key={ctx.block}
                                    href={chref}
                                    onClick={(e) => openHash(e, chref)}
                                    className="block truncate rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-[#E5EDFF] hover:text-[#1456F0]"
                                  >
                                    • {ctx.text || t("查看引用位置")}
                                  </a>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )
              )}
              {data && tab === "outgoing" && (
                data.outgoing.length === 0 ? (
                  <p className="py-6 text-center text-muted-foreground">{t("当前内容暂未引用其他资源")}</p>
                ) : (
                  <div className="space-y-1">
                    {data.outgoing.map((item) => {
                      const href = referenceNodeHref(item);
                      const km = referenceKindMeta(item.kind, item.docType);
                      return (
                        <div key={item.id} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-hover" data-reference-outgoing-item={item.id}>
                          <ReferenceKindIcon kind={item.kind} docType={item.docType} />
                          <a href={href} onClick={(e) => openHash(e, href)} className="min-w-0 flex-1 truncate text-[#3370FF] hover:underline">
                            {item.title.trim() || t("未命名文档")}
                          </a>
                          <span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-muted-foreground dark:bg-white/10">
                            {km.short}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>
          </aside>
        </div>
      )}

      {graphOpen && (
        <DocumentReferenceGraph
          rootId={id}
          rootTitle={title}
          rootKind={kind}
          rootDocType={docType}
          userId={userId}
          enabled
          loadReferences={fetchDocumentReferences}
          loadGraph={fetchDocumentReferenceGraph}
          onClose={() => setGraphOpen(false)}
        />
      )}
    </>
  );
}
