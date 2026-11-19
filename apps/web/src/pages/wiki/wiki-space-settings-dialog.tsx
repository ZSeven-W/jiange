import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Globe, Lock, Trash2, User, Users, X } from "lucide-react";
import {
  ApiError,
  orgApi,
  wikiApi,
  type Role,
  type WikiGrantSubjectType,
  type WikiSpace,
  type WikiSpaceGrant,
  type WikiVisibility,
} from "@/lib/api";
import { ask } from "@/components/ui/ask";
import { useI18n } from "@/lib/i18n";

export function WikiSpaceSettingsDialog({
  space,
  grants,
  userId,
  onClose,
  onDeleted,
}: {
  space: WikiSpace;
  grants: WikiSpaceGrant[];
  userId: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description);
  const [icon, setIcon] = useState(space.icon || "📚");
  const [visibility, setVisibility] = useState<WikiVisibility>(space.visibility);
  const [subjectType, setSubjectType] = useState<WikiGrantSubjectType>("department");
  const [subjectId, setSubjectId] = useState<number>(0);
  const [grantRole, setGrantRole] = useState<Role>("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const orgQuery = useQuery({
    queryKey: ["workspace-org", space.workspaceId, userId],
    queryFn: () => orgApi.get(space.workspaceId, userId),
  });

  const options = (() => {
    const org = orgQuery.data;
    if (!org) return [];
    if (subjectType === "user") {
      return org.members
        .filter((m) => m.userId !== space.creatorId)
        .map((m) => ({ id: m.userId, label: `${m.name} (${m.email})` }));
    }
    if (subjectType === "department") {
      return org.departments.map((d) => ({ id: d.id, label: `${d.name} (${t("含下级")})` }));
    }
    return org.groups.map((g) => ({ id: g.id, label: g.name }));
  })();

  const effectiveSubjectId = options.some((o) => o.id === subjectId) ? subjectId : (options[0]?.id ?? 0);

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["wiki-space", space.id, userId] }),
      qc.invalidateQueries({ queryKey: ["wiki-spaces"] }),
    ]);
  };

  const saveMeta = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await wikiApi.updateSpace(space.id, userId, {
        name: name.trim(),
        description: description.trim(),
        icon: icon.trim(),
        visibility,
      });
      await invalidate();
      setNotice(t("知识库设置已保存"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("保存失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  const upsertGrant = async (type: WikiGrantSubjectType, id: number, role: Role | "") => {
    if (busy || id <= 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await wikiApi.setGrant(space.id, userId, type, id, role);
      await invalidate();
      setNotice(role ? t("空间权限已更新") : t("已移除空间权限"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("更新权限失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    const confirmed = await ask(
      t("删除知识库「{name}」？", { name: space.name }),
      t("删除后将永久移除该知识库及其下所有页面，无法恢复。"),
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await wikiApi.deleteSpace(space.id, userId);
      await qc.invalidateQueries({ queryKey: ["wiki-spaces"] });
      await qc.invalidateQueries({ queryKey: ["docs"] });
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("删除知识库失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={t("知识库设置")}>
      <div className="flex max-h-[88dvh] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-surface shadow-xl" data-wiki-settings-dialog>
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="text-[16px] font-semibold">{t("知识库设置")}</h2>
          <button type="button" onClick={onClose} aria-label={t("关闭")} className="rounded p-1 text-subtle hover:bg-hover">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {notice && <p role="status" className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-[13px] text-primary">{notice}</p>}
          {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">{error}</p>}

          <section className="space-y-3">
            <h3 className="text-[13px] font-semibold text-foreground">{t("基本信息与可见范围")}</h3>
            <div className="flex gap-2">
              <input
                type="text"
                aria-label={t("图标")}
                maxLength={8}
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="h-9 w-14 rounded-md border bg-surface text-center text-[18px]"
              />
              <input
                type="text"
                aria-label={t("知识库名称")}
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 min-w-0 flex-1 rounded-md border bg-surface px-3 text-[14px]"
              />
            </div>
            <textarea
              rows={2}
              aria-label={t("知识库简介")}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("知识库简介")}
              className="w-full rounded-md border bg-surface px-3 py-2 text-[13px]"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setVisibility("workspace")}
                className={`rounded-lg border p-2.5 text-left ${visibility === "workspace" ? "border-primary bg-primary/5" : "hover:bg-hover"}`}
              >
                <div className="flex items-center gap-1.5 text-[13px] font-medium"><Globe size={14} />{t("全员可见")}</div>
                <p className="mt-0.5 text-[11px] text-subtle">{t("空间成员默认可阅读")}</p>
              </button>
              <button
                type="button"
                onClick={() => setVisibility("private")}
                className={`rounded-lg border p-2.5 text-left ${visibility === "private" ? "border-primary bg-primary/5" : "hover:bg-hover"}`}
              >
                <div className="flex items-center gap-1.5 text-[13px] font-medium"><Lock size={14} />{t("私有知识库")}</div>
                <p className="mt-0.5 text-[11px] text-subtle">{t("仅授权对象可访问")}</p>
              </button>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                disabled={busy || !name.trim()}
                onClick={() => void saveMeta()}
                className="h-8 rounded-md bg-primary px-3.5 text-[13px] font-medium text-white disabled:opacity-50"
              >
                {t("保存设置")}
              </button>
            </div>
          </section>

          <section className="space-y-3 border-t pt-4">
            <h3 className="text-[13px] font-semibold text-foreground">{t("空间权限授权")}</h3>
            <p className="text-[12px] text-subtle">{t("按成员、部门（自动覆盖下级部门）或用户组授予知识库级权限。")}</p>

            <div className="flex flex-wrap gap-2">
              <select
                aria-label={t("授权对象类型")}
                value={subjectType}
                onChange={(e) => setSubjectType(e.target.value as WikiGrantSubjectType)}
                className="h-9 rounded-md border bg-surface px-2.5 text-[13px]"
                data-wiki-grant-type
              >
                <option value="department">{t("部门")}</option>
                <option value="group">{t("用户组")}</option>
                <option value="user">{t("成员")}</option>
              </select>
              <select
                aria-label={t("选择授权对象")}
                value={effectiveSubjectId}
                onChange={(e) => setSubjectId(Number(e.target.value))}
                disabled={options.length === 0}
                className="h-9 min-w-[160px] flex-1 rounded-md border bg-surface px-2.5 text-[13px]"
                data-wiki-grant-subject
              >
                {options.length === 0 ? (
                  <option value={0}>{t("暂无可授权对象")}</option>
                ) : (
                  options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)
                )}
              </select>
              <select
                aria-label={t("空间角色")}
                value={grantRole}
                onChange={(e) => setGrantRole(e.target.value as Role)}
                className="h-9 rounded-md border bg-surface px-2.5 text-[13px]"
                data-wiki-grant-role
              >
                <option value="view">{t("可阅读")}</option>
                <option value="edit">{t("可编辑")}</option>
                <option value="manage">{t("可管理")}</option>
              </select>
              <button
                type="button"
                disabled={busy || effectiveSubjectId <= 0}
                onClick={() => void upsertGrant(subjectType, effectiveSubjectId, grantRole)}
                className="h-9 rounded-md bg-primary px-3 text-[13px] font-medium text-white disabled:opacity-50"
                data-wiki-grant-add
              >
                {t("添加")}
              </button>
            </div>

            <div className="space-y-2">
              {grants.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-[12px] text-subtle">{t("暂无额外授权")}</p>
              ) : (
                grants.map((g) => (
                  <div
                    key={`${g.subjectType}:${g.subjectId}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                    data-wiki-grant-row
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#edf4ff] text-[#3370ff]">
                        {g.subjectType === "department" ? <Building2 size={14} /> : g.subjectType === "group" ? <Users size={14} /> : <User size={14} />}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">{g.name}</p>
                        <p className="truncate text-[11px] text-subtle">
                          {g.subjectType === "department"
                            ? t("部门 · 含下级")
                            : g.subjectType === "group"
                              ? t("用户组")
                              : g.email || t("空间成员")}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={t("调整{name}的权限", { name: g.name })}
                        value={g.role}
                        disabled={busy}
                        onChange={(e) => void upsertGrant(g.subjectType, g.subjectId, e.target.value as Role)}
                        className="h-8 rounded-md border bg-surface px-2 text-[12px]"
                      >
                        <option value="view">{t("可阅读")}</option>
                        <option value="edit">{t("可编辑")}</option>
                        <option value="manage">{t("可管理")}</option>
                      </select>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void upsertGrant(g.subjectType, g.subjectId, "")}
                        className="h-8 rounded-md border px-2 text-[12px] text-destructive hover:bg-destructive/5"
                      >
                        {t("移除")}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div>
                <p className="text-[13px] font-medium text-destructive">{t("删除知识库")}</p>
                <p className="text-[12px] text-subtle">{t("将永久删除此空间下的全部页面与目录")}</p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleDelete()}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-destructive/40 bg-surface px-3 text-[12px] text-destructive hover:bg-destructive/10"
              >
                <Trash2 size={13} />
                {t("删除")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
