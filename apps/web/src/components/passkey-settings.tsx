import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Clock,
  Fingerprint,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import { MFA_STATUS_QUERY_KEY } from "@/lib/mfa-api";
import {
  PASSKEYS_QUERY_KEY,
  deletePasskey,
  isWebAuthnSupported,
  listPasskeys,
  registerPasskey,
  type PasskeySummary,
} from "@/lib/passkey-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n, type TFunc } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface PasskeySettingsProps {
  className?: string;
  initialConfirmDeleteId?: number | null;
  webAuthnSupported?: boolean;
}

function formatPasskeyDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatPasskeyDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTransportLabel(transport: string, t: TFunc): string {
  switch (transport.toLowerCase()) {
    case "internal":
      return t("本机认证器");
    case "hybrid":
      return t("跨设备蓝牙");
    case "usb":
      return "USB";
    case "nfc":
      return "NFC";
    case "ble":
      return t("蓝牙");
    default:
      return transport;
  }
}

function formatWebAuthnError(err: unknown, fallback: string, t: TFunc): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) {
    if (err.name === "NotAllowedError" || err.name === "AbortError") {
      return t("通行密钥操作已取消或超时，请重试");
    }
    if (err.name === "InvalidStateError") {
      return t("当前设备的通行密钥已绑定到此账号");
    }
    if (err.name === "SecurityError") {
      return t("当前页面域名或协议不满足 WebAuthn 安全要求");
    }
    return err.message || fallback;
  }
  return fallback;
}

