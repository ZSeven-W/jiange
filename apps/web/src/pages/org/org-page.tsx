import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronDown, ChevronRight, Crown, FolderTree, Pencil, Plus, Shield, Trash2, UserPlus, Users } from "lucide-react";
import { ApiError, orgApi, type Me, type OrgDepartment, type OrgGroup, type WorkspaceMemberInfo } from "@/lib/api";
import { Avatar } from "@/components/brand";
import { colorFor } from "@/lib/presence";
import { ask, askText } from "@/components/ui/ask";
import { FeishuSelect } from "@/components/feishu-select";
import { t as defaultT, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { setActiveWorkspaceId, transferWorkspaceOwner } from "@/lib/workspace-switcher";
import { OrgSyncPanel } from "./org-sync-panel";
import { OrgSSOPanel } from "./org-sso-panel";
import { OrgAuditPanel } from "./org-audit-panel";
import { OrgWebhooksPanel } from "./org-webhooks-panel";
import { OrgNotificationsPanel } from "./org-notifications-panel";
import { OrgDeveloperPanel } from "./org-developer-panel";

export type OrgTab = "departments" | "groups" | "members" | "sync" | "sso" | "security" | "webhooks" | "notifications" | "developer";

const WS_ROLE_LABELS: Record<string, string> = {
  owner: "空间所有者",
  admin: "管理员",
  member: "普通成员",
};

export async function requestWorkspaceOwnerTransfer(opts: {
  workspaceId: number;
  callerUserId: number;
  member: Pick<WorkspaceMemberInfo, "userId" | "name">;
  runMutation: (fn: () => Promise<void | string>, successMessage: string) => Promise<void>;
  invalidateGlobal?: () => Promise<void>;
  confirmFn?: typeof ask;
  transferFn?: typeof transferWorkspaceOwner;
  t?: typeof defaultT;
}): Promise<boolean> {
  const t = opts.t ?? defaultT;
  const confirmFn = opts.confirmFn ?? ask;
  const transferFn = opts.transferFn ?? transferWorkspaceOwner;
  const confirmed = await confirmFn(
    t("将空间所有者转让给「{name}」？", { name: opts.member.name }),
    t("转让后，{name} 将成为该空间的所有者，你的角色将自动变更为管理员。此操作无法自行撤销。", { name: opts.member.name }),
  );
  if (!confirmed) return false;
  await opts.runMutation(async () => {
    await transferFn(opts.workspaceId, opts.member.userId);
    if (opts.invalidateGlobal) {
      await opts.invalidateGlobal();
    }
    setActiveWorkspaceId(opts.callerUserId, opts.workspaceId);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("jiange:workspaces-changed"));
    }
  }, t("已将空间所有者转让给 {name}", { name: opts.member.name }));
  return true;
}

