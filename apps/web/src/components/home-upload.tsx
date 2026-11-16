import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import { UploadGlyph } from "./drive-action-icons";
import { DirectoryPickerGate, type DriveUploadManager } from "@/pages/drive-upload";
import type { DriveDirectoryHandle } from "@/pages/drive-upload-plan";
import { DOCX_MIME } from "@/lib/docx";
import { t } from "@/lib/i18n";

/** Home uploads target the current user's personal drive root. */
export function HomeUpload({ uploads, importing, onImport }: { uploads: DriveUploadManager; importing: boolean; onImport: (file: File) => void }) {
  const state = useSyncExternalStore(uploads.subscribe, uploads.snapshot, uploads.snapshot);
  const [open, setOpen] = useState(false);
  const [fallback, setFallback] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const gate = useRef(new DirectoryPickerGate());
  const pickerPending = useRef(false);
  const busy = importing || state.phase === "uploading" || state.phase === "scanning";
  const fallbackSupported = typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");
  const nativePicker = typeof window !== "undefined" && window.isSecureContext ? (window as Window & { showDirectoryPicker?: (options: { mode: "read" }) => Promise<DriveDirectoryHandle> }).showDirectoryPicker : undefined;

  useEffect(() => () => { gate.current.invalidate(); pickerPending.current = false; }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  const selectDirectory = () => {
    if (!nativePicker) return;
    pickerPending.current = true;
    gate.current.choose(() => nativePicker.call(window, { mode: "read" }), (handle) => { pickerPending.current = false; void uploads.startDirectory(handle, null, true); }, (error) => {
      pickerPending.current = false;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setFallback(fallbackSupported);
      uploads.selectionError(fallbackSupported ? "无法打开目录选择器，请重新选择“上传文件夹”；兼容模式不会上传空文件夹。" : "无法打开目录选择器，请检查浏览器权限后重试。");
    });
    setOpen(false);
  };
  const chooseInput = (event: React.KeyboardEvent<HTMLLabelElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.querySelector("input")?.click(); }
  };
  const item = "flex h-10 w-full cursor-pointer items-center gap-3 px-4 text-left text-[14px] text-foreground hover:bg-hover focus:bg-hover focus:outline-none";
  return <div ref={container} className="relative">
    <button ref={trigger} type="button" aria-expanded={open} aria-haspopup="menu" disabled={busy} onClick={() => {
      if (pickerPending.current && fallbackSupported) { setFallback(true); uploads.selectionError("目录选择器未返回，请重新选择“上传文件夹”；兼容模式不会上传空文件夹。"); }
      pickerPending.current = false; gate.current.invalidate(); setOpen((value) => !value);
    }} className={`flex h-16 w-full items-center gap-3 rounded-lg border bg-surface px-4 text-left transition-colors hover:bg-hover/50 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 ${open ? "bg-hover/50" : ""}`}>
      <span className="grid size-8 shrink-0 place-items-center"><UploadGlyph /></span><span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{busy ? t("上传中") : t("上传")}</span><span className="mt-0.5 hidden truncate text-[11px] text-subtle sm:block">{t("上传本地文件")}</span></span><ChevronDown size={15} className={`shrink-0 text-subtle ${open ? "rotate-180" : ""}`} />
    </button>
    {open && <div role="menu" aria-label={t("上传")} className="absolute left-0 top-[calc(100%+4px)] z-30 w-full min-w-44 rounded-md border bg-surface py-1 text-[14px] shadow-[0_6px_22px_rgba(31,35,41,0.16)]">
      <label role="menuitem" tabIndex={0} onKeyDown={chooseInput} className={item}><UploadItemIcon kind="file" />{t("上传文件")}<input type="file" aria-label={t("上传云盘文件")} tabIndex={-1} multiple className="sr-only" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; setOpen(false); if (files.length) void uploads.start(files, "files", null, true); }} /></label>
      {nativePicker && !fallback ? <button type="button" role="menuitem" onClick={selectDirectory} className={item}><UploadItemIcon kind="folder" />{t("上传文件夹")}</button> : fallbackSupported ? <label role="menuitem" tabIndex={0} title={t("浏览器选择器不包含空文件夹")} onKeyDown={chooseInput} className={item}><UploadItemIcon kind="folder" />{t("上传文件夹")}<input ref={(input) => input?.setAttribute("webkitdirectory", "")} type="file" aria-label={t("选择上传文件夹")} tabIndex={-1} multiple className="sr-only" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; setOpen(false); setFallback(false); if (files.length) void uploads.start(files, "folder", null, true); }} /></label> : <button type="button" role="menuitem" disabled title={t("当前浏览器不支持选择文件夹")} className={`${item} cursor-not-allowed opacity-50`}><UploadItemIcon kind="folder" />{t("上传文件夹")}</button>}
      <label role="menuitem" tabIndex={0} onKeyDown={chooseInput} className={item}><UploadItemIcon kind="import" />{t("导入为在线文档")}<input type="file" aria-label={t("导入 Markdown 或 Word 文件")} tabIndex={-1} accept={`.md,.markdown,text/markdown,.docx,${DOCX_MIME}`} className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; setOpen(false); if (file) onImport(file); }} /></label>
    </div>}
  </div>;
}

