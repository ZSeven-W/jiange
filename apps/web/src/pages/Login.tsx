import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/brand";

const POINTS = ["实时多人协作，毫秒级同步", "自研协同内核，离线也能写", "数据完全掌握在自己手里"];

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => (mode === "login" ? api.login(email, password) : api.register(email, name, password)),
    onSuccess: (me) => qc.setQueryData(["me"], me),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  const login = mode === "login";

  return (
    <div className="flex h-full min-h-[600px]">
      <aside className="relative hidden w-[44%] max-w-[640px] flex-col justify-between overflow-hidden bg-[#F0F4FF] px-11 py-12 md:flex">
        <Logo />
        <div className="relative">
          <h1 className="text-[34px] font-bold leading-tight tracking-tight">一起写，一起想</h1>
          <p className="mt-4 text-[15px] text-muted-foreground">开源、可自部署的 AI 原生协作文档与多维表格</p>
          <ul className="mt-8 space-y-3.5">
            {POINTS.map((p) => (
              <li key={p} className="flex items-center gap-3 text-[13px] text-muted-foreground">
                <span className="size-1.5 rounded-full bg-primary" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-subtle">MIT License · github.com/ZSeven-W/jiange</p>
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary/5" />
      </aside>
      <main className="flex flex-1 items-center justify-center px-6">
        <form onSubmit={submit} className="w-full max-w-[304px]">
          <div className="mb-8 md:hidden">
            <Logo />
          </div>
          <h2 className="text-[22px] font-semibold">{login ? "登录 Jiange" : "注册 Jiange"}</h2>
          <p className="mt-2.5 text-[13px] text-muted-foreground">{login ? "欢迎回来，使用邮箱继续" : "创建账号，开始协作"}</p>
          <div className="mt-6 space-y-5">
            <Field id="email" label="邮箱">
              <Input id="email" type="email" autoComplete="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            {!login && (
              <Field id="name" label="名字">
                <Input id="name" autoComplete="name" placeholder="你的名字" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            )}
            <Field id="password" label="密码">
              <Input
                id="password"
                type="password"
                autoComplete={login ? "current-password" : "new-password"}
                placeholder={login ? "输入密码" : "至少 8 位"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </div>
          {m.error && <p className="mt-3 text-[13px] text-destructive">{(m.error as Error).message}</p>}
          <Button type="submit" className="mt-6 h-9 w-full" disabled={m.isPending}>
            {m.isPending ? "请稍候…" : login ? "登录" : "注册并进入"}
          </Button>
          <p className="mt-6 text-[13px] text-muted-foreground">
            {login ? "还没有账号？" : "已有账号？"}
            <button type="button" className="ml-1.5 font-medium text-primary hover:underline" onClick={() => { setMode(login ? "register" : "login"); m.reset(); }}>
              {login ? "免费注册" : "去登录"}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </Label>
      {children}
    </div>
  );
}