export function OrgPage({ me, initialTab = "departments" }: { me: Me; initialTab?: OrgTab }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  useEffect(() => { document.title = `${t("组织架构")} - Jiange`; }, [locale, t]);

  const [workspaceId, setWorkspaceId] = useState<number>(() => me.workspaces[0]?.id ?? 0);
  const effectiveWsId = me.workspaces.some((w) => w.id === workspaceId) ? workspaceId : (me.workspaces[0]?.id ?? 0);
  const [tab, setTab] = useState<OrgTab>(initialTab);
  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [expandedDepts, setExpandedDepts] = useState<Record<number, boolean>>({});
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [deptMemberId, setDeptMemberId] = useState<number>(0);
  const [deptLeader, setDeptLeader] = useState(false);
  const [groupMemberId, setGroupMemberId] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const queryKey = ["workspace-org", effectiveWsId, me.user.id];
  const orgQuery = useQuery({
    queryKey,
    queryFn: () => orgApi.get(effectiveWsId, me.user.id),
    enabled: effectiveWsId > 0,
    refetchOnWindowFocus: true,
  });

  const data = orgQuery.data;
  const isOwner = data?.callerRole === "owner";
  const canAdmin = isOwner || data?.callerRole === "admin";
  const departments = data?.departments ?? [];
  const groups = data?.groups ?? [];
  const members = data?.members ?? [];

  const activeDept: OrgDepartment | null = useMemo(() => {
    if (!departments.length) return null;
    return departments.find((d) => d.id === selectedDeptId) ?? departments[0];
  }, [departments, selectedDeptId]);

  const activeGroup: OrgGroup | null = useMemo(() => {
    if (!groups.length) return null;
    return groups.find((g) => g.id === selectedGroupId) ?? groups[0];
  }, [groups, selectedGroupId]);

  const deptChildrenMap = useMemo(() => {
    const map = new Map<number | null, OrgDepartment[]>();
    const ids = new Set(departments.map((d) => d.id));
    for (const d of departments) {
      const parent = d.parentId && ids.has(d.parentId) ? d.parentId : null;
      map.set(parent, [...(map.get(parent) ?? []), d]);
    }
    return map;
  }, [departments]);

  const runMutation = async (fn: () => Promise<void | string>, successMessage: string) => {
    if (busy || !effectiveWsId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const override = await fn();
      await qc.invalidateQueries({ queryKey });
      setNotice(override || successMessage);
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else if (e instanceof Error) setError(e.message);
      else setError(t("操作失败，请检查后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateDept = async (parentId: number | null) => {
    const name = await askText(parentId ? t("新建子部门") : t("新建一级部门"), t("部门名称"));
    if (!name?.trim()) return;
    await runMutation(async () => {
      const created = await orgApi.createDepartment(effectiveWsId, me.user.id, name.trim(), parentId);
      setSelectedDeptId(created.id);
      if (parentId) setExpandedDepts((prev) => ({ ...prev, [parentId]: true }));
    }, t("部门已创建"));
  };

  const handleRenameDept = async (dept: OrgDepartment) => {
    const name = await askText(t("重命名部门"), t("部门名称"), dept.name);
    if (!name?.trim() || name.trim() === dept.name) return;
    await runMutation(async () => {
      await orgApi.updateDepartment(effectiveWsId, dept.id, me.user.id, { name: name.trim() });
    }, t("部门已重命名"));
  };

  const handleDeleteDept = async (dept: OrgDepartment) => {
    const confirmed = await ask(t("删除部门「{name}」？", { name: dept.name }), t("子部门与部门共享权限将一并移除，无法撤销。"));
    if (!confirmed) return;
    await runMutation(async () => {
      await orgApi.deleteDepartment(effectiveWsId, dept.id, me.user.id);
      if (selectedDeptId === dept.id) setSelectedDeptId(null);
    }, t("部门已删除"));
  };

  const handleCreateGroup = async () => {
    const name = await askText(t("新建用户组"), t("用户组名称"));
    if (!name?.trim()) return;
    await runMutation(async () => {
      const created = await orgApi.createGroup(effectiveWsId, me.user.id, name.trim(), "");
      setSelectedGroupId(created.id);
    }, t("用户组已创建"));
  };

  const handleRenameGroup = async (group: OrgGroup) => {
    const name = await askText(t("重命名用户组"), t("用户组名称"), group.name);
    if (!name?.trim() || name.trim() === group.name) return;
    await runMutation(async () => {
      await orgApi.updateGroup(effectiveWsId, group.id, me.user.id, { name: name.trim() });
    }, t("用户组已更新"));
  };

  const handleDeleteGroup = async (group: OrgGroup) => {
    const confirmed = await ask(t("删除用户组「{name}」？", { name: group.name }), t("关联的文档或知识库共享权限将被撤销。"));
    if (!confirmed) return;
    await runMutation(async () => {
      await orgApi.deleteGroup(effectiveWsId, group.id, me.user.id);
      if (selectedGroupId === group.id) setSelectedGroupId(null);
    }, t("用户组已删除"));
  };

  const handleTransferOwner = async (member: WorkspaceMemberInfo) => {
    if (busy || !effectiveWsId) return;
    await requestWorkspaceOwnerTransfer({
      workspaceId: effectiveWsId,
      callerUserId: me.user.id,
      member,
      runMutation,
      invalidateGlobal: async () => {
        await qc.invalidateQueries({ queryKey: ["me"] });
        await qc.invalidateQueries({ queryKey: ["workspaces"] });
      },
      t,
    });
  };

  const availableDeptMembers = useMemo(() => {
    if (!activeDept) return [];
    const existing = new Set(activeDept.members.map((m) => m.userId));
    return members.filter((m) => !existing.has(m.userId));
  }, [activeDept, members]);

  const availableGroupMembers = useMemo(() => {
    if (!activeGroup) return [];
    const existing = new Set(activeGroup.members.map((m) => m.userId));
    return members.filter((m) => !existing.has(m.userId));
  }, [activeGroup, members]);

  const effectiveDeptPick = availableDeptMembers.some((m) => m.userId === deptMemberId) ? deptMemberId : (availableDeptMembers[0]?.userId ?? 0);
  const effectiveGroupPick = availableGroupMembers.some((m) => m.userId === groupMemberId) ? groupMemberId : (availableGroupMembers[0]?.userId ?? 0);

  const renderDeptTree = (parentId: number | null, depth: number): React.ReactNode =>
    (deptChildrenMap.get(parentId) ?? []).map((dept) => {
      const children = deptChildrenMap.get(dept.id) ?? [];
      const isExpanded = expandedDepts[dept.id] ?? true;
      const isSelected = activeDept?.id === dept.id;
      return (
        <div key={dept.id}>
          <div
            className={cn(
              "group flex h-9 items-center gap-1 rounded-md pr-1 text-[13px] transition-colors",
              isSelected ? "bg-accent font-medium text-accent-foreground" : "hover:bg-hover",
            )}
            style={{ paddingLeft: 6 + depth * 16 }}
            data-org-dept-row={dept.id}
          >
            {children.length > 0 ? (
              <button
                type="button"
                aria-label={t(isExpanded ? "收起" : "展开")}
                onClick={() => setExpandedDepts((prev) => ({ ...prev, [dept.id]: !isExpanded }))}
                className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-black/5"
              >
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
            ) : (
              <span aria-hidden className="size-5 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => setSelectedDeptId(dept.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <FolderTree size={14} className="shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">{dept.name}</span>
              {dept.syncSourceId ? (
                <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">{t("同步")}</span>
              ) : null}
              <span className="shrink-0 text-[11px] text-subtle">{dept.members.length}</span>
            </button>
            {canAdmin && (
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex [@media(hover:none)]:flex">
                <button type="button" title={t("新建子部门")} aria-label={t("新建子部门")} onClick={() => void handleCreateDept(dept.id)} className="grid size-6 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground">
                  <Plus size={13} />
                </button>
                <button type="button" title={t("重命名部门")} aria-label={t("重命名部门")} onClick={() => void handleRenameDept(dept)} className="grid size-6 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground">
                  <Pencil size={12} />
                </button>
                <button type="button" title={t("删除部门")} aria-label={t("删除部门")} onClick={() => void handleDeleteDept(dept)} className="grid size-6 place-items-center rounded text-subtle hover:bg-black/5 hover:text-destructive">
                  <Trash2 size={12} />
                </button>
              </span>
            )}
          </div>
          {children.length > 0 && isExpanded && renderDeptTree(dept.id, depth + 1)}
        </div>
      );
    });

  return (
    <main data-org-page className="min-w-0 flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-5xl pb-12">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-surface px-4 py-4 pl-14 md:px-7">
          <div className="min-w-0 flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Building2 size={18} /></span>
            <div className="min-w-0">
              <h1 className="truncate text-[18px] font-semibold tracking-[-0.01em]">{t("组织架构")}</h1>
              <p className="truncate text-[12px] text-subtle">{data?.workspaceName ?? me.workspaces[0]?.name ?? t("我的空间")}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {me.workspaces.length > 1 && (
              <FeishuSelect
                ariaLabel={t("切换企业空间")}
                value={String(effectiveWsId)}
                options={me.workspaces.map((ws) => ({ value: String(ws.id), label: ws.name }))}
                onChange={(val) => {
                  const nextId = Number(val);
                  if (nextId !== effectiveWsId) {
                    setWorkspaceId(nextId);
                    setSelectedDeptId(null);
                    setSelectedGroupId(null);
                  }
                }}
                className="h-8 max-w-[180px] border bg-surface px-2.5 text-[13px]"
                menuMinWidth={160}
              />
            )}
            {data && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sidebar px-2.5 py-1 text-[12px] text-muted-foreground">
                <Shield size={12} className="text-primary" />
                {t(WS_ROLE_LABELS[data.callerRole] ?? "普通成员")}
              </span>
            )}
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-x-0.5 gap-y-0 border-b bg-surface px-4 md:px-7">
          {([
            ["departments", t("部门架构")],
            ["groups", t("用户组")],
            ["members", t("空间成员")],
            ["sync", t("目录同步")],
            ["sso", t("单点登录 SSO")],
            ["security", t("安全审计与水印")],
            ["webhooks", t("开放集成 Webhook")],
            ["notifications", t("外部通知渠道")],
            ["developer", t("开放 API 与 SCIM")],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              data-org-tab={key}
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "shrink-0 border-b-2 px-2.5 py-2.5 text-[13px] font-medium transition-colors",
                tab === key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="px-4 pt-5 md:px-7">
          {error && <p role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">{error}</p>}
          {notice && <p role="status" className="mb-4 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[13px] text-primary">{notice}</p>}
          {orgQuery.isPending && <p className="text-[13px] text-subtle">{t("正在加载组织架构…")}</p>}
          {orgQuery.isError && <p role="alert" className="text-[13px] text-destructive">{t("加载组织架构失败，请稍后重试。")}</p>}

          {data && tab === "departments" && (
            <div className="flex flex-col gap-4 md:flex-row">
              <section className="rounded-lg border bg-surface p-3 md:w-72 md:shrink-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold">{t("部门树")}</span>
                  {canAdmin && (
                    <button
                      type="button"
                      data-new-root-dept
                      disabled={busy}
                      onClick={() => void handleCreateDept(null)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] hover:bg-hover disabled:opacity-50"
                    >
                      <Plus size={13} />{t("新建一级部门")}
                    </button>
                  )}
                </div>
                {departments.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-subtle">{t("暂无部门")}</p>
                ) : (
                  <div className="space-y-0.5">{renderDeptTree(null, 0)}</div>
                )}
              </section>

              <section className="min-w-0 flex-1 rounded-lg border bg-surface p-4">
                {!activeDept ? (
                  <p className="py-8 text-center text-[13px] text-subtle">{t("请选择或创建一个部门查看成员与下级权限")}</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-[16px] font-semibold">{activeDept.name}</h2>
                        <p className="text-[12px] text-subtle">{t("向部门授权时，其下级子部门成员自动继承访问权限")}</p>
                      </div>
                      {canAdmin && (
                        <div className="flex items-center gap-1.5">
                          <button type="button" disabled={busy} onClick={() => void handleCreateDept(activeDept.id)} className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[12px] hover:bg-hover disabled:opacity-50"><Plus size={13} />{t("新建子部门")}</button>
                          <button type="button" disabled={busy} onClick={() => void handleRenameDept(activeDept)} className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[12px] hover:bg-hover disabled:opacity-50">{t("重命名")}</button>
                        </div>
                      )}
                    </div>

                    {canAdmin && (
                      <form
                        className="mt-4 flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!effectiveDeptPick) return;
                          void runMutation(async () => {
                            await orgApi.setDepartmentMember(effectiveWsId, activeDept.id, me.user.id, effectiveDeptPick, true, deptLeader);
                          }, t("已添加部门成员"));
                        }}
                      >
                        <FeishuSelect
                          ariaLabel={t("选择部门成员")}
                          value={String(effectiveDeptPick)}
                          options={
                            availableDeptMembers.length === 0
                              ? [{ value: "0", label: t("暂无可添加的空间成员") }]
                              : availableDeptMembers.map((m) => ({ value: String(m.userId), label: `${m.name} (${m.email})` }))
                          }
                          onChange={(val) => setDeptMemberId(Number(val))}
                          disabled={availableDeptMembers.length === 0}
                          className="h-9 min-w-44 shrink flex-1 border bg-surface px-2.5 text-[13px] disabled:opacity-60"
                          menuMinWidth={200}
                        />
                        <label className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                          <input type="checkbox" checked={deptLeader} onChange={(e) => setDeptLeader(e.target.checked)} />
                          {t("设为负责人")}
                        </label>
                        <button
                          type="submit"
                          data-add-dept-member
                          disabled={!effectiveDeptPick || busy}
                          className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-[13px] font-medium text-white disabled:opacity-50"
                        >
                          <UserPlus size={14} />{t("添加到部门")}
                        </button>
                      </form>
                    )}

                    <div className="mt-4 space-y-2">
                      {activeDept.members.length === 0 ? (
                        <p className="py-6 text-center text-[13px] text-subtle">{t("当前部门暂无直属成员")}</p>
                      ) : (
                        activeDept.members.map((member) => (
                          <div key={member.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                            <div className="flex min-w-0 items-center gap-2.5">
                              <Avatar name={member.name} color={colorFor(member.userId - 1)} size={28} />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate text-[13px] font-medium">{member.name}</span>
                                  {member.isLeader && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">{t("负责人")}</span>}
                                </div>
                                <p className="truncate text-[12px] text-subtle">{member.email}</p>
                              </div>
                            </div>
                            {canAdmin && (
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void runMutation(() => orgApi.setDepartmentMember(effectiveWsId, activeDept.id, me.user.id, member.userId, true, !member.isLeader), t("已更新部门成员"))}
                                  className="h-7 rounded border px-2 text-[12px] hover:bg-hover"
                                >
                                  {member.isLeader ? t("取消负责人") : t("设为负责人")}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void runMutation(() => orgApi.setDepartmentMember(effectiveWsId, activeDept.id, me.user.id, member.userId, false, false), t("已移出部门"))}
                                  className="h-7 rounded border px-2 text-[12px] text-destructive hover:bg-destructive/5"
                                >
                                  {t("移出")}
                                </button>
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </section>
            </div>
          )}

          {data && tab === "groups" && (
            <div className="flex flex-col gap-4 md:flex-row">
              <section className="rounded-lg border bg-surface p-3 md:w-72 md:shrink-0">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold">{t("用户组列表")}</span>
                  {canAdmin && (
                    <button
                      type="button"
                      data-new-org-group
                      onClick={() => void handleCreateGroup()}
                      className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] hover:bg-hover"
                    >
                      <Plus size={13} />{t("新建用户组")}
                    </button>
                  )}
                </div>
                {groups.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-subtle">{t("暂无用户组")}</p>
                ) : (
                  <div className="space-y-1">
                    {groups.map((group) => (
                      <div
                        key={group.id}
                        className={cn(
                          "group flex h-9 items-center gap-2 rounded-md px-2 text-[13px]",
                          activeGroup?.id === group.id ? "bg-accent font-medium text-accent-foreground" : "hover:bg-hover",
                        )}
                      >
                        <button type="button" onClick={() => setSelectedGroupId(group.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                          <Users size={14} className="shrink-0 text-primary" />
                          <span className="min-w-0 flex-1 truncate">{group.name}</span>
                          <span className="shrink-0 text-[11px] text-subtle">{group.members.length}</span>
                        </button>
                        {canAdmin && (
                          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex [@media(hover:none)]:flex">
                            <button type="button" aria-label={t("重命名用户组")} onClick={() => void handleRenameGroup(group)} className="grid size-6 place-items-center rounded text-subtle hover:bg-black/5 hover:text-foreground"><Pencil size={12} /></button>
                            <button type="button" aria-label={t("删除用户组")} onClick={() => void handleDeleteGroup(group)} className="grid size-6 place-items-center rounded text-subtle hover:bg-black/5 hover:text-destructive"><Trash2 size={12} /></button>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="min-w-0 flex-1 rounded-lg border bg-surface p-4">
                {!activeGroup ? (
                  <p className="py-8 text-center text-[13px] text-subtle">{t("请选择或创建一个用户组用于跨部门批量授权")}</p>
                ) : (
                  <>
                    <div className="border-b pb-3">
                      <h2 className="truncate text-[16px] font-semibold">{activeGroup.name}</h2>
                      <p className="text-[12px] text-subtle">{activeGroup.description || t("用于按项目或角色分组授予文档和知识库权限")}</p>
                    </div>
                    {canAdmin && (
                      <form
                        className="mt-4 flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!effectiveGroupPick) return;
                          void runMutation(() => orgApi.setGroupMember(effectiveWsId, activeGroup.id, me.user.id, effectiveGroupPick, true), t("已添加组成员"));
                        }}
                      >
                        <FeishuSelect
                          ariaLabel={t("选择组成员")}
                          value={String(effectiveGroupPick)}
                          options={
                            availableGroupMembers.length === 0
                              ? [{ value: "0", label: t("暂无可添加的空间成员") }]
                              : availableGroupMembers.map((m) => ({ value: String(m.userId), label: `${m.name} (${m.email})` }))
                          }
                          onChange={(val) => setGroupMemberId(Number(val))}
                          disabled={availableGroupMembers.length === 0}
                          className="h-9 min-w-44 shrink flex-1 border bg-surface px-2.5 text-[13px] disabled:opacity-60"
                          menuMinWidth={200}
                        />
                        <button type="submit" disabled={!effectiveGroupPick || busy} className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-[13px] font-medium text-white disabled:opacity-50">
                          <UserPlus size={14} />{t("添加到用户组")}
                        </button>
                      </form>
                    )}
                    <div className="mt-4 space-y-2">
                      {activeGroup.members.length === 0 ? (
                        <p className="py-6 text-center text-[13px] text-subtle">{t("当前用户组暂无成员")}</p>
                      ) : (
                        activeGroup.members.map((member) => (
                          <div key={member.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                            <div className="flex min-w-0 items-center gap-2.5">
                              <Avatar name={member.name} color={colorFor(member.userId - 1)} size={28} />
                              <div className="min-w-0">
                                <p className="truncate text-[13px] font-medium">{member.name}</p>
                                <p className="truncate text-[12px] text-subtle">{member.email}</p>
                              </div>
                            </div>
                            {canAdmin && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void runMutation(() => orgApi.setGroupMember(effectiveWsId, activeGroup.id, me.user.id, member.userId, false), t("已移出用户组"))}
                                className="h-7 rounded border px-2 text-[12px] text-destructive hover:bg-destructive/5"
                              >
                                {t("移出")}
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </section>
            </div>
          )}

          {data && tab === "members" && (
            <section className="rounded-lg border bg-surface p-4">
              {canAdmin && (
                <form
                  className="mb-4 flex flex-wrap items-center gap-2 border-b pb-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!inviteEmail.trim()) return;
                    void runMutation(async () => {
                      const change = await orgApi.upsertMember(effectiveWsId, me.user.id, inviteEmail.trim(), inviteRole);
                      setInviteEmail("");
                      return change?.status === "invited" ? t("已发送邀请，对方接受后加入空间") : t("成员角色已更新");
                    }, t("已更新空间成员"));
                  }}
                >
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder={t("输入邮箱邀请加入当前企业空间")}
                    className="h-9 min-w-52 flex-1 rounded-md border px-3 text-[14px]"
                  />
                  <FeishuSelect
                    ariaLabel={t("成员角色")}
                    value={inviteRole}
                    options={[
                      { value: "member", label: t("普通成员") },
                      { value: "admin", label: t("管理员") },
                    ]}
                    onChange={(val) => setInviteRole(val as "member" | "admin")}
                    className="h-9 border bg-surface px-2.5 text-[13px]"
                    menuMinWidth={112}
                  />
                  <button type="submit" disabled={!inviteEmail.trim() || busy} className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-[13px] font-medium text-white disabled:opacity-50">
                    <UserPlus size={14} />{t("邀请加入空间")}
                  </button>
                </form>
              )}
              <div className="space-y-2">
                {members.map((member: WorkspaceMemberInfo) => (
                  <div key={member.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={member.name} color={colorFor(member.userId - 1)} size={30} />
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium">{member.name}</p>
                        <p className="truncate text-[12px] text-subtle">{member.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {canAdmin && member.role !== "owner" ? (
                        <>
                          <FeishuSelect
                            ariaLabel={t("调整{name}的空间角色", { name: member.name })}
                            value={member.role}
                            disabled={busy}
                            options={[
                              { value: "member", label: t("普通成员") },
                              { value: "admin", label: t("管理员") },
                            ]}
                            onChange={(val) => {
                              if (val !== member.role) {
                                void runMutation(async () => {
                                  await orgApi.upsertMember(effectiveWsId, me.user.id, member.email, val as "member" | "admin");
                                }, t("成员角色已更新"));
                              }
                            }}
                            className="h-8 border bg-surface px-2 text-[13px]"
                            menuMinWidth={108}
                          />
                          {isOwner && member.userId !== me.user.id && (
                            <button
                              type="button"
                              data-transfer-owner={member.userId}
                              disabled={busy}
                              onClick={() => void handleTransferOwner(member)}
                              className="inline-flex h-8 items-center gap-1 rounded-md border border-amber-300 bg-amber-50/70 px-2.5 text-[12px] font-medium text-amber-800 hover:bg-amber-100/80 disabled:opacity-50 dark:border-amber-700/70 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/50"
                            >
                              <Crown size={12} />
                              {t("转让所有者")}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void runMutation(async () => {
                              await orgApi.upsertMember(effectiveWsId, me.user.id, member.email, "remove");
                            }, t("已移出空间"))}
                            className="h-8 rounded-md border px-2.5 text-[12px] text-destructive hover:bg-destructive/5"
                          >
                            {t("移出空间")}
                          </button>
                        </>
                      ) : (
                        <span className="rounded bg-sidebar px-2.5 py-1 text-[12px] text-muted-foreground">{t(WS_ROLE_LABELS[member.role] ?? "普通成员")}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {canAdmin && (data.invitations?.length ?? 0) > 0 && (
                <div className="mt-5" data-org-invitations>
                  <p className="mb-2 text-[12px] font-medium text-subtle">{t("待接受的邀请")}</p>
                  <div className="space-y-2">
                    {data.invitations!.map((inv) => (
                      <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2" data-org-invitation>
                        <div className="min-w-0">
                          <p className="truncate text-[14px]">{inv.email}</p>
                          <p className="truncate text-[12px] text-subtle">{t(WS_ROLE_LABELS[inv.role] ?? "普通成员")} · {t("等待对方接受")}</p>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void runMutation(() => orgApi.revokeInvitation(effectiveWsId, inv.id, me.user.id), t("已撤销邀请"))}
                          className="h-8 rounded-md border px-2.5 text-[12px] text-muted-foreground hover:bg-hover"
                        >
                          {t("撤销邀请")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {data && tab === "sync" && (
            <OrgSyncPanel workspaceId={effectiveWsId} userId={me.user.id} canAdmin={canAdmin} />
          )}

          {data && tab === "sso" && (
            <OrgSSOPanel workspaceId={effectiveWsId} userId={me.user.id} canAdmin={canAdmin} />
          )}

          {data && tab === "security" && (
            <OrgAuditPanel
              workspaceId={effectiveWsId}
              userId={me.user.id}
              userName={me.user.name}
              userEmail={me.user.email}
              canAdmin={canAdmin}
            />
          )}

          {data && tab === "webhooks" && (
            <OrgWebhooksPanel workspaceId={effectiveWsId} userId={me.user.id} canAdmin={canAdmin} />
          )}

          {data && tab === "notifications" && (
            <OrgNotificationsPanel workspaceId={effectiveWsId} userId={me.user.id} canAdmin={canAdmin} />
          )}

          {data && tab === "developer" && (
            <OrgDeveloperPanel workspaceId={effectiveWsId} canAdmin={canAdmin} />
          )}
        </div>
      </div>
    </main>
  );
}
