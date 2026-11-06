import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/brand";
import { Check, FileText, Sparkles, Table2 } from "lucide-react";
import { finishLogin } from "@/lib/sessionCache";

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const qc = useQueryClient();
  const m = useMutation({ mutationFn: () => mode === "login" ? api.login(email, password) : api.register(email, name, password), onSuccess: (me) => finishLogin(qc, me) });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  const login = mode === "login";
  return (
    <div className="flex min-h-full bg-surface">
      <aside className="relative hidden min-h-[620px] w-[48%] flex-col overflow-hidden bg-[#f2f5fc] px-12 py-10 lg:flex dark:bg-[#1b2230]">
        <Logo />
        <div className="relative z-10 my-auto max-w-[470px] pb-12">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[12px] font-medium text-primary shadow-sm dark:bg-white/10"><Sparkles size={13} /> 一起把想法变成成果</span>
          <h1 className="mt-6 text-[38px] font-semibold leading-[1.3] tracking-tight">好想法，<br />从协作开始。</h1>
          <p className="mt-4 text-[15px] leading-7 text-muted-foreground">用文档记录灵感，用多维表格整理工作。<br />让每一次协作都清晰、高效。</p>
          <div aria-hidden className="relative mt-12 h-[220px] max-w-[410px]">
            <div className="absolute inset-x-0 top-0 h-[195px] rotate-[-3deg] rounded-2xl border border-white bg-white/80 p-6 shadow-[0_18px_60px_rgba(50,76,130,0.12)] dark:border-white/10 dark:bg-[#252c39]">
              <div className="flex items-center gap-2 text-[12px] font-medium text-primary"><FileText size={16} /> 项目协作空间</div>
              <div className="mt-5 h-3 w-2/3 rounded-full bg-[#dce6fa] dark:bg-white/15" /><div className="mt-3 h-2 w-full rounded-full bg-[#edf1f8] dark:bg-white/10" /><div className="mt-2 h-2 w-5/6 rounded-full bg-[#edf1f8] dark:bg-white/10" />
              <div className="mt-5 flex items-center gap-2 text-[12px] text-muted-foreground"><span className="grid size-5 place-items-center rounded-full bg-[#d9f4e6] text-[#31a56b]"><Check size={12} /></span> 想法和进展，都在一处</div>
            </div>
            <div className="absolute -right-4 bottom-0 flex items-center gap-3 rounded-xl border border-white bg-white px-4 py-3 shadow-[0_10px_35px_rgba(50,76,130,0.14)] dark:border-white/10 dark:bg-[#30394a]"><span className="grid size-9 place-items-center rounded-lg bg-[#f0ebff] text-[#7657d8]"><Table2 size={18} /></span><span className="text-[12px] font-medium">把工作整理得井井有条</span></div>
          </div>
        </div>
        <p className="text-[12px] text-subtle">Jiange · 开源、可自部署的协作空间</p>
        <div aria-hidden className="pointer-events-none absolute -right-32 -top-32 size-96 rounded-full bg-[#dfe9ff]/60 blur-3xl" />
      </aside>
      <main className="flex flex-1 items-center justify-center px-7 py-12">
        <form onSubmit={submit} className="w-full max-w-[360px]">
          <div className="mb-10 lg:hidden"><Logo /></div>
          <h2 className="text-[26px] font-semibold tracking-tight">{login ? "欢迎回来" : "创建你的账号"}</h2>
          <p className="mt-2 text-[14px] text-muted-foreground">{login ? "登录 Jiange，继续你的工作" : "加入 Jiange，开始记录和协作"}</p>
          <div className="mt-8 space-y-5">
            <Field id="email" label="邮箱"><Input id="email" type="email" autoComplete="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-11" /></Field>
            {!login && <Field id="name" label="名字"><Input id="name" autoComplete="name" placeholder="你的名字" value={name} onChange={(e) => setName(e.target.value)} className="h-11" /></Field>}
            <Field id="password" label="密码"><Input id="password" type="password" autoComplete={login ? "current-password" : "new-password"} placeholder={login ? "输入密码" : "至少 8 位"} value={password} onChange={(e) => setPassword(e.target.value)} className="h-11" /></Field>
          </div>
          {m.error && <p role="alert" className="mt-3 text-[13px] text-destructive">{(m.error as Error).message}</p>}
          <Button type="submit" className="mt-7 h-11 w-full" disabled={m.isPending}>{m.isPending ? "请稍候…" : login ? "登录" : "注册并进入"}</Button>
          <p className="mt-7 text-center text-[13px] text-muted-foreground">{login ? "还没有账号？" : "已有账号？"}<button type="button" className="ml-1 font-medium text-primary hover:underline" onClick={() => { setMode(login ? "register" : "login"); m.reset(); }}>{login ? "免费注册" : "去登录"}</button></p>
        </form>
      </main>
    </div>
  );
}
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label htmlFor={id} className="text-[13px] font-medium">{label}</Label>{children}</div>;
}
