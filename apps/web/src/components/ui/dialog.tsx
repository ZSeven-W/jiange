import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** 飞书风格确认对话框（替代原生 confirm）。 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel, onConfirm]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30" onMouseDown={onCancel} data-confirm>
      <div
        className="w-[360px] rounded-xl bg-surface p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-[16px] font-semibold text-foreground">{title}</h3>
        {description && <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{description}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="h-8 rounded-md border px-3 text-[13px] text-foreground hover:bg-hover" onClick={onCancel}>
            {t("取消")}
          </button>
          <button
            className={cn("h-8 rounded-md px-3 text-[13px] font-medium text-white", danger ? "bg-destructive hover:opacity-90" : "bg-primary hover:opacity-90")}
            onClick={onConfirm}
            data-confirm-ok
          >
            {confirmText ?? t("确定")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 飞书风格输入对话框（替代原生 prompt）。 */
export function PromptDialog({
  open,
  title,
  placeholder,
  initial = "",
  confirmText,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setV(initial);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open, initial]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30" onMouseDown={onCancel} data-prompt>
      <div className="w-[360px] rounded-xl bg-surface p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="text-[16px] font-semibold text-foreground">{title}</h3>
        <input
          ref={inputRef}
          value={v}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && v.trim()) onConfirm(v.trim());
            if (e.key === "Escape") onCancel();
          }}
          className="mt-3 h-9 w-full rounded-md border px-2.5 text-[14px] outline-none focus:border-primary"
          data-prompt-input
        />
        <div className="mt-5 flex justify-end gap-2">
          <button className="h-8 rounded-md border px-3 text-[13px] text-foreground hover:bg-hover" onClick={onCancel}>
            {t("取消")}
          </button>
          <button
            className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            disabled={!v.trim()}
            onClick={() => v.trim() && onConfirm(v.trim())}
          >
            {confirmText ?? t("确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
