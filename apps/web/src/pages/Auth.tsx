import { useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AuthPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => (mode === "login" ? api.login(email, password) : api.register(email, name, password)),
    onSuccess: (me) => qc.setQueryData(["me"], me),
  });
  const submit = () => m.mutate();
  const onKey = (e: KeyboardEvent) => e.key === "Enter" && submit();

  return (
    <Card className="mx-auto mt-10 max-w-sm">
      <CardHeader>
        <CardTitle>{mode === "login" ? "登录" : "注册"}</CardTitle>
        <CardDescription>Jiange：开源的 AI 原生协作文档</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4" onKeyDown={onKey}>
        <div className="space-y-2">
          <Label htmlFor="email">邮箱</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {mode === "register" && (
          <div className="space-y-2">
            <Label htmlFor="name">名字</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="password">密码</Label>
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {m.error && <p className="text-sm text-destructive">{m.error.message}</p>}
        <Button className="w-full" onClick={submit} disabled={m.isPending}>
          {mode === "login" ? "登录" : "创建账号"}
        </Button>
        <Button variant="link" className="w-full" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
        </Button>
      </CardContent>
    </Card>
  );
}
