import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu, ShieldAlert, X } from "lucide-react";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Me } from "@/lib/api";
import { MFA_STATUS_QUERY_KEY, mfaApi, type MfaStatus } from "@/lib/mfa-api";
import { announceAuthChange, createSessionQueryClient, subscribeAuthChanges } from "@/lib/session-cache";
import { useRoute } from "@/lib/route";
import { LoginPage } from "@/pages/login";
import { Sidebar } from "@/components/sidebar";
import { DriveUploadManager } from "@/pages/drive-upload";
import { DriveUploadStatus } from "@/components/drive-upload-status";
import { AskHost } from "@/components/ui/ask";
import { AISettingsHost } from "@/components/ai-settings";
import { AccountSecurityHost, openAccountSecurity } from "@/components/account-security-dialog";
import { OfflineBanner } from "@/components/offline-banner";
import { SidebarFoldIcon } from "@/components/feishu-icons";
import type { SearchGuardCapture } from "@/components/search-focus";
import { isDocumentSidebarShortcut } from "@/lib/sidebar-shortcut";
import { browserSidebarStorage, decodeSidebarPreference, readSidebarPreference, sidebarPreferenceKey, writeSidebarPreference } from "@/lib/sidebar-preference";
import { useI18n } from "@/lib/i18n";

const Home = lazy(() => import("@/pages/home").then((m) => ({ default: m.Home })));
const DocPage = lazy(() => import("@/pages/doc-page").then((m) => ({ default: m.DocPage })));
const ResourceTypeNotice = lazy(() => import("@/pages/resource-type-notice").then((m) => ({ default: m.ResourceTypeNotice })));
const Playground = lazy(() => import("@/pages/playground").then((m) => ({ default: m.Playground })));
const Trash = lazy(() => import("@/pages/trash").then((m) => ({ default: m.Trash })));
const JoinLink = lazy(() => import("@/pages/join-link").then((m) => ({ default: m.JoinLink })));
const BasePage = lazy(() => import("@/pages/base-page").then((m) => ({ default: m.BasePage })));
const SheetPage = lazy(() => import("@/pages/sheet/sheet-page").then((m) => ({ default: m.SheetPage })));
const SurveyPage = lazy(() => import("@/pages/survey/survey-page").then((m) => ({ default: m.SurveyPage })));
const PublicSurveyPage = lazy(() => import("@/pages/survey/public-survey-page").then((m) => ({ default: m.PublicSurveyPage })));
const PublicForm = lazy(() => import("@/pages/public-form").then((m) => ({ default: m.PublicForm })));
const PublicDoc = lazy(() => import("@/pages/public-doc").then((m) => ({ default: m.PublicDoc })));
const DrivePage = lazy(() => import("@/pages/drive-page").then((m) => ({ default: m.DrivePage })));
const SlidesDeck = lazy(() => import("@/pages/slides-page").then((m) => ({ default: m.SlidesDeck })));
const DriveFilePage = lazy(() => import("@/pages/drive-file-page").then((m) => ({ default: m.DriveFilePage })));
const OrgPage = lazy(() => import("@/pages/org/org-page").then((m) => ({ default: m.OrgPage })));
const WikiSpacesPage = lazy(() => import("@/pages/wiki/wiki-spaces-page").then((m) => ({ default: m.WikiSpacesPage })));
const WikiSpacePage = lazy(() => import("@/pages/wiki/wiki-space-page").then((m) => ({ default: m.WikiSpacePage })));
const WorkspaceAiDialog = lazy(() => import("@/components/workspace-ai-dialog").then((m) => ({ default: m.WorkspaceAiDialog })));

type ExtendedMfaStatus = MfaStatus & {
  mfaRequiredByPolicy?: boolean;
  mfaRequiredWorkspaces?: Array<string | { name?: string }>;
  mfaSetupRequired?: boolean;
};

