import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Me } from "@/lib/api";
import { announceAuthChange, createSessionQueryClient, subscribeAuthChanges } from "@/lib/session-cache";
import { useRoute } from "@/lib/route";
import { LoginPage } from "@/pages/login";
import { Home } from "@/pages/home";
import { DocPage } from "@/pages/doc-page";
import { ResourceTypeNotice } from "@/pages/resource-type-notice";
import { Playground } from "@/pages/playground";
import { Sidebar } from "@/components/sidebar";
import { Trash } from "@/pages/trash";
import { JoinLink } from "@/pages/join-link";
import { BasePage } from "@/pages/base-page";
import { SheetPage } from "@/pages/sheet/sheet-page";
import { PublicForm } from "@/pages/public-form";
import { PublicDoc } from "@/pages/public-doc";
import { DrivePage } from "@/pages/drive-page";
import { SlidesDeck } from "@/pages/slides-page";
import { DriveFilePage } from "@/pages/drive-file-page";
import { DriveUploadManager } from "@/pages/drive-upload";
import { DriveUploadStatus } from "@/components/drive-upload-status";
import { AskHost } from "@/components/ui/ask";
import { AISettingsHost } from "@/components/ai-settings";
import { SidebarFoldIcon } from "@/components/feishu-icons";
import type { SearchGuardCapture } from "@/components/search-focus";
import { isDocumentSidebarShortcut } from "@/lib/sidebar-shortcut";
import { browserSidebarStorage, decodeSidebarPreference, readSidebarPreference, sidebarPreferenceKey, writeSidebarPreference } from "@/lib/sidebar-preference";

export default function App() {
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
  if (route.page === "public") return <PublicDoc key={route.token} token={route.token} />;
  if (route.page === "form") {
    return <PublicForm key={route.token} token={route.token} />;
  }
  if (route.page === "legacy-form") return <div className="grid min-h-full place-items-center p-6 text-center text-muted-foreground"><p>此收集表链接已失效，请联系创建者获取新的分享链接。</p></div>;
  if (checkingAuth) return <div className="grid h-full place-items-center text-subtle">正在确认账号…</div>;
  if (authCheckError) return <div className="grid h-full place-items-center text-destructive"><div>无法确认当前账号。<button type="button" onClick={() => void verifyExternalAuth()} className="ml-2 underline">重试</button></div></div>;
  if (me.isPending) return <div className="grid h-full place-items-center text-subtle">加载中…</div>;
  if (unauth) return <LoginPage />;
  if (!me.data) return <div className="grid h-full place-items-center text-destructive">无法连接服务器：{String(me.error)}</div>;

  return <AuthenticatedApp key={`${me.data.user.id}:${sessionGeneration}`} me={me.data} route={route} authClient={qc} onLogout={() => logout.mutate()} />;
}

/** A new mount also creates a fresh cache after re-authenticating the same user. */
function AuthenticatedApp({ me, route, authClient, onLogout }: {
  me: Me;
  route: ReturnType<typeof useRoute>;
  authClient: ReturnType<typeof useQueryClient>;
  onLogout: () => void;
}) {
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
  useEffect(() => setSidebarOpen(false), [route.page, "id" in route ? route.id : null]);
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
  const closeSidebar = () => {
    setSidebarOpen(false);
    requestAnimationFrame(() => openSidebarButton.current?.focus());
  };
  const collapseDocumentSidebar = () => {
    setDocumentSidebar(false);
    requestAnimationFrame(() => openSidebarButton.current?.focus());
  };
  const sidebarClass = docLayout
    ? `${sidebarOpen ? "block" : "hidden"} fixed inset-y-0 left-0 z-50 ${docSidebarDocked ? "md:static md:z-auto md:block" : "md:hidden"}`
    : `${sidebarOpen ? "block" : "hidden"} fixed inset-y-0 left-0 z-50 ${route.page === "base" || route.page === "slides" || route.page === "sheet" ? "md:hidden" : "md:static md:block"}`;
  return (
    <QueryClientProvider client={sessionClient}>
    <div className="flex h-full">
      <AskHost />
      <AISettingsHost />
      <button ref={openSidebarButton} className={`fixed left-3 top-3 z-30 grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-hover ${docLayout && !docSidebarDocked ? "md:top-3.5" : "md:hidden"}`} onClick={openSidebar} aria-label="打开导航" aria-expanded={sidebarOpen} aria-controls="workspace-navigation" aria-keyshortcuts={docLayout ? "Meta+] Control+]" : undefined}>{docLayout ? <SidebarFoldIcon collapsed className="size-4" /> : <Menu size={20} />}</button>
      {sidebarOpen && <button className="fixed inset-0 z-40 bg-black/30 md:hidden" aria-label="关闭导航" onClick={closeSidebar} />}
      <div id="workspace-navigation" ref={sidebarContainer} className={sidebarClass}>
        <Sidebar me={me} route={route} onLogout={() => { uploads.cancel(); onLogout(); }} onCollapse={docLayout && docSidebarDocked ? collapseDocumentSidebar : undefined} onSearchRegistrar={registerGlobalSearch} captureSearchGuard={captureGlobalSearchGuard} />
        <button className="absolute right-3 top-4 grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover md:hidden" onClick={closeSidebar} aria-label="关闭导航" data-close-navigation><X size={16} /></button>
      </div>
      {route.page === "doc" ? (
        <DocPage key={route.id} id={route.id} linkedVersion={route.versionId} me={me} sidebarDocked={docSidebarDocked} onGlobalSearch={openGlobalSearch} onSearchGuardRegistrar={registerGlobalSearchGuard} />
      ) : route.page === "unsupported" ? (
        <ResourceTypeNotice id={route.id} />
      ) : route.page === "base" ? (
        <BasePage key={`${route.id}:${me.user.id}`} id={route.id} userId={me.user.id} />
      ) : route.page === "join" ? (
        <JoinLink token={route.token} userId={me.user.id} />
      ) : route.page === "drive" ? (
        <DrivePage key={`${route.folderId ?? 0}:${route.personal}`} folderId={route.folderId} personalRoot={route.personal} userId={me.user.id} uploads={uploads} />
      ) : route.page === "file" ? (
        <DriveFilePage key={route.id} id={route.id} userId={me.user.id} />
      ) : route.page === "slides" ? (
        <SlidesDeck key={`${me.user.id}:${route.id}`} deckId={route.id} userId={me.user.id} />
      ) : route.page === "sheet" ? (
        <SheetPage key={`${me.user.id}:${route.id}`} sheetId={route.id} me={me} onGlobalSearch={openGlobalSearch} />
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
      <DriveUploadStatus manager={uploads} />
    </div>
    </QueryClientProvider>
  );
}
