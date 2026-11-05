import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 飞书风格的全局确认/输入对话框（替代原生 confirm/prompt）。
 * 用法：`if (await ask("删除？")) …` / `const v = await askText("重命名", undefined, old)`
 */
type ConfirmReq = { title: string; description?: string; danger?: boolean; resolve: (ok: boolean) => void };
type PromptReq = { title: string; placeholder?: string; initial?: string; resolve: (v: string | null) => void };
type AreaReq = PromptReq;

let confirmReq: ConfirmReq | null = null;
let promptReq: PromptReq | null = null;
let areaReq: AreaReq | null = null;
const subs = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const fn of subs) fn();
}

export function ask(title: string, description?: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    confirmReq = { title, description, danger, resolve };
    emit();
  });
}

export function askText(title: string, placeholder?: string, initial?: string): Promise<string | null> {
  return new Promise((resolve) => {
    promptReq = { title, placeholder, initial, resolve };
    emit();
  });
}

/** 多行文本对话框（流程图/长源码）。 */
export function askArea(title: string, placeholder?: string, initial?: string): Promise<string | null> {
  return new Promise((resolve) => {
    areaReq = { title, placeholder, initial, resolve };
    emit();
  });
}

/** 挂在 App 根部 once。 */
export function closeArea(v: string | null) {
  areaReq?.resolve(v);
  areaReq = null;
  emit();
}

export function AskHost() {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((x) => x + 1);
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, []);
  const c = confirmReq;
  const p = promptReq;
  const a = areaReq;
  const closeConfirm = (ok: boolean) => {
    confirmReq = null;
    c?.resolve(ok);
    emit();
  };
  const closePrompt = (v: string | null) => {
    promptReq = null;
    p?.resolve(v);
    emit();
  };
  if (!c && !p && !a) return null;
  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/30"
      onMouseDown={() => (c ? closeConfirm(false) : p ? closePrompt(null) : closeArea(null))}
      data-ask
    >
      <div className="w-[360px] rounded-xl bg-surface p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        {c && (
          <>
            <h3 className="text-[16px] font-semibold text-foreground">{c.title}</h3>
            {c.description && <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{c.description}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button className="h-8 rounded-md border px-3 text-[13px] text-foreground hover:bg-hover" onClick={() => closeConfirm(false)}>
                取消
              </button>
              <button
                className={cn("h-8 rounded-md px-3 text-[13px] font-medium text-white hover:opacity-90", c.danger ? "bg-destructive" : "bg-primary")}
                onClick={() => closeConfirm(true)}
                data-ask-ok
              >
                确定
              </button>
            </div>
          </>
        )}
        {p && <PromptBody req={p} onDone={closePrompt} />}
        {a && <AreaBody req={a} onDone={closeArea} />}
      </div>
    </div>
  );
}

function PromptBody({ req, onDone }: { req: PromptReq; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(req.initial ?? "");
  return (
    <>
      <h3 className="text-[16px] font-semibold text-foreground">{req.title}</h3>
      <input
        autoFocus
        value={v}
        placeholder={req.placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && v.trim()) onDone(v.trim());
          if (e.key === "Escape") onDone(null);
        }}
        className="mt-3 h-9 w-full rounded-md border px-2.5 text-[14px] outline-none focus:border-primary"
        data-ask-input
      />
      <div className="mt-5 flex justify-end gap-2">
        <button className="h-8 rounded-md border px-3 text-[13px] text-foreground hover:bg-hover" onClick={() => onDone(null)}>
          取消
        </button>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={!v.trim()}
          onClick={() => v.trim() && onDone(v.trim())}
        >
          确定
        </button>
      </div>
    </>
  );
}

export const _askVersion = () => version;


function AreaBody({ req, onDone }: { req: AreaReq; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(req.initial ?? "");
  return (
    <>
      <h3 className="text-[16px] font-semibold text-foreground">{req.title}</h3>
      <textarea
        autoFocus
        rows={8}
        value={v}
        placeholder={req.placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone(null);
          e.stopPropagation(); // Enter 换行，不触发全局快捷键
        }}
        className="mt-3 w-full resize-y rounded-md border px-2.5 py-2 font-mono text-[12px] leading-5 outline-none focus:border-primary"
        data-ask-area
      />
      <div className="mt-3 flex justify-end gap-2">
        <button className="h-8 rounded-md border px-3 text-[13px] text-foreground hover:bg-hover" onClick={() => onDone(null)}>
          取消
        </button>
        <button
          className="h-8 rounded-md bg-primary px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={!v.trim()}
          onClick={() => onDone(v)}
          data-ask-area-ok
        >
          确定
        </button>
      </div>
    </>
  );
}