function RouteLoadingFallback({ fullScreen = false }: { fullScreen?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-live="polite"
      data-route-loading
      className={fullScreen
        ? "flex h-full min-h-screen w-full flex-col items-center justify-center gap-2.5 bg-canvas p-6 text-[13px] text-subtle"
        : "flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 bg-canvas p-6 text-[13px] text-subtle"}
    >
      <span
        aria-hidden="true"
        className="size-6 animate-spin rounded-full border-2 border-[#3370ff]/20 border-t-[#3370ff]"
      />
      <span>{t("加载中…")}</span>
    </div>
  );
}

function GlobalMfaBanner() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const mfaQuery = useQuery<ExtendedMfaStatus | null>({
    queryKey: MFA_STATUS_QUERY_KEY,
    queryFn: async () => {
      try {
        return (await mfaApi.getStatus()) as ExtendedMfaStatus;
      } catch {
        return null;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    const onUpdated = () => {
      void qc.invalidateQueries({ queryKey: MFA_STATUS_QUERY_KEY });
    };
    window.addEventListener("jiange:mfa-updated", onUpdated);
    return () => window.removeEventListener("jiange:mfa-updated", onUpdated);
  }, [qc]);

  const status = mfaQuery.data;
  if (!status?.mfaSetupRequired || status.enabled) return null;

  const workspaceNames = (status.mfaRequiredWorkspaces ?? [])
    .map((w) => (typeof w === "string" ? w : w?.name ?? ""))
    .filter(Boolean)
    .join("、");

  return (
    <div
      role="alert"
      data-global-mfa-banner
      className="relative z-40 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-[13px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ShieldAlert size={16} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <span className="min-w-0 leading-5">
          {workspaceNames
            ? t("工作空间「{workspaces}」已强制要求开启双因素认证（TOTP 或通行密钥），请尽快完成配置。", { workspaces: workspaceNames })
            : t("所在工作空间已强制要求开启双因素认证（TOTP 或通行密钥），请尽快完成配置。")}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          data-global-mfa-setup-btn
          onClick={() => openAccountSecurity("mfa")}
          className="inline-flex h-7 items-center rounded-md bg-amber-600 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500"
        >
          {t("立即配置双因素认证")}
        </button>
        <button
          type="button"
          data-global-mfa-passkey-btn
          onClick={() => openAccountSecurity("passkey")}
          className="inline-flex h-7 items-center rounded-md border border-amber-400/80 bg-white/80 px-2.5 text-[12px] font-medium text-amber-900 transition-colors hover:bg-white dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/70"
        >
          {t("注册通行密钥")}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  const route = useRoute();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const [checkingAuth, setCheckingAuth] = useState(false);
  const [authCheckError, setAuthCheckError] = useState(false);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const authCheckGeneration = useRef(0);
  const refetchMe = me.refetch;
  const verifyExternalAuth = useCallback(async () => {
    const generation = ++authCheckGeneration.current;
    // Unmount the previous session immediately; no stale account UI is shown
    // while another tab's new cookie is being checked.
    setCheckingAuth(true);
    setAuthCheckError(false);
    setSessionGeneration((value) => value + 1);
    try {
      await qc.cancelQueries({ queryKey: ["me"], exact: true });
      const result = await refetchMe();
      if (generation === authCheckGeneration.current) setAuthCheckError(result.isError && !(result.error instanceof ApiError && result.error.status === 401));
    } catch {
      if (generation === authCheckGeneration.current) setAuthCheckError(true);
    } finally {
      if (generation === authCheckGeneration.current) setCheckingAuth(false);
    }
  }, [qc, refetchMe]);
  useEffect(() => subscribeAuthChanges(() => { void verifyExternalAuth(); }), [verifyExternalAuth]);
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => { announceAuthChange(); qc.clear(); },
  });
  const unauth = (me.error instanceof ApiError && me.error.status === 401) || me.data === null;

  // Public links must resolve before authentication is required.
  if (route.page === "public") return <Suspense fallback={<RouteLoadingFallback fullScreen />}><PublicDoc key={route.token} token={route.token} /></Suspense>;
  if (route.page === "public-survey") return <Suspense fallback={<RouteLoadingFallback fullScreen />}><PublicSurveyPage key={route.token} token={route.token} /></Suspense>;
  if (route.page === "form") {
    return <Suspense fallback={<RouteLoadingFallback fullScreen />}><PublicForm key={route.token} token={route.token} /></Suspense>;
  }
  if (route.page === "legacy-form") return <div className="grid min-h-full place-items-center p-6 text-center text-muted-foreground"><p>{t("此收集表链接已失效，请联系创建者获取新的分享链接。")}</p></div>;
  if (checkingAuth) return <div className="grid h-full place-items-center text-subtle">{t("正在确认账号…")}</div>;
  if (authCheckError) return <div className="grid h-full place-items-center text-destructive"><div>{t("无法确认当前账号。")}<button type="button" onClick={() => void verifyExternalAuth()} className="ml-2 underline">{t("重试")}</button></div></div>;
  if (me.isPending) return <div className="grid h-full place-items-center text-subtle">{t("加载中…")}</div>;
  if (unauth) return <LoginPage />;
  if (!me.data) return <div className="grid h-full place-items-center text-destructive">{t("无法连接服务器：{error}", { error: String(me.error) })}</div>;

  return <AuthenticatedApp key={`${me.data.user.id}:${sessionGeneration}`} me={me.data} route={route} authClient={qc} onLogout={() => logout.mutate()} />;
}