export function PasskeySettings({
  className,
  initialConfirmDeleteId = null,
  webAuthnSupported,
}: PasskeySettingsProps = {}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const supported = webAuthnSupported ?? isWebAuthnSupported();

  const passkeysQuery = useQuery<PasskeySummary[]>({
    queryKey: PASSKEYS_QUERY_KEY,
    queryFn: ({ signal }) => listPasskeys(signal),
    retry: false,
  });

  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(initialConfirmDeleteId);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const passkeys = passkeysQuery.data ?? [];

  const handleAddPasskey = async (e: FormEvent) => {
    e.preventDefault();
    if (!supported || adding) return;
    setAdding(true);
    setError("");
    setNotice("");
    try {
      const created = await registerPasskey(newName.trim() || "Passkey");
      setNewName("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: MFA_STATUS_QUERY_KEY }),
      ]);
      setNotice(t("已成功绑定通行密钥「{name}」", { name: created.name }));
    } catch (err) {
      setError(formatWebAuthnError(err, t("绑定通行密钥失败，请重试"), t));
    } finally {
      setAdding(false);
    }
  };

  const handleConfirmDelete = async (pk: PasskeySummary) => {
    if (deletingId !== null) return;
    setDeletingId(pk.id);
    setError("");
    setNotice("");
    try {
      await deletePasskey(pk.id);
      setConfirmDeleteId(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY }),
        qc.invalidateQueries({ queryKey: MFA_STATUS_QUERY_KEY }),
      ]);
      setNotice(t("已移除通行密钥「{name}」", { name: pk.name }));
    } catch (err) {
      setError(formatWebAuthnError(err, t("移除通行密钥失败，请重试"), t));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section
      data-passkey-settings
      className={cn("rounded-xl border border-border bg-surface p-5 shadow-xs", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg",
              passkeys.length > 0
                ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                : "bg-primary/10 text-primary",
            )}
          >
            <Fingerprint size={20} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold text-foreground">
                {t("通行密钥（Passkey）")}
              </h3>
              <span
                data-passkey-count-badge
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                  passkeys.length > 0
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-border bg-hover text-muted-foreground",
                )}
              >
                {passkeys.length > 0
                  ? t("已绑定 {n} 个", { n: passkeys.length })
                  : t("未绑定")}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {t("使用指纹、面容 ID 或硬件安全密钥实现一键免密登录，且符合工作空间二步验证安全策略。")}
            </p>
          </div>
        </div>
      </div>

      {!supported && (
        <div
          role="note"
          data-passkey-unsupported
          className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 text-[12px] text-amber-800 dark:text-amber-200"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>
            {t("当前浏览器或非安全上下文不支持 WebAuthn 通行密钥，请在 HTTPS 或 localhost 环境下使用现代浏览器。")}
          </span>
        </div>
      )}

      {passkeysQuery.isError && (
        <p role="alert" className="mt-3 text-[12px] text-destructive">
          {t("无法获取通行密钥列表，请刷新页面重试。")}
        </p>
      )}
      {error && (
        <p
          role="alert"
          data-passkey-error
          className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          data-passkey-notice
          className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-[12px] text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </p>
      )}

      {/* Add new passkey form */}
      <form
        onSubmit={handleAddPasskey}
        data-passkey-add-form
        className="mt-4 rounded-xl border border-border bg-hover/40 p-3.5"
      >
        <Label htmlFor="passkey-device-name" className="text-[12px] font-medium text-foreground">
          {t("绑定新的通行密钥")}
        </Label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            id="passkey-device-name"
            type="text"
            maxLength={80}
            value={newName}
            disabled={!supported || adding}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("为设备命名，例如：MacBook Touch ID 或 YubiKey")}
            className="h-9 min-w-[220px] flex-1 bg-surface text-[13px]"
            data-passkey-name-input
          />
          <Button
            type="submit"
            size="sm"
            disabled={!supported || adding}
            data-passkey-add-btn
            className="h-9 shrink-0"
          >
            <Plus size={14} />
            {adding ? t("等待设备验证…") : t("添加通行密钥")}
          </Button>
        </div>
      </form>

      {/* Registered passkeys list */}
      <div className="mt-4 space-y-2" data-passkey-list>
        {passkeysQuery.isLoading ? (
          <p className="py-6 text-center text-[13px] text-subtle">
            {t("正在加载通行密钥…")}
          </p>
        ) : passkeys.length === 0 ? (
          <div
            data-passkey-empty
            className="rounded-lg border border-dashed border-border bg-background/40 px-4 py-8 text-center"
          >
            <KeyRound size={20} className="mx-auto mb-2 text-subtle" aria-hidden />
            <p className="text-[13px] font-medium text-foreground">
              {t("暂未绑定通行密钥")}
            </p>
            <p className="mt-1 text-[12px] text-subtle">
              {t("绑定后可在登录页直接通过生物识别或安全密钥快速登录。")}
            </p>
          </div>
        ) : (
          passkeys.map((pk) => {
            const confirming = confirmDeleteId === pk.id;
            const deleting = deletingId === pk.id;
            return (
              <div
                key={pk.id}
                data-passkey-item={pk.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background/50 px-3.5 py-3"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <ShieldCheck size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {pk.name}
                      </span>
                      {(pk.transports ?? []).map((tr) => (
                        <span
                          key={tr}
                          className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {formatTransportLabel(tr, t)}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-subtle">
                      <span>{t("创建于 {date}", { date: formatPasskeyDate(pk.createdAt) })}</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} aria-hidden />
                        {pk.lastUsedAt
                          ? t("最近使用：{time}", { time: formatPasskeyDateTime(pk.lastUsedAt) })
                          : t("尚未使用")}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {confirming ? (
                    <div
                      data-passkey-confirm-box={pk.id}
                      className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1"
                    >
                      <span className="text-[11px] font-medium text-destructive">
                        {t("确认移除？")}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={deleting}
                        onClick={() => void handleConfirmDelete(pk)}
                        data-passkey-confirm-delete={pk.id}
                        className="h-7 border-destructive/40 bg-destructive px-2 text-[11px] text-white hover:bg-destructive/90 hover:text-white"
                      >
                        {deleting ? t("移除中…") : t("确认移除")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={deleting}
                        onClick={() => setConfirmDeleteId(null)}
                        data-passkey-cancel-delete={pk.id}
                        className="h-7 px-2 text-[11px]"
                      >
                        {t("取消")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={deletingId !== null}
                      onClick={() => {
                        setConfirmDeleteId(pk.id);
                        setError("");
                      }}
                      data-passkey-delete-btn={pk.id}
                      className="h-8 text-[12px] text-muted-foreground hover:bg-destructive/8 hover:text-destructive"
                    >
                      <Trash2 size={13} />
                      {t("移除")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
