import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, docsApi, type DocMeta, type Role, type ShareInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { colorFor } from "@/lib/presence";
import { Avatar } from "@/components/brand";

export const ROLE_LABEL: Record<string, string> = {
  view: "可阅读",
  edit: "可编辑",
  manage: "可管理",
  none: "关闭",
};

/** Side panel: invite by email with one of three roles, and link sharing. */
export function ShareDialog({ meta, onClose }: { meta: DocMeta; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ["shares", meta.id];
  const info = useQuery({
    queryKey: key,
    queryFn: () => docsApi.shares(meta.id),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("edit");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const manage = info.data?.role === "manage";
  const set = (d: ShareInfo) => qc.setQueryData(key, d);
  const invite = useMutation({
    mutationFn: (v: { email: string; role: Role | "" }) => docsApi.share(meta.id, v.email, v.role),
    onSuccess: (d) => {
      set(d);
      setEmail("");
      setErr("");
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : "邀请失败"),
  });
  const link = useMutation({
    mutationFn: (r: "none" | "view" | "edit") => docsApi.setLink(meta.id, r),
    onSuccess: (l) => info.data && set({ ...info.data, link: l }),
  });
  const url = info.data?.link.token ? `${location.origin}/#/s/${info.data.link.token}` : "";
  return (
    <aside className="flex w-[420px] shrink-0 flex-col gap-4 border-l bg-white p-6" data-share-dialog>
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold">分享「{meta.title.trim() || "未命名文档"}」</h2>
        <button onClick={onClose} className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-hover" aria-label="关闭">
          ✕
        </button>
      </div>
      {manage && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) invite.mutate({ email, role });
          }}
        >
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="输入邮箱邀请协作者"
            className="h-[34px] min-w-0 flex-1 rounded-md border px-2.5 text-[13px] outline-none focus:border-primary"
          />
          <RoleSelect value={role} onChange={(r) => setRole(r as Role)} options={["view", "edit", "manage"]} />
          <Button size="sm" className="h-[34px]" type="submit">
            邀请
          </Button>
        </form>
      )}
      {err && <p className="-mt-2 text-[12px] text-destructive">{err}</p>}
      <p className="text-[12px] font-medium text-subtle">协作者</p>
      <div className="space-y-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={meta.creatorName} color={colorFor(meta.creatorId - 1)} size={32} />
          <span className="flex-1 text-[14px] font-medium">{meta.creatorName}</span>
          <span className="text-[13px] text-muted-foreground">所有者</span>
        </div>
        {info.data?.members.map((m) => (
          <div key={m.userId} className="flex items-center gap-2.5">
            <Avatar name={m.name} color={colorFor(m.userId - 1)} size={32} />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium">{m.name}</span>
              <span className="block text-[12px] text-subtle">{m.email}</span>
            </span>
            {manage ? (
              <RoleSelect
                value={m.role}
                onChange={(r) =>
                  invite.mutate({
                    email: m.email,
                    role: r === "remove" ? "" : (r as Role),
                  })
                }
                options={["view", "edit", "manage", "remove"]}
              />
            ) : (
              <span className="text-[13px] text-muted-foreground">{ROLE_LABEL[m.role]}</span>
            )}
          </div>
        ))}
      </div>
      <hr />
      <p className="text-[12px] font-medium text-subtle">链接分享</p>
      <div className="flex items-center justify-between text-[14px]">
        <span>获得链接的登录用户</span>
        {manage ? (
          <RoleSelect value={info.data?.link.role ?? "none"} onChange={(r) => link.mutate(r as "none" | "view" | "edit")} options={["none", "view", "edit"]} />
        ) : (
          <span className="text-[13px] text-muted-foreground">{ROLE_LABEL[info.data?.link.role ?? "none"]}</span>
        )}
      </div>
      {url && info.data?.link.role !== "none" && (
        <div className="flex gap-2">
          <span className="flex h-[34px] min-w-0 flex-1 items-center truncate rounded-md bg-sidebar px-2.5 text-[13px] text-muted-foreground" data-share-url>
            {url}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-[34px]"
            onClick={async () => {
              await navigator.clipboard?.writeText(url).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "已复制" : "复制链接"}
          </Button>
        </div>
      )}
    </aside>
  );
}

function RoleSelect({ value, onChange, options }: { value: string; onChange: (r: string) => void; options: string[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-[34px] rounded-md border bg-white px-2 text-[13px] outline-none focus:border-primary">
      {options.map((o) => (
        <option key={o} value={o}>
          {o === "remove" ? "移除" : ROLE_LABEL[o]}
        </option>
      ))}
    </select>
  );
}
