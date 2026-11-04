import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { docsApi, extrasApi, type Me } from "@/lib/api";
import { go } from "@/lib/route";
import { BaseIcon, DocIcon, docTitle, hrefOf } from "@/components/Sidebar";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";

export function Home({ me, recent, favorites }: { me: Me; recent?: boolean; favorites?: boolean }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ["docs"], queryFn: docsApi.list });
  const favs = useQuery({ queryKey: ["favorites"], queryFn: () => extrasApi.favorites(), enabled: !!favorites });
  const create = useMutation({
    mutationFn: () => docsApi.create(""),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["docs"] });
      go(`#/doc/${d.id}`);
    },
  });
  const hour = new Date().getHours();
  const hello = hour < 12 ? "上午好" : hour < 18 ? "下午好" : "晚上好";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center border-b px-6 text-[14px] font-medium">{favorites ? "收藏" : recent ? "最近访问" : "主页"}</header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[880px] px-10 py-10">
          {!recent && (
            <div className="mb-10 flex items-end justify-between">
              <div>
                <h1 className="text-[26px] font-semibold">
                  {hello}，{me.user.name}
                </h1>
                <p className="mt-2 text-[14px] text-muted-foreground">从一篇新文档开始，邀请同事一起编辑。</p>
              </div>
              <Button onClick={() => create.mutate()}>+ 新建文档</Button>
            </div>
          )}
          <h2 className="mb-3 text-[13px] font-medium text-subtle">{favorites ? "收藏的文档" : "最近更新"}</h2>
          <div className="overflow-hidden rounded-lg border">
            {(favorites ? favs.data ?? [] : docs.data ?? []).map((d) => (
              <button key={d.id} onClick={() => go(hrefOf(d))} className="flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-sidebar">
                <span className="text-primary">
                  {d.kind === "base" ? <BaseIcon /> : <DocIcon />}
                </span>
                <span className={d.title.trim() ? "truncate" : "truncate text-muted-foreground"}>{docTitle(d)}</span>
                <span className="ml-auto shrink-0 text-xs text-subtle">{new Date(d.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span>
              </button>
            ))}
            {favorites
              ? (favs.data?.length ?? 0) === 0 && <p className="px-4 py-10 text-center text-[13px] text-subtle">还没有收藏，悬停文档树点击 ☆</p>
              : docs.data?.length === 0 && (
                  <div className="grid place-items-center border-b px-4 py-14 text-center" data-empty-guide>
                    <div className="grid size-14 place-items-center rounded-2xl bg-accent text-primary"><FileText size={26} strokeWidth={1.5} /></div>
                    <p className="mt-3 text-[14px] font-medium text-foreground">从这里开始你的第一篇文档</p>
                    <p className="mt-1 max-w-[320px] text-[13px] leading-5 text-subtle">
                      输入 <kbd className="rounded border bg-hover px-1">/</kbd> 唤起菜单快速插入标题、列表、表格；输入
                      <kbd className="mx-0.5 rounded border bg-hover px-1">@</kbd> 提及文档，选中文字即可评论。
                    </p>
                  </div>
                )}
          </div>
        </div>
      </div>
    </div>
  );
}