/** A new mount also creates a fresh cache after re-authenticating the same user. */
function AuthenticatedApp({ me, route, authClient, onLogout }: {
  me: Me;
  route: ReturnType<typeof useRoute>;
  authClient: ReturnType<typeof useQueryClient>;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const [sessionClient] = useState(() => createSessionQueryClient(authClient));
  const [uploads] = useState(() => new DriveUploadManager(me.user.id, () => { void sessionClient.invalidateQueries({ queryKey: ["drive"] }); void sessionClient.invalidateQueries({ queryKey: ["drive-nav"] }); void sessionClient.invalidateQueries({ queryKey: ["docs"] }); }));
  const globalSearch = useRef<(() => void) | null>(null);
  const globalSearchGuard = useRef<SearchGuardCapture | null>(null);
  const registerGlobalSearch = useCallback((open: (() => void) | null) => { globalSearch.current = open; }, []);
  const registerGlobalSearchGuard = useCallback((capture: SearchGuardCapture | null) => { globalSearchGuard.current = capture; }, []);
  const openGlobalSearch = useCallback(() => globalSearch.current?.(), []);
  const captureGlobalSearchGuard = useCallback(() => globalSearchGuard.current?.() ?? null, []);
  useEffect(() => { uploads.activate(); return () => uploads.dispose(); }, [uploads]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceAiOpen, setWorkspaceAiOpen] = useState(false);
  useEffect(() => {
    const onOpenAi = () => setWorkspaceAiOpen(true);
    const onWorkspacesChanged = () => { void authClient.invalidateQueries({ queryKey: ["me"], exact: true }); };
    window.addEventListener("jiange:open-workspace-ai", onOpenAi);
    window.addEventListener("jiange:workspaces-changed", onWorkspacesChanged);
    return () => {
      window.removeEventListener("jiange:open-workspace-ai", onOpenAi);
      window.removeEventListener("jiange:workspaces-changed", onWorkspacesChanged);
    };
  }, [authClient]);
  const [sidebarStorage] = useState(browserSidebarStorage);
  const [docSidebarDocked, setDocSidebarDocked] = useState(() => readSidebarPreference(sidebarStorage, me.user.id));
  const docSidebarDockedRef = useRef(docSidebarDocked);
  const openSidebarButton = useRef<HTMLButtonElement>(null);
  const sidebarContainer = useRef<HTMLDivElement>(null);
  const restoreRemoteSidebarFocus = useRef(false);
  const docLayout = route.page === "doc";
  const setDocumentSidebar = (expanded: boolean) => {
    docSidebarDockedRef.current = expanded;
    setDocSidebarDocked(expanded);
    writeSidebarPreference(sidebarStorage, me.user.id, expanded);
  };
  useEffect(() => setSidebarOpen(false), [
    route.page,
    "id" in route ? route.id : null,
    "folderId" in route ? route.folderId : null,
    "personal" in route ? route.personal : null,
    "spaceId" in route ? route.spaceId : null,
    "nodeId" in route ? route.nodeId : null,
  ]);
  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    requestAnimationFrame(() => openSidebarButton.current?.focus());
  }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      closeSidebar();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen, closeSidebar]);
  useEffect(() => {
    if (!sidebarStorage) return;
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== sidebarStorage || (event.key !== sidebarPreferenceKey(me.user.id) && event.key !== null)) return;
      const expanded = decodeSidebarPreference(event.key === null ? null : event.newValue);
      const focusWasInside = docLayout && !expanded && docSidebarDockedRef.current && window.matchMedia("(min-width: 768px)").matches && !!sidebarContainer.current?.contains(document.activeElement);
      restoreRemoteSidebarFocus.current = focusWasInside;
      docSidebarDockedRef.current = expanded;
      setDocSidebarDocked(expanded);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [sidebarStorage, me.user.id, docLayout]);
  useLayoutEffect(() => {
    if (!docSidebarDocked && restoreRemoteSidebarFocus.current) openSidebarButton.current?.focus();
    restoreRemoteSidebarFocus.current = false;
  }, [docSidebarDocked]);
  useEffect(() => {
    if (!docLayout) return;
    const keydown = (event: KeyboardEvent) => {
      if (!isDocumentSidebarShortcut(event) || !window.matchMedia("(min-width: 768px)").matches || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      const focusWasInside = !!sidebarContainer.current?.contains(document.activeElement);
      const wasDocked = docSidebarDockedRef.current;
      setDocumentSidebar(!wasDocked);
      if (wasDocked && focusWasInside) requestAnimationFrame(() => openSidebarButton.current?.focus());
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [docLayout, sidebarStorage, me.user.id]);
  const openSidebar = () => {
    const dock = docLayout && window.matchMedia("(min-width: 768px)").matches;
    if (dock) setDocumentSidebar(true);
    else setSidebarOpen(true);
    requestAnimationFrame(() => sidebarContainer.current?.querySelector<HTMLButtonElement>(dock ? "[data-collapse-navigation]" : "[data-close-navigation]")?.focus());
  };
  const collapseDocumentSidebar = () => {
    setDocumentSidebar(false);
    requestAnimationFrame(() => openSidebarButton.current?.focus());
  };
  const sidebarClass = docLayout
    ? `${sidebarOpen ? "block" : "hidden"} fixed inset-y-0 left-0 z-50 max-w-[85vw] shadow-xl md:max-w-none md:shadow-none ${docSidebarDocked ? "md:static md:z-auto md:block" : "md:hidden"}`
    : `${sidebarOpen ? "block" : "hidden"} fixed inset-y-0 left-0 z-50 max-w-[85vw] shadow-xl md:max-w-none md:shadow-none ${route.page === "base" || route.page === "slides" || route.page === "sheet" || route.page === "survey" || route.page === "wiki-space" ? "md:hidden" : "md:static md:block"}`;
  return (
    <QueryClientProvider client={sessionClient}>
    <div className="flex h-full min-w-0 flex-col">
      <GlobalMfaBanner />
      <div className="relative flex min-h-0 flex-1 min-w-0" data-mobile-nav-open={sidebarOpen ? "true" : "false"}>
        <AskHost />
        <AISettingsHost />
        <AccountSecurityHost />
        {workspaceAiOpen && (
          <Suspense fallback={null}>
            <WorkspaceAiDialog open={workspaceAiOpen} onClose={() => setWorkspaceAiOpen(false)} workspaceId={me.workspaces[0]?.id} />
          </Suspense>
        )}
        <OfflineBanner />
        <button type="button" ref={openSidebarButton} className={`absolute left-3 top-3 z-30 grid size-9 place-items-center rounded-lg border border-[#dee0e3]/80 bg-surface/90 text-muted-foreground shadow-xs backdrop-blur-sm transition-colors hover:bg-hover dark:border-border/80 md:border-0 md:bg-transparent md:shadow-none md:backdrop-blur-none ${docLayout && !docSidebarDocked ? "md:top-3.5" : "md:hidden"}`} onClick={openSidebar} aria-label={t("打开导航")} aria-expanded={sidebarOpen} aria-controls="workspace-navigation" aria-keyshortcuts={docLayout ? "Meta+] Control+]" : undefined}>{docLayout ? <SidebarFoldIcon collapsed className="size-4" /> : <Menu size={20} />}</button>
        {sidebarOpen && <button type="button" data-mobile-nav-backdrop className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] transition-opacity md:hidden" aria-label={t("关闭导航")} onClick={closeSidebar} />}
        <div id="workspace-navigation" ref={sidebarContainer} className={sidebarClass}>
          <Sidebar me={me} route={route} onLogout={() => { uploads.cancel(); onLogout(); }} onCollapse={docLayout && docSidebarDocked ? collapseDocumentSidebar : undefined} onSearchRegistrar={registerGlobalSearch} captureSearchGuard={captureGlobalSearchGuard} onWorkspacesChanged={() => { void authClient.invalidateQueries({ queryKey: ["me"], exact: true }); }} />
          <button type="button" className="absolute right-3 top-4 grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover md:hidden" onClick={closeSidebar} aria-label={t("关闭导航")} data-close-navigation><X size={16} /></button>
        </div>
        <Suspense fallback={<RouteLoadingFallback />}>
          {route.page === "doc" ? (
            <DocPage key={route.id} id={route.id} linkedVersion={route.versionId} me={me} sidebarDocked={docSidebarDocked} onGlobalSearch={openGlobalSearch} onSearchGuardRegistrar={registerGlobalSearchGuard} />
          ) : route.page === "unsupported" ? (
            <ResourceTypeNotice id={route.id} />
          ) : route.page === "base" ? (
            <BasePage key={`${route.id}:${me.user.id}`} id={route.id} userId={me.user.id} me={me} />
          ) : route.page === "join" ? (
            <JoinLink token={route.token} userId={me.user.id} />
          ) : route.page === "drive" ? (
            <DrivePage key={`${route.folderId ?? 0}:${route.personal}`} folderId={route.folderId} personalRoot={route.personal} userId={me.user.id} uploads={uploads} />
          ) : route.page === "file" ? (
            <DriveFilePage key={route.id} id={route.id} userId={me.user.id} />
          ) : route.page === "slides" ? (
            <SlidesDeck key={`${me.user.id}:${route.id}`} deckId={route.id} userId={me.user.id} me={me} />
          ) : route.page === "sheet" ? (
            <SheetPage key={`${me.user.id}:${route.id}`} sheetId={route.id} me={me} onGlobalSearch={openGlobalSearch} />
          ) : route.page === "survey" ? (
            <SurveyPage key={`${me.user.id}:${route.id}`} surveyId={route.id} />
          ) : route.page === "org" ? (
            <OrgPage me={me} />
          ) : route.page === "wiki" ? (
            <WikiSpacesPage me={me} />
          ) : route.page === "wiki-space" ? (
            <WikiSpacePage key={`${me.user.id}:${route.spaceId}`} spaceId={route.spaceId} nodeId={route.nodeId} me={me} onGlobalSearch={openGlobalSearch} onSearchGuardRegistrar={registerGlobalSearchGuard} />
          ) : route.page === "trash" ? (
            <Trash />
          ) : route.page === "favorites" ? (
            <Home me={me} uploads={uploads} favorites />
          ) : route.page === "playground" ? (
            <div className="flex-1 overflow-auto p-6">
              <Playground />
            </div>
          ) : (
            <Home me={me} uploads={uploads} recent={route.page === "recent"} />
          )}
        </Suspense>
        <DriveUploadStatus manager={uploads} />
      </div>
    </div>
    </QueryClientProvider>
  );
}
