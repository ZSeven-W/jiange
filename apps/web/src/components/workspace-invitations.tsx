import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlus } from "lucide-react";
import { ApiError, invitationsApi, type WorkspaceInvitation } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/** Pending workspace invitations for the signed-in account. Joining a
 * workspace always requires this explicit acceptance. */
export function WorkspaceInvitations({ userId, onJoined }: { userId: number; onJoined?: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const key = ["workspace-invitations", userId];
  const invites = useQuery({ queryKey: key, queryFn: () => invitationsApi.mine(userId), refetchInterval: 60000, refetchIntervalInBackground: false, retry: false });
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const list = invites.data ?? [];
  if (!list.length && !error) return null;

  const respond = async (inv: WorkspaceInvitation, accept: boolean) => {
    if (busy !== null) return;
    setBusy(inv.id);
    setError("");
    try {
      await invitationsApi.respond(inv.id, userId, accept);
      if (accept) {
        onJoined?.();
        for (const k of ["docs", "shared", "recent", "drive", "drive-nav", "workspace-org"]) void qc.invalidateQueries({ queryKey: [k] });
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t("邀请已失效") : t("操作失败，请稍后重试"));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <div className="mx-3 mb-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5" data-workspace-invitations>
      <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-primary"><MailPlus size={14} />{t("空间邀请")}</p>
      {list.map((inv) => (
        <div key={inv.id} className="mb-1.5 last:mb-0" data-workspace-invitation>
          <p className="truncate text-[13px] text-foreground" title={inv.workspaceName}>{inv.workspaceName}</p>
          <p className="truncate text-[11px] text-subtle">{t("{name} 邀请你以{role}身份加入", { name: inv.inviterName || t("管理员"), role: inv.role === "admin" ? t("管理员") : t("普通成员") })}</p>
          <div className="mt-1 flex gap-1.5">
            <button type="button" disabled={busy !== null} onClick={() => void respond(inv, true)} className="h-7 rounded-md bg-primary px-2.5 text-[12px] text-white disabled:opacity-50" data-accept-invitation>{t("接受")}</button>
            <button type="button" disabled={busy !== null} onClick={() => void respond(inv, false)} className="h-7 rounded-md border bg-surface px-2.5 text-[12px] text-muted-foreground disabled:opacity-50" data-decline-invitation>{t("拒绝")}</button>
          </div>
        </div>
      ))}
      {error && <p role="alert" className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
