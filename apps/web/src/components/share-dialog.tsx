import { useEffect, useLayoutEffect, useId, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, commentsApi, docsApi, orgApi, type DocMeta, type Role, type ShareInfo } from "@/lib/api";
import { colorFor } from "@/lib/presence";
import { Avatar } from "@/components/brand";
import { AddIcon, ArrowDownIcon, ArrowRightIcon, BuildingIcon, HelpIcon, LinkIcon, SettingIcon } from "@/components/feishu-icons";
import { Check, FolderTree, QrCode, Users, X } from "lucide-react";
import { t, useI18n } from "@/lib/i18n";
import { ShareQRCode, verifiedDirectShareUrl, verifiedShareUrl } from "@/components/share-link";
import { invitationConflict, inviteCandidates } from "@/components/share-invite";
import { changeContentPermission, contentPermissions, copyProtectionError, SharePermissions } from "@/components/share-permissions";
import { ShareLinkAccessSelect, ShareLinkScopeSelect } from "@/components/share-link-controls";

export const ROLE_LABEL: Record<string, string> = { view: "可阅读", edit: "可编辑", manage: "可管理", anon: "任何人可读", none: "关闭", workspace_view: "可阅读", workspace_edit: "可编辑" };

export function ShareDialog({ meta, userId, onClose, anchorRef }: { meta: DocMeta; userId: number; onClose: () => void; anchorRef?: RefObject<HTMLButtonElement | null> }) {
  const qc = useQueryClient();
  const key = ["shares", meta.id, userId];
  const info = useQuery({ queryKey: key, queryFn: () => docsApi.sharesForAccount(meta.id, userId), refetchOnMount: "always", refetchOnWindowFocus: true, refetchInterval: 15000 });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("edit");
  const [inviteMode, setInviteMode] = useState<"user" | "subject">("user");
  const [subjectPick, setSubjectPick] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [linkNotice, setLinkNotice] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const listId = useId();
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsBackRef = useRef<HTMLButtonElement>(null);
  const restoreSettingsFocus = useRef(false);
  const initialFocusDone = useRef(false);
  useEffect(() => { if (!info.data || initialFocusDone.current) return; initialFocusDone.current = true; if (typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches) emailRef.current?.focus(); }, [info.data]);
  useLayoutEffect(() => {
    const place = () => {
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = Math.min(480, Math.max(0, viewportWidth - 32));
      const rect = anchorRef?.current?.getBoundingClientRect();
      const left = rect ? Math.max(leftEdge + 16, Math.min(rect.right - width, leftEdge + viewportWidth - width - 16)) : leftEdge + viewportWidth - width - 16;
      const top = Math.max(topEdge + 8, Math.min(rect ? rect.bottom + 6 : topEdge + 64, topEdge + viewportHeight - 120));
      setPosition({ width, left, top, maxHeight: Math.max(100, topEdge + viewportHeight - top - 16) });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => { window.removeEventListener("resize", place); window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place); };
  }, [anchorRef]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeRef.current(); };
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("keydown", close); anchorRef?.current?.focus(); };
  }, [anchorRef]);
  const manage = !info.isError && info.data?.role === "manage";
  const settingsKey = ["share-settings", meta.id];
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => docsApi.get(meta.id), enabled: meta.kind !== "base" && meta.kind !== "slides" && meta.kind !== "file" && showSettings && manage && !info.isFetching, refetchOnMount: "always", refetchOnWindowFocus: true, refetchInterval: 15000, retry: false, gcTime: 0 });
  const settingsContext = useRef({ id: meta.id, canManage: false });
  settingsContext.current = { id: meta.id, canManage: !!manage && !info.isFetching && showSettings };
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const memberKey = ["share-member-suggestions", meta.id];
  const directory = useQuery({ queryKey: memberKey, queryFn: () => commentsApi.members(meta.id), enabled: manage && !info.isFetching && suggestOpen && !!email.trim(), refetchOnMount: "always", refetchOnWindowFocus: true, gcTime: 0 });
  const workspaceId = info.data?.workspaceId ?? meta.workspaceId;
  const orgKey = ["share-org-subjects", workspaceId, userId];
  const orgDirectory = useQuery({ queryKey: orgKey, queryFn: () => orgApi.get(workspaceId, userId), enabled: manage && !info.isFetching && inviteMode === "subject" && workspaceId > 0, refetchOnMount: "always", gcTime: 0 });
  useEffect(() => () => { qc.removeQueries({ queryKey: ["share-member-suggestions", meta.id], exact: true }); qc.removeQueries({ queryKey: ["share-settings", meta.id], exact: true }); qc.removeQueries({ queryKey: ["shares", meta.id, userId], exact: true }); }, [qc, meta.id, userId]);
  useEffect(() => { if (!manage) qc.removeQueries({ queryKey: ["share-member-suggestions", meta.id], exact: true }); }, [manage, qc, meta.id]);
  const subjects = info.data?.subjects ?? [];
  const grantedSubjectKeys = new Set(subjects.map((s) => `${s.subjectType}:${s.subjectId}`));
  const subjectOptions = [
    ...(orgDirectory.data?.departments ?? []).filter((d) => !grantedSubjectKeys.has(`department:${d.id}`)).map((d) => ({
      value: `department:${d.id}`,
      subjectType: "department" as const,
      subjectId: d.id,
      label: `${t("部门")} · ${d.name}${t("（含下级）")}`,
    })),
    ...(orgDirectory.data?.groups ?? []).filter((g) => !grantedSubjectKeys.has(`group:${g.id}`)).map((g) => ({
      value: `group:${g.id}`,
      subjectType: "group" as const,
      subjectId: g.id,
      label: `${t("用户组")} · ${g.name}`,
    })),
  ];
  const selectedSubject = subjectOptions.find((opt) => opt.value === subjectPick) ?? subjectOptions[0];
  const candidates = !directory.isFetching && !directory.isError && manage && !info.isFetching && suggestOpen && email.trim()
    ? inviteCandidates(email, directory.data ?? [], info.data!, meta.creatorId) : [];
  const selectCandidate = (address: string) => { setEmail(address); setSuggestOpen(false); setSuggestIndex(-1); emailRef.current?.focus(); };
  // Serialize all changes from this dialog. Mutation responses are not written
  // into the query cache: only a fresh read may repopulate the link and roles.
  const update = async (task: () => Promise<void>, kind: "invite" | "link" | "settings") => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setShowQr(false);
    setCopied(false);
    setCopyError(false);
    setErr("");
    setLinkError("");
    setLinkNotice("");
    setSettingsError("");
    try {
      await qc.cancelQueries({ queryKey: key });
      await task();
    } catch (e) {
      if (kind === "link") setLinkError(e instanceof ApiError && e.status === 409 ? t("链接设置已被其他人修改，请确认最新设置后重试。") : e instanceof TypeError || e instanceof Error && e.name === "AbortError" ? t("网络连接中断，更新结果可能尚未确认，请查看最新设置。") : t("更新链接权限失败，请重试。"));
      else if (kind === "settings") setSettingsError(copyProtectionError(e));
      else setErr(e instanceof TypeError ? t("网络连接中断，更新结果可能尚未确认，请查看协作者列表。") : e instanceof Error ? e.message : t("更新协作者失败"));
    } finally {
      await qc.cancelQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: key });
      if (kind === "settings") {
        await qc.invalidateQueries({ queryKey: ["doc", meta.id] });
        await qc.invalidateQueries({ queryKey: settingsKey });
      }
      busyRef.current = false;
      setBusy(false);
    }
  };
  const inviteNew = (address: string) => update(async () => {
    // Revalidate immediately before submitting; the server also needs an atomic
    // create-only operation to guard a competing administrator in another tab.
    const [current, users] = await Promise.all([docsApi.sharesForAccount(meta.id, userId), commentsApi.members(meta.id)]);
    if (current.role !== "manage") throw new Error(t("你已没有管理权限，请刷新后重试。"));
    const conflict = invitationConflict(address, current, users, meta.creatorId);
    if (conflict) throw new Error(conflict === "owner" ? t("该用户是文档所有者。") : t("该用户已是协作者，请在协作者列表中修改权限。"));
    try { await docsApi.share(meta.id, address, role, true); }
    catch (e) {
      if (e instanceof ApiError && e.code === "already_shared") throw new Error(t("该用户已是协作者或文档所有者，请在协作者列表中查看。"));
      throw e;
    }
    setEmail("");
    setSuggestOpen(false);
  }, "invite");
  const linkRole = info.data?.link.role ?? "none";
  const linkRevision = info.data?.link.revision;
  const linkEditable = !!manage && !busy && !info.isFetching && Number.isSafeInteger(linkRevision) && linkRevision! >= 0 && linkRevision! < Number.MAX_SAFE_INTEGER && Number.isSafeInteger(userId) && userId > 0;
  const changeLink = (next: ShareInfo["link"]["role"]) => {
    if (!linkEditable || next === linkRole || linkRevision === undefined) return;
    const workspaceBoundary = linkRole !== "none" && next !== "none" && (linkRole.startsWith("workspace_") !== next.startsWith("workspace_"));
    void update(async () => { const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 10_000); try { await docsApi.setLinkAtRevision(meta.id, next, linkRevision, userId, controller.signal); if (workspaceBoundary && mountedRef.current) setLinkNotice(t("访问范围已变更，请重新复制链接。")); } finally { window.clearTimeout(timer); } }, "link");
  };
  const verified = !info.isFetching && !info.isError && !busy;
  const url = verifiedShareUrl(info.data, location.origin, verified) || verifiedDirectShareUrl(info.data, meta, location.origin, location.pathname, verified);
  const linkDescription = linkRole === "none" ? t("已有文档访问权限的人可访问") : linkRole === "anon" ? t("获得链接的人可阅读") : linkRole === "workspace_view" || linkRole === "workspace_edit" ? t("获得链接的当前空间成员{role}，已有更高权限不变", { role: t(ROLE_LABEL[linkRole]) }) : t("获得链接的登录用户{role}", { role: t(ROLE_LABEL[linkRole] ?? "可访问") });
  const permissions = contentPermissions(settings.data);
  const settingsReady = manage && !info.isFetching && !settings.isError && !settings.isFetching && settings.data?.role === "manage" && !!permissions;
  const settingsMessage = settingsError || (info.isError || settings.isError ? t("无法验证权限设置，请返回后重试。") : settings.data && settings.data.role !== "manage" ? t("你已没有管理权限。") : !manage && !info.isFetching ? t("你已没有管理权限。") : settings.data && !permissions ? t("当前服务不支持分项权限设置，请刷新后重试。") : "");
  useLayoutEffect(() => {
    if (!showSettings) {
      if (restoreSettingsFocus.current) {
        restoreSettingsFocus.current = false;
        (settingsButtonRef.current ?? emailRef.current ?? anchorRef?.current)?.focus();
      }
      return;
    }
    const keepFocus = () => {
      const active = document.activeElement;
      if (!dialogRef.current?.contains(active) || (active instanceof HTMLElement && active.matches(":disabled"))) settingsBackRef.current?.focus();
    };
    keepFocus();
    document.addEventListener("focusin", keepFocus);
    return () => document.removeEventListener("focusin", keepFocus);
  }, [showSettings, busy, settingsReady, anchorRef]);
  return (
    <div className={`fixed inset-0 z-40 ${showSettings && meta.kind !== "base" ? "bg-black/30" : ""}`} onMouseDown={onClose}>
      <section ref={dialogRef} role="dialog" aria-modal={showSettings && meta.kind !== "base" ? true : undefined} aria-labelledby="share-title" data-share-dialog onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (!showSettings || meta.kind === "base" || event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]"));
        if (!focusable.length) { event.preventDefault(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }} style={showSettings && meta.kind !== "base" ? { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "min(500px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 32px)" } : position ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight } : { right: 16, top: 54, width: "min(480px, calc(100vw - 32px))" }} className="fixed flex max-h-[calc(100vh-2rem)] flex-col overflow-y-auto rounded-lg border bg-surface text-[14px] shadow-[0_8px_24px_rgba(31,35,41,0.16)]">
        {showSettings && meta.kind !== "base" ? <SharePermissions
          permissions={permissions}
          busy={busy}
          loading={info.isFetching || settings.isFetching || (manage && !settings.data && !settings.isError)}
          enabled={!!settingsReady}
          error={settingsMessage}
          backRef={settingsBackRef}
          showComment
          onBack={() => { restoreSettingsFocus.current = true; setShowSettings(false); setSettingsError(""); }}
          onChange={(permissionKey, next) => {
            if (!settingsReady || !permissions) return;
            const expected = permissions;
            const id = meta.id;
            void update(() => changeContentPermission(expected, permissionKey, next, () => docsApi.get(id), (value, expectedRevision) => docsApi.setContentPermissions(id, value, expectedRevision), () => mountedRef.current && settingsContext.current.id === id && settingsContext.current.canManage), "settings");
          }}
        /> : <>
        <header className="flex h-[45px] items-center justify-between px-4">
          <h2 id="share-title" className="flex items-center gap-1 text-[16px] font-semibold">分享{meta.kind === "base" ? t("多维表格") : meta.kind === "sheet" ? t("表格") : meta.kind === "slides" ? t("幻灯片") : meta.kind === "file" ? t("文件") : t("文档")}<HelpIcon className="size-[13px] text-muted-foreground" /></h2>
          <div className="flex items-center gap-1">{meta.kind === "base" || meta.kind === "slides" || meta.kind === "file" ? <button type="button" onClick={() => setShowMembers((v) => !v)} aria-expanded={showMembers} className="flex h-7 items-center gap-1 rounded-md px-1 text-[13px] text-muted-foreground hover:bg-hover" title={t("查看协作者及权限")}><SettingIcon className="size-[14px]" />{t("协作者")}</button> : manage && <button ref={settingsButtonRef} type="button" aria-disabled={busy || info.isFetching} onClick={() => { if (busy || info.isFetching) return; setSettingsError(""); setShowSettings(true); }} className="flex h-7 items-center gap-1 rounded-md px-1 text-[13px] text-muted-foreground hover:bg-hover aria-disabled:opacity-50"><SettingIcon className="size-[14px]" />{t("权限设置")}</button>}<button type="button" onClick={onClose} aria-label={t("关闭分享")} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover sm:sr-only sm:focus:not-sr-only"><X size={15}/></button></div>
        </header>
        {info.isPending && <p className="px-4 py-2 text-[13px] text-subtle">{t("正在加载分享设置…")}</p>}
        {info.isError && <p role="alert" className="px-4 py-2 text-[13px] text-destructive">{t("加载分享设置失败，请关闭后重试。")}</p>}
        {info.data && !info.isError && <>
          <div className="flex h-[54px] items-center justify-between px-4">
            <span className="font-medium">{t("邀请协作者")}</span>
            <button type="button" className="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-hover" onClick={() => setShowMembers((v) => !v)} aria-label={t("查看协作者")} aria-expanded={showMembers}>
              {info.data.members.length + subjects.length > 0 && <span className="rounded-full bg-sidebar px-1.5 py-0.5 text-[11px] text-muted-foreground">+{info.data.members.length + subjects.length}</span>}
              <Avatar name={meta.creatorName} color={colorFor(meta.creatorId - 1)} size={26} />
              <ArrowRightIcon className={`size-3 text-subtle transition-transform ${showMembers ? "rotate-90" : ""}`} />
            </button>
          </div>
          {showMembers && <div className="mx-4 mb-3 max-h-48 space-y-3 overflow-y-auto rounded-md bg-sidebar/60 p-3">
            <div className="flex items-center gap-2"><Avatar name={meta.creatorName} color={colorFor(meta.creatorId - 1)} size={28}/><span className="min-w-0 flex-1 truncate">{meta.creatorName}</span><span className="text-[13px] text-muted-foreground">{t("所有者")}</span></div>
            {subjects.map((s) => (
              <div key={`${s.subjectType}:${s.subjectId}`} data-share-subject-row={`${s.subjectType}:${s.subjectId}`} className="flex items-center gap-2">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                  {s.subjectType === "department" ? <FolderTree size={14} /> : <Users size={14} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.name}</span>
                  <span className="block truncate text-[11px] text-subtle">{s.subjectType === "department" ? t("部门 · 含下级") : t("用户组")}</span>
                </span>
                {manage ? (
                  <RoleSelect
                    label={t("{name}的权限", { name: s.name })}
                    value={s.role}
                    options={["view", "edit", "manage", "remove"]}
                    disabled={busy || info.isFetching}
                    onChange={(r) => {
                      void update(async () => {
                        await docsApi.setSubjectShare(meta.id, s.subjectType, s.subjectId, r === "remove" ? "" : r as Role, userId);
                      }, "invite");
                    }}
                  />
                ) : (
                  <span className="text-[13px] text-muted-foreground">{t(ROLE_LABEL[s.role])}</span>
                )}
              </div>
            ))}
            {info.data.members.map((m) => <div key={m.userId} className="flex items-center gap-2"><Avatar name={m.name} color={colorFor(m.userId - 1)} size={28}/><span className="min-w-0 flex-1 truncate">{m.name}</span>{manage ? <RoleSelect label={t("{name}的权限", { name: m.name })} value={m.role} options={["view", "edit", "manage", "remove"]} disabled={busy || info.isFetching} onChange={(r) => { void update(async () => { await docsApi.share(meta.id, m.email, r === "remove" ? "" : r as Role); }, "invite"); }} /> : <span className="text-[13px] text-muted-foreground">{t(ROLE_LABEL[m.role])}</span>}</div>)}
          </div>}
          {manage && <div className="mx-4 mb-2 flex items-center gap-1 text-[12px]">
            <button type="button" data-share-target-mode="user" onClick={() => setInviteMode("user")} className={`rounded-md px-2.5 py-1 ${inviteMode === "user" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-hover"}`}>{t("按用户")}</button>
            <button type="button" data-share-target-mode="subject" onClick={() => setInviteMode("subject")} className={`rounded-md px-2.5 py-1 ${inviteMode === "subject" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-hover"}`}>{t("按部门或用户组")}</button>
          </div>}
          {manage && inviteMode === "user" && <form className="relative mx-4 flex h-9 items-center rounded-md border border-input focus-within:border-primary" onSubmit={(e) => { e.preventDefault(); if (email.trim()) { setSuggestOpen(false); void inviteNew(email.trim()); } }}>
            <input ref={emailRef} aria-label={t("搜索协作者姓名或邮箱")} role="combobox" disabled={busy} aria-autocomplete="list" aria-expanded={candidates.length > 0} aria-controls={listId} aria-activedescendant={suggestIndex >= 0 && candidates[suggestIndex] ? `${listId}-${candidates[suggestIndex].id}` : undefined} value={email} onFocus={() => setSuggestOpen(true)} onBlur={() => setSuggestOpen(false)} onChange={(e) => { setEmail(e.target.value); setSuggestOpen(true); setSuggestIndex(-1); }} onKeyDown={(e) => {
              if (e.key === "ArrowDown" && candidates.length) { e.preventDefault(); setSuggestIndex((i) => (i + 1) % candidates.length); }
              if (e.key === "ArrowUp" && candidates.length) { e.preventDefault(); setSuggestIndex((i) => (i <= 0 ? candidates.length - 1 : i - 1)); }
              if (e.key === "Enter" && suggestIndex >= 0 && candidates[suggestIndex]) { e.preventDefault(); selectCandidate(candidates[suggestIndex].email); }
              if (e.key === "Escape" && suggestOpen && candidates.length) { e.preventDefault(); setSuggestOpen(false); }
            }} placeholder={t("搜索姓名或邮箱，邀请协作者")} className="h-full min-w-0 flex-1 bg-transparent px-3 text-[16px] outline-none placeholder:text-subtle sm:text-[14px]" />
            {candidates.length > 0 && <div id={listId} role="listbox" aria-label={t("协作者建议")} className="absolute left-0 right-0 top-[38px] z-10 max-h-52 overflow-y-auto rounded-md border bg-surface p-1 shadow-lg">{candidates.map((member, i) => <div id={`${listId}-${member.id}`} role="option" aria-selected={i === suggestIndex} key={member.id} onMouseDown={(e) => e.preventDefault()} onClick={() => selectCandidate(member.email)} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${i === suggestIndex ? "bg-hover" : "hover:bg-hover"}`}><Avatar name={member.name} color={colorFor(member.id - 1)} size={28}/><span className="min-w-0"><span className="block truncate">{member.name}</span><span className="block truncate text-[12px] text-subtle">{member.email}</span></span></div>)}</div>}
            {email.trim() && <RoleSelect label={t("邀请权限")} disabled={busy} value={role} options={["view", "edit", "manage"]} onChange={(r) => setRole(r as Role)} />}
            <button type="submit" disabled={!email.trim() || busy} aria-label={t("邀请协作者")} className="grid h-full w-9 shrink-0 place-items-center border-l text-muted-foreground hover:bg-hover disabled:opacity-45"><AddIcon className="size-4"/></button>
          </form>}
          {manage && inviteMode === "subject" && <form className="mx-4 flex h-9 items-center rounded-md border border-input focus-within:border-primary" onSubmit={(e) => {
            e.preventDefault();
            if (!selectedSubject) return;
            void update(async () => {
              await docsApi.setSubjectShare(meta.id, selectedSubject.subjectType, selectedSubject.subjectId, role, userId);
              setSubjectPick("");
              setShowMembers(true);
            }, "invite");
          }}>
            <select
              aria-label={t("选择部门或用户组")}
              disabled={busy || orgDirectory.isFetching || subjectOptions.length === 0}
              value={selectedSubject?.value ?? ""}
              onChange={(e) => setSubjectPick(e.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent px-3 text-[13px] outline-none disabled:opacity-60"
            >
              {orgDirectory.isPending ? (
                <option value="">{t("正在加载组织架构…")}</option>
              ) : subjectOptions.length === 0 ? (
                <option value="">{t("暂无可添加的部门或用户组")}</option>
              ) : (
                subjectOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)
              )}
            </select>
            {selectedSubject && <RoleSelect label={t("邀请权限")} disabled={busy} value={role} options={["view", "edit", "manage"]} onChange={(r) => setRole(r as Role)} />}
            <button type="submit" disabled={!selectedSubject || busy} aria-label={t("添加部门或用户组")} className="grid h-full w-9 shrink-0 place-items-center border-l text-muted-foreground hover:bg-hover disabled:opacity-45"><AddIcon className="size-4"/></button>
          </form>}
          {typeof info.data.inheritParentAcl === "boolean" && (
            <div data-share-inherit-section className="mx-4 mt-4 flex items-center justify-between gap-3 rounded-md border bg-sidebar/40 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{t("继承上级权限")}</p>
                <p className="text-[11px] leading-4 text-subtle">
                  {info.data.inheritParentAcl ? t("默认沿用上级文件夹或企业空间权限") : t("关闭后仅创建者、空间管理员及显式授权可访问")}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-label={t("继承上级权限")}
                aria-checked={info.data.inheritParentAcl}
                data-share-inherit-toggle
                disabled={!manage || busy || info.isFetching}
                onClick={() => {
                  if (!manage || info.data?.inheritParentAcl === undefined) return;
                  const next = !info.data.inheritParentAcl;
                  void update(async () => { await docsApi.setInheritance(meta.id, next, userId); }, "invite");
                }}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${info.data.inheritParentAcl ? "bg-primary" : "bg-black/20 dark:bg-white/25"}`}
              >
                <span className={`inline-block size-4 transform rounded-full bg-white shadow transition-transform ${info.data.inheritParentAcl ? "translate-x-4" : "translate-x-0.5"}`} />
              </button>
            </div>
          )}
          {err && <p role="alert" className="px-4 pt-2 text-[12px] text-destructive">{err}</p>}
          <div className="px-4 pb-6 pt-7">
            <p className="mb-4 font-medium">{t("链接分享")}</p>
            <div className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-[#1456f0] text-white"><BuildingIcon className="size-[15px]" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate leading-5"><ShareLinkScopeSelect role={linkRole} allowPublic={meta.kind !== "base" && meta.kind !== "slides" && meta.kind !== "file" && meta.kind !== "sheet"} disabled={!linkEditable} onChange={changeLink} /></span><span className="block break-words text-[12px] leading-[18px] text-subtle sm:truncate" title={linkDescription}>{linkDescription}</span></span>
              <ShareLinkAccessSelect role={linkRole} disabled={!linkEditable} onChange={changeLink} />
            </div>
            {linkError && <p role="alert" className="pt-2 text-[12px] text-destructive">{linkError}</p>}
            {linkNotice && <p role="status" className="pt-2 text-[12px] text-subtle">{linkNotice}</p>}
            {manage && !info.isFetching && (!Number.isSafeInteger(linkRevision) || linkRevision! < 0 || linkRevision! >= Number.MAX_SAFE_INTEGER) && <p role="status" className="pt-2 text-[12px] text-subtle">{t("当前服务暂不支持安全修改链接权限，请更新服务。")}</p>}
          </div>
          <footer className="flex min-h-[66px] items-center gap-2 bg-sidebar px-4 py-3">
            <button type="button" disabled={!url} title={!url ? t("无法验证分享链接") : linkRole === "none" ? t("已有文档访问权限的人可访问") : t("复制链接")} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50" onClick={async () => { try { if (!navigator.clipboard) throw new Error("clipboard unavailable"); await navigator.clipboard.writeText(url); setCopyError(false); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopyError(true); } }}>{copied ? <Check size={14}/> : <LinkIcon className="size-[14px]"/>}{copied ? t("已复制") : t("复制链接")}</button>
            <button type="button" aria-label={t("分享二维码")} aria-expanded={showQr && !!url} disabled={!url} title={!url ? t("开启链接分享后可查看二维码") : t("分享二维码")} onClick={() => setShowQr((value) => !value)} className="grid size-8 shrink-0 place-items-center rounded-full border text-muted-foreground hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"><QrCode size={15}/></button>
            {copyError && url && <input readOnly aria-label={t("分享链接")} value={url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded border bg-surface px-2 py-1 text-[12px]" />}
          </footer>
          {showQr && url && <div className="flex flex-col items-center gap-1 bg-sidebar px-4 pb-4 text-center"><ShareQRCode url={url}/><p className="text-[12px] text-muted-foreground">{t("扫码打开分享链接")}</p></div>}
          {copyError && url && <p role="alert" className="bg-sidebar px-4 pb-3 text-[12px] text-destructive">{t("复制失败，请手动选择链接。")}</p>}
        </>}
        </>}
      </section>
    </div>
  );
}
function RoleSelect({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (r: string) => void; options: string[]; disabled?: boolean }) {
  return <label className="relative inline-flex shrink-0 items-center"><span className="sr-only">{label}</span><select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="h-8 cursor-pointer appearance-none rounded-md bg-transparent pl-2 pr-5 text-[13px] text-muted-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/40">{options.map((o) => <option key={o} value={o}>{o === "remove" ? t("移除") : t(ROLE_LABEL[o])}</option>)}</select><ArrowDownIcon className="pointer-events-none absolute right-1.5 size-2 text-subtle"/></label>;
}
