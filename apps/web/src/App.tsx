import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
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

export default function App() {
  const route = useRoute();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => qc.clear(),
  });
  const unauth = (me.error instanceof ApiError && me.error.status === 401) || me.data === null;

  // public form pages work without login
  if (route.page === "form") {
    return <PublicForm key={`${route.base}:${route.vid}`} baseId={route.base} viewId={route.vid} />;
  }
  if (me.isPending) return <div className="grid h-full place-items-center text-subtle">加载中…</div>;
  if (unauth) return <LoginPage />;
  if (!me.data) return <div className="grid h-full place-items-center text-destructive">无法连接服务器：{String(me.error)}</div>;

  return (
    <div className="flex h-full">
      <Sidebar me={me.data} route={route} onLogout={() => logout.mutate()} />
      {route.page === "doc" ? (
        <DocPage key={route.id} id={route.id} me={me.data} />
      ) : route.page === "base" ? (
        <BasePage key={route.id} id={route.id} />
      ) : route.page === "join" ? (
        <JoinLink token={route.token} />
      ) : route.page === "trash" ? (
        <Trash />
      ) : route.page === "favorites" ? (
        <Home me={me.data} favorites />
      ) : route.page === "playground" ? (
        <div className="flex-1 overflow-auto p-6">
          <Playground />
        </div>
      ) : (
        <Home me={me.data} recent={route.page === "recent"} />
      )}
    </div>
  );
}
