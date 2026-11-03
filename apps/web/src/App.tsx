import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { AuthPage } from "@/pages/Auth";
import { Playground } from "@/pages/Playground";

type Tab = "home" | "playground";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => qc.setQueryData(["me"], null) });
  const unauth = me.error instanceof ApiError && me.error.status === 401;

  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
        <span className="mr-4 text-lg font-semibold">Jiange</span>
        <Button variant={tab === "home" ? "secondary" : "ghost"} size="sm" onClick={() => setTab("home")}>
          工作台
        </Button>
        <Button variant={tab === "playground" ? "secondary" : "ghost"} size="sm" onClick={() => setTab("playground")}>
          协同内核演示
        </Button>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {me.data && (
            <>
              <span className="text-muted-foreground">{me.data.user.email}</span>
              <Button variant="outline" size="sm" onClick={() => logout.mutate()}>
                退出
              </Button>
            </>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6">
        {tab === "playground" ? (
          <Playground />
        ) : me.isPending ? (
          <p className="text-muted-foreground">加载中…</p>
        ) : me.data ? (
          <section className="space-y-4">
            <h1 className="text-2xl font-semibold">你好，{me.data.user.name}</h1>
            <div>
              <h2 className="mb-2 font-medium">我的工作区</h2>
              <ul className="list-disc pl-6 text-sm">
                {me.data.workspaces.map((w) => (
                  <li key={w.id}>{w.name}</li>
                ))}
              </ul>
            </div>
            <p className="text-sm text-muted-foreground">文档树、编辑器与实时协作将在 P2–P4 实现。</p>
          </section>
        ) : unauth || me.data === null ? (
          <AuthPage />
        ) : (
          <p className="text-destructive">无法连接服务器：{String(me.error)}</p>
        )}
      </main>
    </div>
  );
}
