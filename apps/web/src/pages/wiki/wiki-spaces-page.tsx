import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Globe, Lock, Plus, Search, Settings, X } from "lucide-react";
import { ApiError, wikiApi, type Me, type WikiSpace, type WikiVisibility } from "@/lib/api";
import { go } from "@/lib/route";
import { useI18n } from "@/lib/i18n";

const ICON_PRESETS = ["📚", "🚀", "🧩", "📘", "⚙️", "🛡️", "📊", "💡"];

const ROLE_LABELS: Record<string, string> = {
  manage: "管理员",
  edit: "可编辑",
  view: "仅阅读",
};

export function WikiSpacesPage({ me }: { me: Me }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  useEffect(() => {
    document.title = `${t("知识库")} - Jiange`;
  }, [locale, t]);

  const [workspaceId, setWorkspaceId] = useState<number>(() => me.workspaces[0]?.id ?? 0);
  const effectiveWsId = me.workspaces.some((w) => w.id === workspaceId) ? workspaceId : (me.workspaces[0]?.id ?? 0);
  const [keyword, setKeyword] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("📚");
  const [visibility, setVisibility] = useState<WikiVisibility>("workspace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const queryKey = ["wiki-spaces", effectiveWsId, me.user.id];
  const spacesQuery = useQuery({
    queryKey,
    queryFn: () => wikiApi.listSpaces(effectiveWsId, me.user.id),
    enabled: effectiveWsId > 0,
    refetchOnWindowFocus: true,
  });

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const list = spacesQuery.data ?? [];
    if (!q) return list;
    return list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [spacesQuery.data, keyword]);

  const submitCreate = async () => {
    if (busy || !name.trim() || !effectiveWsId) return;
    setBusy(true);
    setError("");
    try {
      const created = await wikiApi.createSpace(effectiveWsId, me.user.id, {
        name: name.trim(),
        description: description.trim(),
        icon,
        visibility,
      });
      await qc.invalidateQueries({ queryKey });
      setCreating(false);
      setName("");
      setDescription("");
      go(`#/wiki/${created.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("创建知识库失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background" data-wiki-spaces-page>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-surface px-4 py-4 pl-14 md:px-8 md:pl-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#edf4ff] text-[#3370ff]">
            <BookOpen size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-semibold text-foreground">{t("知识库")}</h1>
            <p className="truncate text-[12px] text-subtle">{t("独立知识空间与结构化目录树")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {me.workspaces.length > 1 && (
            <select
              aria-label={t("切换企业空间")}
              value={effectiveWsId}
              onChange={(e) => setWorkspaceId(Number(e.target.value))}
              className="h-9 max-w-[160px] rounded-md border bg-surface px-2.5 text-[13px]"
            >
              {me.workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => { setError(""); setCreating(true); }}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-[13px] font-medium text-white hover:bg-primary/90"
            data-new-wiki-space
          >
            <Plus size={15} />
            {t("新建知识库")}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <label className="relative flex w-full max-w-xs items-center">
              <Search size={15} className="pointer-events-none absolute left-3 text-subtle" />
              <input
                type="search"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={t("搜索知识库名称或简介")}
                className="h-9 w-full rounded-md border bg-surface pl-9 pr-3 text-[13px] outline-none focus:border-primary"
              />
            </label>
            <span className="text-[12px] text-subtle">{t("共 {count} 个可访问知识库", { count: filtered.length })}</span>
          </div>

          {spacesQuery.isPending && (
            <p className="py-12 text-center text-[14px] text-subtle">{t("正在加载知识库…")}</p>
          )}
          {spacesQuery.isError && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
              {t("知识库列表加载失败，请刷新后重试")}
            </p>
          )}

          {!spacesQuery.isPending && !spacesQuery.isError && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-surface px-6 py-16 text-center">
              <div className="grid size-12 place-items-center rounded-full bg-[#edf4ff] text-[#3370ff]">
                <BookOpen size={22} />
              </div>
              <p className="mt-3 text-[15px] font-medium text-foreground">{t("还没有知识库")}</p>
              <p className="mt-1 max-w-sm text-[13px] text-subtle">{t("创建独立的知识空间，按部门或用户组管理权限，沉淀团队文档与表格。")}</p>
              <button
                type="button"
                onClick={() => { setError(""); setCreating(true); }}
                className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white hover:bg-primary/90"
              >
                <Plus size={15} />
                {t("新建知识库")}
              </button>
            </div>
          )}

          {filtered.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((space: WikiSpace) => (
                <div
                  key={space.id}
                  data-wiki-space-card={space.id}
                  className="group flex flex-col rounded-xl border bg-surface p-4 transition-shadow hover:border-primary/40 hover:shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => go(`#/wiki/${space.id}`)}
                    className="flex min-w-0 flex-1 flex-col text-left"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#f2f5fc] text-[20px]">
                          {space.icon || "📚"}
                        </span>
                        <div className="min-w-0">
                          <h2 className="truncate text-[15px] font-semibold text-foreground group-hover:text-primary">{space.name}</h2>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-subtle">
                            <span className="inline-flex items-center gap-1">
                              {space.visibility === "private" ? <Lock size={11} /> : <Globe size={11} />}
                              {space.visibility === "private" ? t("私有知识库") : t("全员可见")}
                            </span>
                            <span>·</span>
                            <span>{t("{count} 篇内容", { count: space.nodeCount })}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-[13px] text-muted-foreground">
                      {space.description || t("暂无简介")}
                    </p>
                  </button>
                  <div className="mt-3 flex items-center justify-between border-t pt-2.5 text-[12px] text-subtle">
                    <span className="rounded bg-sidebar px-2 py-0.5 text-[11px] text-muted-foreground">
                      {t(ROLE_LABELS[space.callerRole] ?? "仅阅读")}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="truncate">{space.creatorName}</span>
                      {space.callerRole === "manage" && (
                        <button
                          type="button"
                          onClick={() => go(`#/wiki/${space.id}`)}
                          aria-label={t("打开空间设置")}
                          className="rounded p-1 text-subtle hover:bg-hover hover:text-foreground"
                        >
                          <Settings size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {creating && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={t("新建知识库")}>
          <div className="w-full max-w-md rounded-xl border bg-surface p-5 shadow-xl" data-create-wiki-dialog>
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold">{t("新建知识库")}</h2>
              <button type="button" onClick={() => setCreating(false)} aria-label={t("关闭")} className="rounded p-1 text-subtle hover:bg-hover">
                <X size={16} />
              </button>
            </div>
            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submitCreate();
              }}
            >
              <div>
                <label className="mb-1 block text-[13px] font-medium">{t("图标")}</label>
                <div className="flex flex-wrap gap-1.5">
                  {ICON_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setIcon(preset)}
                      className={`grid size-9 place-items-center rounded-md border text-[18px] ${icon === preset ? "border-primary bg-primary/10" : "hover:bg-hover"}`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[13px] font-medium" htmlFor="wiki-space-name">{t("知识库名称")}</label>
                <input
                  id="wiki-space-name"
                  type="text"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("例如：产品与研发知识库")}
                  className="h-9 w-full rounded-md border bg-surface px-3 text-[14px] outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="mb-1 block text-[13px] font-medium" htmlFor="wiki-space-desc">{t("知识库简介")}</label>
                <textarea
                  id="wiki-space-desc"
                  rows={2}
                  maxLength={500}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t("介绍该知识库的用途与协作规范（可选）")}
                  className="w-full rounded-md border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary"
                />
              </div>
              <div>
                <span className="mb-1.5 block text-[13px] font-medium">{t("访问范围")}</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setVisibility("workspace")}
                    className={`rounded-lg border p-2.5 text-left ${visibility === "workspace" ? "border-primary bg-primary/5" : "hover:bg-hover"}`}
                  >
                    <div className="flex items-center gap-1.5 text-[13px] font-medium"><Globe size={14} />{t("全员可见")}</div>
                    <p className="mt-1 text-[11px] text-subtle">{t("空间成员默认可阅读，可单独授编辑/管理")}</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisibility("private")}
                    className={`rounded-lg border p-2.5 text-left ${visibility === "private" ? "border-primary bg-primary/5" : "hover:bg-hover"}`}
                  >
                    <div className="flex items-center gap-1.5 text-[13px] font-medium"><Lock size={14} />{t("私有知识库")}</div>
                    <p className="mt-1 text-[11px] text-subtle">{t("仅管理员与显式授权成员/部门/用户组可见")}</p>
                  </button>
                </div>
              </div>
              {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setCreating(false)} className="h-9 rounded-md border px-3.5 text-[13px] hover:bg-hover">
                  {t("取消")}
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || busy}
                  className="h-9 rounded-md bg-primary px-4 text-[13px] font-medium text-white disabled:opacity-50"
                >
                  {busy ? t("创建中…") : t("创建")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
