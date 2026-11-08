import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { slidesApi, type SlidesPage as Page } from "@/lib/api";
import { ask } from "@/components/ui/ask";
import { cn } from "@/lib/utils";
import { CopyIcon, PlusIcon, PresentationIcon, Trash2Icon } from "lucide-react";

/** 幻灯片（首个纵切）：页面列表（新增/复制/删除/移动）+ 画布（标题/要点/背景色）+ 放映模式（方向键翻页）。 */
export function SlidesDeck({ deckId }: { deckId: number }) {
  const qc = useQueryClient();
  const pages = useQuery({ queryKey: ["slides", deckId], queryFn: () => slidesApi.pages(deckId) });
  const [current, setCurrent] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["slides", deckId] });

  const create = useMutation({ mutationFn: (title: string) => slidesApi.create(deckId, title), onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, title, body, background }: { id: number; title: string; body: string; background: string }) =>
      slidesApi.update(id, title, body, background),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (pid: number) => slidesApi.remove(pid), onSuccess: invalidate });

  const list = pages.data ?? [];
  const active = list.find((p) => p.id === current) ?? list[0] ?? null;

  // 放映模式：方向键翻页，Esc 退出
  useEffect(() => {
    if (!playing) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlaying(false);
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const i = active ? list.findIndex((p) => p.id === active.id) : -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        if (i >= 0 && i < list.length - 1) setCurrent(list[i + 1].id);
      } else if (i > 0) setCurrent(list[i - 1].id);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [playing, active, list]);

  if (pages.isError) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-subtle">无法访问该演示文稿（可能已删除或无权限）</div>;
  }

  if (playing && active) {
    return (
      <div className="fixed inset-0 z-[80] flex flex-col items-center justify-center px-16 text-center" style={{ background: active.background || "#111" }} data-slides-playing>
        <h1 className="max-w-[80%] text-[44px] font-bold leading-tight text-white" data-slides-play-title>{active.title || "未命名"}</h1>
        <ul className="mt-10 space-y-3 text-[22px] leading-relaxed text-white/90">
          {active.body.split("\n").filter((l) => l.trim()).map((line, i) => (
            <li key={i}>• {line}</li>
          ))}
        </ul>
        <p className="absolute bottom-6 text-[12px] text-white/40">
          ←/→ 翻页 · Esc 退出 · {list.findIndex((p) => p.id === active.id) + 1}/{list.length}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="flex w-[200px] shrink-0 flex-col border-r" data-slides-list>
        <div className="flex items-center justify-between px-3 py-2 text-[13px] font-medium">
          页面
          <button
            className="flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[12px] text-white hover:opacity-90"
            onClick={() => create.mutate("未命名页")}
            data-slides-add
          >
            <PlusIcon size={13} strokeWidth={1.8} /> 新页
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {list.map((p, i) => (
            <div
              key={p.id}
              className={cn("group mb-2 flex cursor-pointer flex-col gap-1 rounded-lg border p-2 text-left", active?.id === p.id ? "border-primary" : "hover:bg-hover/60")}
              onClick={() => setCurrent(p.id)}
              data-slides-page={p.id}
            >
              <div className="flex items-center gap-1.5 text-[11px] text-subtle">
                <span className="w-4 text-center">{i + 1}</span>
                <span className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100">
                  <button
                    className="rounded p-0.5 hover:text-primary"
                    title="上移"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (i === 0) return;
                      slidesApi.move(p.id, (list[i - 1].pos + (i > 1 ? list[i - 2].pos : 0)) / 2).then(invalidate);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    className="rounded p-0.5 hover:text-primary"
                    title="下移"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (i === list.length - 1) return;
                      slidesApi.move(p.id, (list[i + 1].pos + (i + 2 < list.length ? list[i + 2].pos : list[i + 1].pos + 1)) / 2).then(invalidate);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    className="rounded p-0.5 hover:text-primary"
                    title="复制此页"
                    onClick={(e) => {
                      e.stopPropagation();
                      slidesApi.create(deckId, p.title).then((copy) => slidesApi.update(copy.id, p.title, p.body, p.background)).then(invalidate);
                    }}
                  >
                    <CopyIcon size={12} strokeWidth={1.8} />
                  </button>
                  <button
                    className="rounded p-0.5 hover:text-destructive"
                    title="删除此页"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await ask(`删除第 ${i + 1} 页？`, "不可撤销。")) remove.mutate(p.id);
                    }}
                  >
                    <Trash2Icon size={12} strokeWidth={1.8} />
                  </button>
                </span>
              </div>
              <div className="line-clamp-2 min-h-[28px] rounded bg-black/80 px-2 py-1 text-[11px] text-white/90">{p.title || "未命名页"}</div>
            </div>
          ))}
          {list.length === 0 && pages.isSuccess && <p className="px-2 py-6 text-center text-[12px] text-subtle">还没有页面，点「新页」开始</p>}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b px-5">
          <PresentationIcon size={16} strokeWidth={1.7} className="text-primary" />
          <span className="text-[14px] font-semibold">演示文稿</span>
          <button
            className="ml-auto flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={!active}
            onClick={() => setPlaying(true)}
            data-slides-play
          >
            <PresentationIcon size={14} strokeWidth={1.7} /> 放映
          </button>
        </header>
        {active ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-8">
            <div className="flex h-full w-full max-w-[860px] flex-col rounded-xl p-10 shadow-lg" style={{ background: active.background || "#1a1a1a" }}>
              <input
                value={active.title}
                onChange={(e) => update.mutate({ id: active.id, title: e.target.value, body: active.body, background: active.background })}
                placeholder="页面标题"
                className="w-full bg-transparent text-[30px] font-bold text-white outline-none placeholder:text-white/30"
                data-slides-title
              />
              <textarea
                value={active.body}
                onChange={(e) => update.mutate({ id: active.id, title: active.title, body: e.target.value, background: active.background })}
                placeholder={"每行一个要点"}
                className="mt-6 min-h-0 flex-1 resize-none bg-transparent text-[18px] leading-8 text-white/90 outline-none placeholder:text-white/30"
                data-slides-body
              />
              <div className="mt-4 flex items-center gap-2 text-[12px] text-white/50">
                背景色
                <input
                  type="color"
                  value={active.background || "#1a1a1a"}
                  onChange={(e) => update.mutate({ id: active.id, title: active.title, body: active.body, background: e.target.value })}
                  className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent"
                  data-slides-bg
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-subtle">左侧新建第一页</div>
        )}
      </section>
    </div>
  );
}
