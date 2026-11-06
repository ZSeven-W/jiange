import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Me } from "@/lib/api";
import { announceAuthChange, createSessionQueryClient, subscribeAuthChanges } from "@/lib/sessionCache";
import { useRoute } from "@/lib/route";
import { LoginPage } from "@/pages/Login";
import { Home } from "@/pages/Home";
import { DocPage } from "@/pages/DocPage";
import { Playground } from "@/pages/Playground";
import { Sidebar } from "@/components/Sidebar";
import { Trash } from "@/pages/Trash";
import { JoinLink } from "@/pages/JoinLink";
import { BasePage } from "@/pages/BasePage";
import { PublicForm } from "@/pages/PublicForm";
import { PublicDoc } from "@/pages/PublicDoc";
import { AskHost } from "@/components/ui/ask";

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
    return <PublicForm key={`${route.base}:${route.vid}`} baseId={route.base} viewId={route.vid} />;
  }
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => setSidebarOpen(false), [route.page, "id" in route ? route.id : null]);
  return (
    <QueryClientProvider client={sessionClient}>
    <div className="flex h-full">
      <AskHost />
      <button className="fixed left-3 top-3 z-30 grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-hover md:hidden" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
      {sidebarOpen && <button className="fixed inset-0 z-40 bg-black/30 md:hidden" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
      <div className={`${sidebarOpen ? "block" : "hidden"} fixed inset-y-0 left-0 z-50 md:static md:block`}>
        <Sidebar me={me} route={route} onLogout={onLogout} />
        <button className="absolute right-3 top-4 grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover md:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"><X size={16} /></button>
      </div>
      {route.page === "doc" ? (
        <DocPage key={route.id} id={route.id} me={me} />
      ) : route.page === "base" ? (
        <BasePage key={route.id} id={route.id} />
      ) : route.page === "join" ? (
        <JoinLink token={route.token} />
      ) : route.page === "trash" ? (
        <Trash />
      ) : route.page === "favorites" ? (
        <Home me={me} favorites />
      ) : route.page === "playground" ? (
        <div className="flex-1 overflow-auto p-6">
          <Playground />
        </div>
      ) : (
        <Home me={me} recent={route.page === "recent"} />
      )}
    </div>
    </QueryClientProvider>
  );
}
