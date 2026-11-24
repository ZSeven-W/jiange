import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { ApiError, driveApi, type DocMeta, type DriveEntry } from "@/lib/api";
import { t, useI18n } from "@/lib/i18n";

type Snapshot = { title: string; revision: number };
export type SlideTitleDraft = { value: string; base: Snapshot; phase: "editing" | "saving" | "unknown"; error: string };

export function slideTitleCheck(value: string, base: Snapshot, current: DocMeta, verified: boolean): { ok: true; title: string } | { ok: false; message: string } {
  const title = value.trim();
  if (!title || [...title].length > 100) return { ok: false, message: t("名称需要 1–100 个字。") };
  if (!verified || current.kind !== "slides" || (current.role !== "manage" && current.role !== "edit")) return { ok: false, message: t("权限正在检查或已变化，请确认后重试。") };
  if (current.driveRevision !== base.revision || current.title !== base.title) return { ok: false, message: t("名称或文档状态已变化，请复制输入内容并重新打开。") };
  return { ok: true, title };
}

export function SlideDeckTitle({ meta, userId, verified, draft, setDraft, busy, onSaved }: {
  meta: DocMeta; userId: number; verified: boolean; draft: SlideTitleDraft | null;
  setDraft: Dispatch<SetStateAction<SlideTitleDraft | null>>; busy: MutableRefObject<boolean>;
  onSaved: (base: Snapshot, entry: DriveEntry) => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => { if (draft) input.current?.focus(); }, [!!draft]);
  const begin = () => {
    if (!verified || (meta.role !== "manage" && meta.role !== "edit") || !Number.isSafeInteger(meta.driveRevision) || meta.driveRevision! < 0) return;
    cancelled.current = false;
    setDraft({ value: meta.title, base: { title: meta.title, revision: meta.driveRevision! }, phase: "editing", error: "" });
  };
  const save = async () => {
    if (cancelled.current || busy.current || !draft || draft.phase !== "editing") return;
    const result = slideTitleCheck(draft.value, draft.base, meta, verified);
    if (!result.ok) { setDraft((current) => current && { ...current, error: result.message }); return; }
    if (result.title === draft.base.title) { setDraft(null); return; }
    const snapshot = draft.base;
    busy.current = true;
    setDraft((current) => current && { ...current, phase: "saving", error: "" });
    try {
      const entry = await driveApi.renameSlidesForAccount(meta.id, result.title, snapshot.title, snapshot.revision, userId);
      if (!entry || entry.id !== meta.id || entry.kind !== "slides" || entry.title !== result.title || entry.revision !== snapshot.revision + 1) throw new Error("unexpected rename response");
      onSaved(snapshot, entry);
      setDraft(null);
    } catch (cause) {
      const known = cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429;
      const error = known ? cause.status === 409 ? t("名称或文档状态已变化，请复制输入内容并重新打开。") : cause.status === 404 || cause.status === 405 ? t("服务端不支持安全重命名，请升级服务。") : cause.message : t("保存结果未确认，请复制输入内容并重新打开后核对。");
      setDraft((current) => current && { ...current, phase: known ? "editing" : "unknown", error });
    } finally { busy.current = false; }
  };
  if (!draft) return <button type="button" disabled={!verified || (meta.role !== "manage" && meta.role !== "edit") || !Number.isSafeInteger(meta.driveRevision)} onClick={begin} title={meta.role === "manage" || meta.role === "edit" ? t("重命名幻灯片") : t("需要编辑权限才能重命名")} className="block max-w-full truncate rounded px-1 text-left text-[14px] font-semibold text-[#1f2329] hover:bg-[#f2f3f5] disabled:cursor-default">{meta.title || t("未命名幻灯片")}</button>;
  return <div className="relative min-w-0"><input ref={input} aria-label={t("幻灯片名称")} value={draft.value} readOnly={draft.phase !== "editing"} onChange={(event) => { const value = event.target.value; setDraft((current) => current && { ...current, value, error: "" }); }} onBlur={() => void save()} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); void save(); } else if (event.key === "Escape" && draft.phase !== "saving") { event.preventDefault(); cancelled.current = true; setDraft(null); } }} className="h-8 w-48 max-w-[40vw] rounded border border-[#3370ff] bg-white px-2 text-[14px] text-[#1f2329] outline-none"/>{draft.error && <div role="alert" className="absolute left-0 top-9 z-50 w-64 max-w-[80vw] rounded-md border border-[#dee0e3] bg-white p-2 text-[12px] text-[#d83931] shadow-lg">{draft.error}</div>}</div>;
}
