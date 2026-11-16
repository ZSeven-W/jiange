import { Download, Eye } from "lucide-react";
import { cn } from "@/lib/utils";

// 飞书附件卡片：按类型着色的图标、文件名、大小 · 类型，悬停出现「预览 / 下载」。
const KINDS: { test: RegExp; label: string; fg: string; bg: string }[] = [
  { test: /^pdf$/, label: "PDF", fg: "#F54A45", bg: "#FEF1F1" },
  { test: /^(docx?|rtf|odt|pages)$/, label: "DOC", fg: "#3370FF", bg: "#F0F4FF" },
  { test: /^(xlsx?|csv|numbers|ods)$/, label: "XLS", fg: "#2EA121", bg: "#EEF9EC" },
  { test: /^(pptx?|key|odp)$/, label: "PPT", fg: "#FF8800", bg: "#FFF3E8" },
  { test: /^(zip|rar|7z|tar|gz|tgz)$/, label: "ZIP", fg: "#7F3BF5", bg: "#F5F0FF" },
  { test: /^(png|jpe?g|gif|webp|svg|bmp|heic)$/, label: "IMG", fg: "#14C0FF", bg: "#EBF9FF" },
  { test: /^(mp4|mov|avi|mkv|webm)$/, label: "VID", fg: "#F01D94", bg: "#FFEEF8" },
  { test: /^(mp3|wav|aac|flac|m4a)$/, label: "AUD", fg: "#F01D94", bg: "#FFEEF8" },
  { test: /^(md|txt|json|ya?ml|xml|js|ts|go|py|sql|log)$/, label: "TXT", fg: "#646A73", bg: "#F2F3F5" },
];

export function fileKind(name?: string) {
  const ext = (name?.includes(".") ? name.split(".").pop() ?? "" : "").toLowerCase();
  const hit = KINDS.find((k) => k.test.test(ext));
  return { ext, label: hit?.label ?? (ext ? ext.slice(0, 4).toUpperCase() : "FILE"), fg: hit?.fg ?? "#646A73", bg: hit?.bg ?? "#F2F3F5" };
}

export function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

export function FileCard({ fileId, name, size, canDownload, onPreview, href: hrefOverride }: { fileId?: string; name?: string; size?: string; canDownload: boolean; onPreview?: () => void; href?: string }) {
  const kind = fileKind(name);
  const href = hrefOverride ?? `/api/files/${fileId}`;
  const meta = [canDownload ? fmtSize(Number(size ?? 0)) : "下载已关闭", kind.ext ? kind.ext.toUpperCase() : ""].filter(Boolean).join(" · ");
  const btn = "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground";
  return (
    <div
      contentEditable={false}
      className={cn("group/file my-1 flex w-[520px] max-w-full select-none items-center gap-3 rounded-lg border border-[#DEE0E3] bg-surface px-3.5 py-3 transition-colors hover:border-[#BBBFC4] hover:shadow-[0_2px_8px_rgba(31,35,41,0.06)] dark:border-border", onPreview && "cursor-pointer")}
      onClick={() => onPreview?.()}
      data-file-card
      data-file-kind={kind.label}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-md text-[11px] font-bold tracking-tight" style={{ color: kind.fg, background: kind.bg }} data-file-icon>{kind.label}</span>
      <span className="min-w-0 flex-1">
        {canDownload ? <a href={href} onClick={(e) => e.stopPropagation()} className="block truncate text-[14px] font-medium text-foreground hover:text-primary">{name}</a> : <span className="block truncate text-[14px] font-medium">{name}</span>}
        <span className="block text-[12px] text-subtle" data-file-meta>{meta}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/file:opacity-100" data-file-actions>
        {onPreview && <button type="button" title="预览" aria-label="预览" className={btn} onClick={(e) => { e.stopPropagation(); onPreview(); }} data-file-preview><Eye size={15} /></button>}
        {canDownload && <a href={href} download={name} title="下载" aria-label="下载" className={btn} onClick={(e) => e.stopPropagation()} data-file-download><Download size={15} /></a>}
      </span>
    </div>
  );
}