function UploadItemIcon({ kind }: { kind: "file" | "folder" | "import" }) {
  if (kind === "folder") return <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" aria-hidden="true"><path d="M1 6h22v13a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V6Z" fill="#FFC60A"/><path d="M1 4a2 2 0 0 1 2-2h5.275a4 4 0 0 1 1.404.255l2.642.99a4 4 0 0 0 1.404.255H21a2 2 0 0 1 2 2V6H1V4Z" fill="#FF9D4C"/><path d="m11.239 10.239-1.7 1.806a.68.68 0 0 1-.962-.961l2.885-2.885a.68.68 0 0 1 .96 0l2.889 2.889a.675.675 0 0 1-.962.96l-1.75-1.809v4.418c0 .376-.305.53-.68.53-.376 0-.68-.154-.68-.53V10.24ZM17.036 15.816a.68.68 0 0 0-1.36 0v.68H8.16v-.68a.68.68 0 0 0-1.36 0v1.36c0 .376.305.68.68.68h8.877a.68.68 0 0 0 .68-.68v-1.36Z" fill="#fff"/></svg>;
  return <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" aria-hidden="true"><path d="M3 3a2 2 0 0 1 2-2h9.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V21a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3Z" fill={kind === "file" ? "#FF9D4C" : "#5B65F5"}/><path d="M15 1.483a.2.2 0 0 1 .341-.142L20.66 6.66a.2.2 0 0 1-.142.341H17a2 2 0 0 1-2-2V1.483Z" fill={kind === "file" ? "#FF811A" : "#333DCC"}/>{kind === "file" ? <path d="m11.239 10.178-1.7 1.806a.68.68 0 0 1-.962-.962l2.885-2.885a.68.68 0 0 1 .96 0l2.889 2.889a.675.675 0 0 1-.962.961l-1.75-1.81v4.419c0 .375-.305.528-.68.528-.376 0-.68-.153-.68-.528v-4.418ZM17.036 15.755a.68.68 0 0 0-1.36 0v.68H8.16v-.68a.68.68 0 0 0-1.36 0v1.36c0 .375.305.68.68.68h8.877a.68.68 0 0 0 .68-.68v-1.36Z" fill="#fff"/> : <path d="M7 9.635c0-1.155.937-2.092 2.092-2.092H14a.697.697 0 0 1 0 1.395H9.092a.697.697 0 0 0-.697.697v6.606c0 .385.312.697.697.697H14a.697.697 0 0 1 0 1.395H9.092A2.092 2.092 0 0 1 7 16.24V9.635Zm5.19 2.641.736-.776a.697.697 0 0 0-.986-.986L9.862 12.48a.697.697 0 0 0 .03 1.014l2.107 1.76a.697.697 0 0 0 .927-1.043l-.737-.54H16.5a.697.697 0 0 0 0-1.395h-4.31Z" fill="#fff"/>}</svg>;
}
