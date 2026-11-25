import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  Eye,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Music,
  Presentation,
  Table2,
} from "lucide-react";
import { DOCX_MAX_BYTES, DOCX_MIME, readDocxFile, type DocxImportResult } from "@/lib/docx";
import { markdownTableRows, parseMarkdown, type MdBlock, type MdSpan } from "@/lib/markdown";
import { parseCsv, parseTSV, parseXlsxBytesForWorkbook, type ImportedSheetCell, type WorkbookImportPreview } from "@zseven-w/sheet-sdk";
import { parsePptxToSlides, type ImportedSlidePage, type PptxImportResult, type SlideShape } from "@zseven-w/slides-sdk";
import { safeURL } from "@/lib/safe-url";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export type RichPreviewKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "docx"
  | "xlsx"
  | "pptx"
  | "markdown"
  | "csv"
  | "code"
  | "unknown";

export interface RichFilePreviewProps {
  src: string;
  name: string;
  mime?: string;
  size?: number;
  allowCopy?: boolean;
  allowPrint?: boolean;
  theme?: "light" | "dark";
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const MARKDOWN_MAX_CHARS = 512 * 1024;
const CSV_MAX_CHARS = 512 * 1024;
const CODE_MAX_CHARS = 256 * 1024;
const XLSX_MAX_BYTES = 20 * 1024 * 1024;
const PPTX_MAX_BYTES = 25 * 1024 * 1024;

export const XLSX_MAX_PREVIEW_ROWS = 200;
export const XLSX_MAX_PREVIEW_COLS = 40;
export const CSV_MAX_PREVIEW_ROWS = 500;
export const CSV_MAX_PREVIEW_COLS = 50;

const RASTER_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

const RASTER_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
const CSV_EXTS = new Set(["csv", "tsv"]);

const CODE_LANG_BY_EXT: Record<string, string> = {
  json: "JSON",
  jsonc: "JSONC",
  yaml: "YAML",
  yml: "YAML",
  xml: "XML",
  svg: "SVG",
  sql: "SQL",
  txt: "Plain Text",
  log: "Log",
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  jsx: "JSX",
  mjs: "JavaScript",
  cjs: "JavaScript",
  go: "Go",
  py: "Python",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  c: "C",
  h: "C/C++",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  fish: "Fish",
  ps1: "PowerShell",
  bat: "Batch",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  toml: "TOML",
  ini: "INI",
  cfg: "Config",
  conf: "Config",
  env: "Env",
  properties: "Properties",
  diff: "Diff",
  patch: "Patch",
  graphql: "GraphQL",
  gql: "GraphQL",
  proto: "Protobuf",
  tf: "Terraform",
  vue: "Vue",
  svelte: "Svelte",
  lua: "Lua",
  r: "R",
  pl: "Perl",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
};

const CODE_BASENAMES = new Set(["dockerfile", "makefile", "license", "readme", "procfile"]);

const CODE_MIME_RE =
  /^application\/(json|ld\+json|xml|xhtml\+xml|javascript|ecmascript|typescript|x-javascript|x-yaml|yaml|sql|x-sh|x-python|graphql|toml)$/;

function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function normalizeMime(mime?: string): string {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (!base || base === "application/octet-stream" || base === "binary/octet-stream") return "";
  return base;
}

/** Detect rich preview renderer kind by MIME type and filename extension fallback. */
export function detectPreviewKind(name: string, mime?: string): RichPreviewKind {
  const lowerMime = normalizeMime(mime);
  const ext = fileExtension(name);
  const lowerBase = (name.split(/[\\/]/).pop() ?? "").toLowerCase();

  if (lowerMime === "application/pdf" || ext === "pdf") return "pdf";
  if (lowerMime === DOCX_MIME || ext === "docx") return "docx";
  if (lowerMime === XLSX_MIME || ext === "xlsx") return "xlsx";
  if (lowerMime === PPTX_MIME || ext === "pptx") return "pptx";
  if (lowerMime === "text/markdown" || lowerMime === "text/x-markdown" || MARKDOWN_EXTS.has(ext)) return "markdown";
  if (
    lowerMime === "text/csv" ||
    lowerMime === "application/csv" ||
    lowerMime === "text/tab-separated-values" ||
    CSV_EXTS.has(ext)
  ) {
    return "csv";
  }
  if (lowerMime.startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
  if (lowerMime.startsWith("audio/") || AUDIO_EXTS.has(ext)) return "audio";
  if (RASTER_IMAGE_MIMES.has(lowerMime) || RASTER_IMAGE_EXTS.has(ext)) return "image";
  if (
    ext in CODE_LANG_BY_EXT ||
    CODE_BASENAMES.has(lowerBase) ||
    lowerMime.startsWith("text/") ||
    CODE_MIME_RE.test(lowerMime)
  ) {
    return "code";
  }
  return "unknown";
}

/** Returns true if a file can be previewed inline via RichFilePreview. */
export function isRichPreviewable(name?: string, mime?: string): boolean {
  return detectPreviewKind(name ?? "", mime) !== "unknown";
}

/** Human-readable language badge for code/text files. */
export function detectCodeLanguage(name: string, mime?: string): string {
  const ext = fileExtension(name);
  if (ext && CODE_LANG_BY_EXT[ext]) return CODE_LANG_BY_EXT[ext];
  const lowerBase = (name.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (lowerBase === "dockerfile") return "Dockerfile";
  if (lowerBase === "makefile") return "Makefile";
  const lowerMime = normalizeMime(mime);
  if (lowerMime.includes("json")) return "JSON";
  if (lowerMime.includes("yaml")) return "YAML";
  if (lowerMime.includes("xml")) return "XML";
  if (lowerMime.includes("sql")) return "SQL";
  if (lowerMime.includes("javascript")) return "JavaScript";
  if (lowerMime.includes("typescript")) return "TypeScript";
  if (lowerMime === "text/html") return "HTML";
  if (lowerMime === "text/css") return "CSS";
  return "Plain Text";
}

function inferMediaMime(name: string, mime: string | undefined, kind: "video" | "audio"): string {
  const lower = normalizeMime(mime);
  if (lower.startsWith(`${kind}/`)) return lower;
  const ext = fileExtension(name);
  if (kind === "video") {
    if (ext === "webm") return "video/webm";
    if (ext === "ogg" || ext === "ogv") return "video/ogg";
    if (ext === "mov") return "video/quicktime";
    return "video/mp4";
  }
  if (ext === "wav") return "audio/wav";
  if (ext === "ogg" || ext === "oga") return "audio/ogg";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "flac") return "audio/flac";
  if (ext === "aac") return "audio/aac";
  if (ext === "opus") return "audio/opus";
  return "audio/mpeg";
}

function formatBytes(size?: number): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function excelColLabel(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function isSafePreviewImageUrl(url?: string): boolean {
  if (!url) return false;
  if (/^\/api\/files\/[1-9]\d*(\?version=[1-9]\d*)?$/.test(url)) return true;
  if (url.startsWith("blob:")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isDarkHexColor(hex?: string): boolean {
  if (!hex) return false;
  const clean = hex.trim().replace(/^#/, "");
  const full =
    clean.length === 3
      ? clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]
      : clean.length === 6
        ? clean
        : "";
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return false;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 135;
}

/** Unified online file previewer for Drive files and document attachments. */
export function RichFilePreview({
  src,
  name,
  mime,
  size,
  allowCopy = true,
  allowPrint = true,
  theme = "light",
}: RichFilePreviewProps) {
  const kind = detectPreviewKind(name, mime);
  const copyGuard = allowCopy
    ? {}
    : {
        onCopy: (event: React.ClipboardEvent) => event.preventDefault(),
        onCut: (event: React.ClipboardEvent) => event.preventDefault(),
      };

  return (
    <div
      className={cn(
        "flex h-full w-full min-h-0 flex-col items-center justify-center",
        !allowCopy && "select-none",
      )}
      data-rich-file-preview={kind}
      data-preview-theme={theme}
      {...copyGuard}
    >
      {kind === "image" ? (
        <ImagePreview src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : kind === "pdf" ? (
        <PdfPreview src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : kind === "video" ? (
        <VideoPreview src={src} name={name} mime={mime} allowPrint={allowPrint} theme={theme} />
      ) : kind === "audio" ? (
        <AudioPreview src={src} name={name} mime={mime} size={size} allowPrint={allowPrint} theme={theme} />
      ) : kind === "docx" ? (
        <DocxPreview src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : kind === "xlsx" ? (
        <XlsxPreview src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : kind === "pptx" ? (
        <PptxPreview src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : kind === "markdown" ? (
        <MarkdownPreview src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : kind === "csv" ? (
        <CsvPreview src={src} name={name} mime={mime} allowPrint={allowPrint} theme={theme} />
      ) : kind === "code" ? (
        <CodePreview src={src} name={name} mime={mime} allowCopy={allowCopy} allowPrint={allowPrint} theme={theme} />
      ) : (
        <FallbackCard src={src} name={name} mime={mime} size={size} allowPrint={allowPrint} theme={theme} />
      )}
    </div>
  );
}

function PreviewLoading({ label, theme }: { label: string; theme: "light" | "dark" }) {
  return (
    <div className={cn("flex items-center gap-2.5 py-12 text-[13px]", theme === "dark" ? "text-white/70" : "text-[#646a73]")}>
      <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function PreviewError({
  message,
  src,
  name,
  allowPrint,
  theme,
}: {
  message: string;
  src: string;
  name: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className={cn(
        "flex max-w-md flex-col items-center gap-3 rounded-xl border px-6 py-8 text-center",
        theme === "dark" ? "border-white/10 bg-white/5 text-white/80" : "border-[#dee0e3] bg-white text-[#1f2329] shadow-sm",
      )}
    >
      <p className={cn("text-[13px]", theme === "dark" ? "text-white/75" : "text-[#646a73]")}>{message}</p>
      {allowPrint && (
        <a
          href={src}
          download={name}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#3370ff] px-3.5 text-[13px] font-medium text-white no-underline hover:bg-[#245bdb]"
        >
          <Download size={14} />
          {t("下载文件")}
        </a>
      )}
    </div>
  );
}

function FallbackCard({
  src,
  name,
  mime,
  size,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  mime?: string;
  size?: number;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const sizeText = formatBytes(size);
  const ext = fileExtension(name).toUpperCase();
  const metaParts = [sizeText, ext || normalizeMime(mime)].filter(Boolean);
  return (
    <div
      data-fallback-preview
      className={cn(
        "flex max-w-md flex-col items-center gap-3 rounded-2xl px-8 py-10 text-center",
        theme === "dark" ? "bg-white/5 text-white" : "border border-[#dee0e3] bg-white text-[#1f2329] shadow-sm",
      )}
    >
      <span
        className={cn(
          "grid size-16 place-items-center rounded-2xl",
          theme === "dark" ? "bg-white/10 text-[#9ab8ff]" : "bg-[#f0f4ff] text-[#3370ff]",
        )}
      >
        <FileText size={32} />
      </span>
      <h2 className="break-all text-[16px] font-medium">{name}</h2>
      <p className={cn("text-[13px]", theme === "dark" ? "text-white/60" : "text-[#8f959e]")}>
        {metaParts.length > 0 ? `${metaParts.join(" · ")} · ` : ""}
        {allowPrint ? t("此格式暂不支持在线预览，可下载查看") : t("下载未开放")}
      </p>
      {allowPrint && (
        <a
          href={src}
          download={name}
          className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-md bg-[#3370ff] px-4 text-[13px] font-medium text-white no-underline hover:bg-[#245bdb]"
        >
          <Download size={14} />
          {t("下载文件")}
        </a>
      )}
    </div>
  );
}

function ImagePreview({
  src,
  name,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  if (failed) {
    return <PreviewError message={t("图片加载失败")} src={src} name={name} allowPrint={allowPrint} theme={theme} />;
  }
  return (
    <img
      src={src}
      alt={name}
      data-image-preview
      draggable={allowPrint}
      data-document-print-restricted={!allowPrint ? "true" : undefined}
      onContextMenu={(event) => {
        if (!allowPrint) event.preventDefault();
      }}
      onError={() => setFailed(true)}
      className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
    />
  );
}

/**
 * Fetches the PDF into a same-origin Blob URL (`application/pdf`) so it renders
 * inline in `<iframe>` even when `/api/files/{id}` sends `Content-Disposition: attachment`.
 */
function PdfPreview({
  src,
  name,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    const controller = new AbortController();
    setBlobUrl(null);
    setError("");

    fetch(src, { credentials: "same-origin", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!active) return;
        const blob = new Blob([buf], { type: "application/pdf" });
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : t("无法加载 PDF 预览"));
      });

    return () => {
      active = false;
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src]);

  if (error) {
    return <PreviewError message={`${t("加载失败")}：${error}`} src={src} name={name} allowPrint={allowPrint} theme={theme} />;
  }

  const iframeSrc = blobUrl ? (allowPrint ? blobUrl : `${blobUrl}#toolbar=0`) : undefined;

  return (
    <div className="relative h-full w-full max-w-5xl min-h-[420px]">
      <iframe
        src={iframeSrc}
        title={name}
        className={cn(
          "h-full w-full rounded-lg bg-white",
          theme === "dark" ? "shadow-2xl" : "border border-[#dee0e3] shadow-sm",
        )}
        data-pdf-frame
      />
      {!blobUrl && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-white/90">
          <PreviewLoading label={t("正在加载 PDF 预览…")} theme="light" />
        </div>
      )}
    </div>
  );
}

function useMediaBlobFallback(src: string, name: string, mime: string | undefined, kind: "video" | "audio") {
  const [mediaSrc, setMediaSrc] = useState(src);
  const [fallbackTried, setFallbackTried] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setMediaSrc(src);
    setFallbackTried(false);
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (!mediaSrc.startsWith("blob:")) return;
    return () => {
      URL.revokeObjectURL(mediaSrc);
    };
  }, [mediaSrc]);

  const handleError = () => {
    if (fallbackTried) {
      setFailed(true);
      return;
    }
    setFallbackTried(true);
    const resolvedMime = inferMediaMime(name, mime, kind);
    fetch(src, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const url = URL.createObjectURL(new Blob([buf], { type: resolvedMime }));
        setMediaSrc(url);
      })
      .catch(() => setFailed(true));
  };

  return { mediaSrc, failed, handleError };
}

function VideoPreview({
  src,
  name,
  mime,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  mime?: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const { mediaSrc, failed, handleError } = useMediaBlobFallback(src, name, mime, "video");
  if (failed) {
    return <PreviewError message={t("视频无法在线播放，可尝试下载后查看")} src={src} name={name} allowPrint={allowPrint} theme={theme} />;
  }
  return (
    <div className="flex max-h-full w-full max-w-5xl items-center justify-center">
      <video
        key={mediaSrc}
        src={mediaSrc}
        controls
        playsInline
        preload="metadata"
        controlsList={!allowPrint ? "nodownload" : undefined}
        onContextMenu={(event) => {
          if (!allowPrint) event.preventDefault();
        }}
        onError={handleError}
        className="max-h-[80vh] w-full rounded-xl bg-black shadow-lg"
        data-video-preview
      />
    </div>
  );
}

function AudioPreview({
  src,
  name,
  mime,
  size,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  mime?: string;
  size?: number;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const { mediaSrc, failed, handleError } = useMediaBlobFallback(src, name, mime, "audio");
  if (failed) {
    return <PreviewError message={t("音频无法在线播放，可尝试下载后查看")} src={src} name={name} allowPrint={allowPrint} theme={theme} />;
  }
  const ext = fileExtension(name).toUpperCase() || "AUDIO";
  const sizeText = formatBytes(size);
  return (
    <div
      data-audio-preview
      className={cn(
        "flex w-full max-w-lg flex-col items-center gap-5 rounded-2xl border p-8 shadow-sm",
        theme === "dark" ? "border-white/15 bg-[#2a2c32] text-white" : "border-[#dee0e3] bg-white text-[#1f2329]",
      )}
    >
      <span
        className={cn(
          "grid size-20 place-items-center rounded-2xl",
          theme === "dark" ? "bg-[#3370ff]/25 text-[#9ab8ff]" : "bg-[#f0f4ff] text-[#3370ff]",
        )}
      >
        <Music size={36} />
      </span>
      <div className="w-full text-center">
        <h2 className="break-all text-[16px] font-medium">{name}</h2>
        <p className={cn("mt-1 text-[12px]", theme === "dark" ? "text-white/55" : "text-[#8f959e]")}>
          {[ext, sizeText].filter(Boolean).join(" · ")}
        </p>
      </div>
      <audio
        key={mediaSrc}
        src={mediaSrc}
        controls
        preload="metadata"
        controlsList={!allowPrint ? "nodownload" : undefined}
        onContextMenu={(event) => {
          if (!allowPrint) event.preventDefault();
        }}
        onError={handleError}
        className="w-full"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared safe rich-text & block renderers (used by DOCX & Markdown previews)
// ---------------------------------------------------------------------------

function SafeInlineSpans({ spans }: { spans: readonly MdSpan[] }) {
  return (
    <>
      {spans.map((span, idx) => {
        const marks = span.marks ?? {};
        const style: CSSProperties = {};
        if (marks.color) style.color = marks.color;
        if (marks.bg) style.backgroundColor = marks.bg;
        if (marks.underline || marks.strike) {
          style.textDecoration = [marks.underline && "underline", marks.strike && "line-through"]
            .filter(Boolean)
            .join(" ");
        }
        const cls = cn(
          marks.bold && "font-semibold",
          marks.italic && "italic",
          marks.code && "rounded bg-[#f2f3f5] px-1.5 py-0.5 font-mono text-[0.88em] text-[#d83931]",
        );
        const href = safeURL(marks.link);
        if (href) {
          return (
            <a
              key={idx}
              href={href}
              target={href.startsWith("#/") ? undefined : "_blank"}
              rel={href.startsWith("#/") ? undefined : "noopener noreferrer"}
              className={cn(cls, "text-[#3370ff] underline-offset-2 hover:underline")}
              style={style}
            >
              {span.text}
            </a>
          );
        }
        return (
          <span key={idx} className={cls} style={style}>
            {span.text}
          </span>
        );
      })}
    </>
  );
}

function RenderBlockList({
  blocks,
  imageUrls,
}: {
  blocks: readonly MdBlock[];
  imageUrls?: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  const counters: number[] = [];

  return (
    <div className="space-y-2.5 text-[15px] leading-7 text-[#1f2329]">
      {blocks.map((block, idx) => {
        const indent = Math.max(0, Math.min(8, Number(block.props.indent) || 0));
        let orderedNumber = 0;
        if (block.type === "ordered") {
          counters.length = indent + 1;
          orderedNumber = counters[indent] = (counters[indent] ?? 0) + 1;
        } else {
          counters.length = 0;
        }
        const spans = block.spans.length ? block.spans : block.text ? [{ text: block.text, marks: {} }] : [];
        const rich = <SafeInlineSpans spans={spans} />;
        const alignStyle: CSSProperties | undefined =
          block.props.align === "center" || block.props.align === "right"
            ? { textAlign: block.props.align }
            : undefined;

        switch (block.type) {
          case "title":
            return (
              <h1 key={idx} className="mb-3 text-[26px] font-semibold leading-tight text-[#1f2329]" style={alignStyle}>
                {rich}
              </h1>
            );
          case "h1":
            return (
              <h1 key={idx} className="mt-5 text-[24px] font-semibold leading-snug text-[#1f2329]" style={alignStyle}>
                {rich}
              </h1>
            );
          case "h2":
            return (
              <h2 key={idx} className="mt-4 text-[20px] font-semibold leading-snug text-[#1f2329]" style={alignStyle}>
                {rich}
              </h2>
            );
          case "h3":
            return (
              <h3 key={idx} className="mt-3.5 text-[18px] font-semibold leading-snug text-[#1f2329]" style={alignStyle}>
                {rich}
              </h3>
            );
          case "h4":
          case "h5":
          case "h6":
          case "h7":
          case "h8":
          case "h9":
            return (
              <h4 key={idx} className="mt-3 text-[16px] font-semibold leading-snug text-[#1f2329]" style={alignStyle}>
                {rich}
              </h4>
            );
          case "bullet":
          case "ordered":
          case "todo": {
            const checked = block.props.checked === "true";
            const marker =
              block.type === "bullet"
                ? ["•", "◦", "▪"][indent % 3]
                : block.type === "ordered"
                  ? `${orderedNumber}.`
                  : checked
                    ? "☑"
                    : "☐";
            return (
              <div
                key={idx}
                className="flex items-start gap-2"
                style={{ marginLeft: indent * 20, ...alignStyle }}
              >
                <span className={cn("min-w-[18px] shrink-0 text-center", block.type !== "todo" && "text-[#3370ff]")}>
                  {marker}
                </span>
                <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", block.type === "todo" && checked && "text-[#8f959e] line-through")}>
                  {rich}
                </span>
              </div>
            );
          }
          case "quote":
            return (
              <blockquote
                key={idx}
                className="my-2 border-l-3 border-[#bbbfc4] bg-[#f8f9fa] py-1.5 pl-3.5 pr-2 text-[#646a73]"
                style={alignStyle}
              >
                {rich}
              </blockquote>
            );
          case "callout":
            return (
              <div
                key={idx}
                className="my-2 flex gap-2.5 rounded-lg border border-[#d0e0ff] bg-[#f0f4ff] px-3.5 py-2.5 text-[#1f2329]"
              >
                <span className="shrink-0">{block.props.emoji || "💡"}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{rich}</span>
              </div>
            );
          case "code":
          case "math":
          case "diagram":
            return (
              <div key={idx} className="my-2 overflow-hidden rounded-lg border border-[#dee0e3] bg-[#f5f6f7]">
                {(block.props.lang || block.type !== "code") && (
                  <div className="border-b border-[#e5e6eb] px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-[#646a73]">
                    {block.props.lang || (block.type === "math" ? "LaTeX" : "Mermaid")}
                  </div>
                )}
                <pre className="overflow-x-auto p-3.5 font-mono text-[13px] leading-6 text-[#1f2329]">
                  <code>{block.text}</code>
                </pre>
              </div>
            );
          case "divider":
            return <hr key={idx} className="my-4 h-px border-0 bg-[#dee0e3]" />;
          case "table": {
            const rows = markdownTableRows(block.props.tableData);
            if (!rows) {
              return (
                <pre key={idx} className="overflow-x-auto rounded bg-[#f5f6f7] p-3 font-mono text-[12px]">
                  {block.props.tableData}
                </pre>
              );
            }
            const hasHeader = block.props.tableHeader !== "none";
            return (
              <div key={idx} className="my-3 overflow-x-auto">
                <table className="min-w-full border-collapse text-[13.5px] leading-6">
                  <tbody>
                    {rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {row.map((cell, cIdx) => {
                          const Tag = hasHeader && rIdx === 0 ? "th" : "td";
                          return (
                            <Tag
                              key={cIdx}
                              className={cn(
                                "border border-[#dee0e3] px-3 py-1.5 text-left align-top whitespace-pre-wrap break-words",
                                hasHeader && rIdx === 0 ? "bg-[#f5f6f7] font-medium text-[#1f2329]" : "bg-white text-[#1f2329]",
                              )}
                            >
                              {cell}
                            </Tag>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case "image": {
            const blobSrc = block.props.importImageId ? imageUrls?.get(block.props.importImageId) : undefined;
            const rawUrl = blobSrc ?? (isSafePreviewImageUrl(block.props.url) ? block.props.url : undefined);
            const label = block.props.caption || block.props.name || t("图片");
            return (
              <figure key={idx} className="my-3 flex flex-col items-center">
                {rawUrl ? (
                  <img
                    src={rawUrl}
                    alt={label}
                    referrerPolicy="no-referrer"
                    className="max-h-[480px] max-w-full rounded-md border border-[#e5e6eb] object-contain"
                  />
                ) : (
                  <div className="rounded-md border border-dashed border-[#dee0e3] bg-[#f8f9fa] px-4 py-2 text-[13px] text-[#646a73]">
                    [{t("图片")}：{label}]
                  </div>
                )}
                {block.props.caption && (
                  <figcaption className="mt-1.5 text-center text-[12.5px] text-[#8f959e]">
                    {block.props.caption}
                  </figcaption>
                )}
              </figure>
            );
          }
          default:
            return (
              <p key={idx} className="whitespace-pre-wrap break-words" style={alignStyle}>
                {rich}
              </p>
            );
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DOCX Preview
// ---------------------------------------------------------------------------

export function DocxPreviewContent({
  result,
  name,
  imageUrls,
}: {
  result: DocxImportResult;
  name: string;
  imageUrls?: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  return (
    <div className="flex max-h-full w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#e5e6eb] bg-[#f8f9fa] px-5 py-2.5 text-[12px] text-[#646a73]">
        <span className="inline-flex items-center gap-1 rounded bg-[#e8efff] px-2 py-0.5 font-medium text-[#3370ff]">
          <FileText size={12} />
          DOCX
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-[#1f2329]">{result.title || name}</span>
        <span>{t("共 {n} 个内容块", { n: result.blocks.length })}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-7 py-6 sm:px-10 sm:py-8">
        {result.title && !result.blocks.some((b) => b.type === "title") && (
          <h1 className="mb-4 text-[26px] font-semibold leading-tight text-[#1f2329]">{result.title}</h1>
        )}
        <RenderBlockList blocks={result.blocks} imageUrls={imageUrls} />
        {result.warnings.length > 0 && (
          <div className="mt-6 rounded-lg border border-[#ffe3b8] bg-[#fff7e8] px-3.5 py-2.5 text-[12px] text-[#9a5700]">
            {t("预览提示")}：{result.warnings.join("；")}
          </div>
        )}
      </div>
    </div>
  );
}

function DocxPreview({
  src,
  name,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<DocxImportResult | null>(null);
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(() => new Map());
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const createdUrls: string[] = [];
    const controller = new AbortController();
    setResult(null);
    setImageUrls(new Map());
    setError("");

    fetch(src, { credentials: "same-origin", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength > DOCX_MAX_BYTES) throw new Error(t("Word 文件超过 10 MB 预览限制"));
        const parsed = await readDocxFile({ size: buf.byteLength, arrayBuffer: async () => buf }, { images: true });
        if (!active) return;
        const map = new Map<string, string>();
        if (parsed.images) {
          for (const [id, img] of parsed.images) {
            const url = URL.createObjectURL(new Blob([img.data.slice().buffer as ArrayBuffer], { type: img.contentType }));
            createdUrls.push(url);
            map.set(id, url);
          }
        }
        setImageUrls(map);
        setResult(parsed);
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : t("无法解析 Word 文档"));
      });

    return () => {
      active = false;
      controller.abort();
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [src]);

  return (
    <div data-docx-preview className="flex h-full w-full items-center justify-center">
      {error ? (
        <PreviewError message={`${t("加载失败")}：${error}`} src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : !result ? (
        <PreviewLoading label={t("正在解析 Word 文档…")} theme={theme} />
      ) : (
        <DocxPreviewContent result={result} name={name} imageUrls={imageUrls} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// XLSX Preview
// ---------------------------------------------------------------------------

export function XlsxPreviewContent({
  workbook,
  name,
}: {
  workbook: WorkbookImportPreview;
  name: string;
}) {
  const { t } = useI18n();
  const [sheetIndex, setSheetIndex] = useState(0);
  const safeIndex = Math.min(sheetIndex, Math.max(0, workbook.sheets.length - 1));
  const sheet = workbook.sheets[safeIndex];

  const grid = useMemo(() => {
    if (!sheet) {
      return {
        cellMap: new Map<string, ImportedSheetCell>(),
        mergeMap: new Map<string, { rowSpan: number; colSpan: number } | "hidden">(),
        actualRows: 0,
        actualCols: 0,
        displayRows: 0,
        displayCols: 0,
        truncated: false,
      };
    }
    const cellMap = new Map<string, ImportedSheetCell>();
    let maxRow = 0;
    let maxCol = 0;
    for (const cell of sheet.cells) {
      cellMap.set(`${cell.row}:${cell.col}`, cell);
      if (cell.row > maxRow) maxRow = cell.row;
      if (cell.col > maxCol) maxCol = cell.col;
    }
    for (const m of sheet.merges ?? []) {
      if (m.bottom > maxRow) maxRow = m.bottom;
      if (m.right > maxCol) maxCol = m.right;
    }
    const actualRows = sheet.cells.length || sheet.merges?.length ? maxRow + 1 : 1;
    const actualCols = sheet.cells.length || sheet.merges?.length ? maxCol + 1 : 1;
    const displayRows = Math.min(actualRows, XLSX_MAX_PREVIEW_ROWS);
    const displayCols = Math.min(actualCols, XLSX_MAX_PREVIEW_COLS);
    const truncated = actualRows > XLSX_MAX_PREVIEW_ROWS || actualCols > XLSX_MAX_PREVIEW_COLS;

    const mergeMap = new Map<string, { rowSpan: number; colSpan: number } | "hidden">();
    for (const m of sheet.merges ?? []) {
      if (m.top >= displayRows || m.left >= displayCols) continue;
      const bottom = Math.min(m.bottom, displayRows - 1);
      const right = Math.min(m.right, displayCols - 1);
      mergeMap.set(`${m.top}:${m.left}`, { rowSpan: bottom - m.top + 1, colSpan: right - m.left + 1 });
      for (let r = m.top; r <= bottom; r++) {
        for (let c = m.left; c <= right; c++) {
          if (r === m.top && c === m.left) continue;
          mergeMap.set(`${r}:${c}`, "hidden");
        }
      }
    }
    return { cellMap, mergeMap, actualRows, actualCols, displayRows, displayCols, truncated };
  }, [sheet]);

  if (!sheet) {
    return (
      <div className="rounded-xl border border-[#dee0e3] bg-white px-6 py-10 text-[13px] text-[#646a73]">
        {t("工作簿为空")}
      </div>
    );
  }

  return (
    <div className="flex h-full max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#e5e6eb] bg-[#f8f9fa] px-4 py-2.5 text-[12px] text-[#646a73]">
        <span className="inline-flex items-center gap-1 rounded bg-[#eef9ec] px-2 py-0.5 font-medium text-[#2ea121]">
          <FileSpreadsheet size={12} />
          XLSX
        </span>
        <span className="truncate font-medium text-[#1f2329]">{name}</span>
        <span>·</span>
        <span>
          {grid.actualRows} × {grid.actualCols}
        </span>
        {grid.truncated && (
          <span
            data-xlsx-truncated
            className="ml-auto rounded bg-[#fff7e8] px-2 py-0.5 text-[11.5px] text-[#9a5700]"
          >
            {t("数据量较大，已仅预览前 {rows} 行 × {cols} 列", {
              rows: XLSX_MAX_PREVIEW_ROWS,
              cols: XLSX_MAX_PREVIEW_COLS,
            })}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[13px] text-[#1f2329]">
          <thead className="sticky top-0 z-10 bg-[#f5f6f7]">
            <tr>
              <th className="sticky left-0 z-20 w-10 border-b border-r border-[#dee0e3] bg-[#f5f6f7] px-2 py-1.5 text-center text-[11px] font-medium text-[#8f959e]" />
              {Array.from({ length: grid.displayCols }, (_, c) => (
                <th
                  key={c}
                  className="min-w-[88px] max-w-[260px] border-b border-r border-[#dee0e3] bg-[#f5f6f7] px-2.5 py-1.5 text-center text-[11.5px] font-medium text-[#646a73]"
                >
                  {excelColLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: grid.displayRows }, (_, r) => (
              <tr key={r} className="hover:bg-[#f7f9ff]">
                <th className="sticky left-0 z-[5] border-b border-r border-[#dee0e3] bg-[#f5f6f7] px-2 py-1 text-center text-[11px] font-normal tabular-nums text-[#8f959e]">
                  {r + 1}
                </th>
                {Array.from({ length: grid.displayCols }, (_, c) => {
                  const key = `${r}:${c}`;
                  const merge = grid.mergeMap.get(key);
                  if (merge === "hidden") return null;
                  const cell = grid.cellMap.get(key);
                  const style: CSSProperties = {};
                  if (cell?.style?.bg) style.backgroundColor = cell.style.bg;
                  if (cell?.style?.color) style.color = cell.style.color;
                  if (cell?.style?.align) style.textAlign = cell.style.align;
                  return (
                    <td
                      key={c}
                      rowSpan={merge?.rowSpan}
                      colSpan={merge?.colSpan}
                      style={style}
                      className={cn(
                        "max-w-[260px] truncate border-b border-r border-[#ebedf0] px-2.5 py-1.5 align-middle",
                        cell?.style?.bold && "font-semibold",
                        cell?.style?.italic && "italic",
                        cell?.style?.wrap && "whitespace-pre-wrap break-words",
                      )}
                      title={cell?.raw || undefined}
                    >
                      {cell?.raw ?? ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        role="tablist"
        aria-label={t("工作表列表")}
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-[#e5e6eb] bg-[#f5f6f7] px-3 py-1.5"
      >
        {workbook.sheets.map((ws, idx) => (
          <button
            key={`${ws.title}-${idx}`}
            type="button"
            role="tab"
            aria-selected={idx === safeIndex}
            data-xlsx-sheet-tab={idx}
            onClick={() => setSheetIndex(idx)}
            className={cn(
              "shrink-0 rounded-md px-3 py-1 text-[12.5px] transition-colors",
              idx === safeIndex
                ? "bg-white font-medium text-[#3370ff] shadow-xs"
                : "text-[#646a73] hover:bg-white/70 hover:text-[#1f2329]",
            )}
          >
            {ws.title}
          </button>
        ))}
      </div>
    </div>
  );
}

function XlsxPreview({
  src,
  name,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [workbook, setWorkbook] = useState<WorkbookImportPreview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setWorkbook(null);
    setError("");

    fetch(src, { credentials: "same-origin", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength > XLSX_MAX_BYTES) throw new Error(t("表格文件超过 20 MB 预览限制"));
        const parsed = await parseXlsxBytesForWorkbook(new Uint8Array(buf));
        if (active) setWorkbook(parsed);
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : t("无法解析 Excel 表格"));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [src]);

  return (
    <div data-xlsx-preview className="flex h-full w-full items-center justify-center">
      {error ? (
        <PreviewError message={`${t("加载失败")}：${error}`} src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : !workbook ? (
        <PreviewLoading label={t("正在解析 Excel 表格…")} theme={theme} />
      ) : (
        <XlsxPreviewContent workbook={workbook} name={name} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PPTX Preview
// ---------------------------------------------------------------------------

function SlideShapeView({
  shape,
  mediaUrls,
}: {
  shape: SlideShape;
  mediaUrls?: ReadonlyMap<string, string>;
}) {
  const style: CSSProperties = {
    position: "absolute",
    left: `${shape.x}%`,
    top: `${shape.y}%`,
    width: `${shape.width ?? 16}%`,
    height: `${shape.height ?? 16}%`,
    transform: shape.rotation ? `rotate(${shape.rotation}deg)` : undefined,
  };

  if (shape.kind === "image") {
    const imgUrl = shape.mediaId ? mediaUrls?.get(shape.mediaId) : undefined;
    if (!imgUrl) return null;
    return (
      <img
        src={imgUrl}
        alt={shape.text || ""}
        style={style}
        className="object-contain"
      />
    );
  }

  if (shape.kind === "table" && shape.table) {
    const rows = shape.table.rows;
    return (
      <div style={style} className="overflow-auto rounded bg-white/95 p-1 shadow-xs">
        <table className="h-full w-full border-collapse text-[11px] text-[#1f2329]">
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      "border border-[#dee0e3] px-1.5 py-0.5",
                      shape.table?.headerRow && ri === 0 && "bg-[#3370ff] font-medium text-white",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (shape.kind === "text") {
    const text =
      shape.paragraphs?.length
        ? shape.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n")
        : (shape.text ?? "");
    return (
      <div
        style={{
          ...style,
          color: shape.color || "#1f2329",
          textAlign: shape.align || "left",
          fontWeight: shape.bold ? 600 : 400,
          fontSize: `${Math.max(10, Math.min(28, Math.round((shape.fontSize ?? 18) * 0.72)))}px`,
        }}
        className="overflow-hidden whitespace-pre-wrap break-words leading-snug"
      >
        {text}
      </div>
    );
  }

  if (shape.kind.startsWith("line")) {
    return (
      <div
        style={{
          ...style,
          borderTop: `2px solid ${shape.color || "#3370ff"}`,
          height: 0,
        }}
      />
    );
  }

  return (
    <div
      style={{
        ...style,
        backgroundColor: shape.color || "#3370ff",
        borderRadius: shape.kind === "ellipse" ? "9999px" : shape.kind === "rounded-rectangle" ? "10px" : "4px",
        opacity: 0.9,
      }}
    />
  );
}

export function PptxPreviewContent({
  presentation,
  name,
  mediaUrls,
}: {
  presentation: PptxImportResult;
  name: string;
  mediaUrls?: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  const [pageIndex, setPageIndex] = useState(0);
  const total = presentation.pages.length;
  const safeIndex = Math.min(pageIndex, Math.max(0, total - 1));
  const slide: ImportedSlidePage | undefined = presentation.pages[safeIndex];

  if (!slide) {
    return (
      <div className="rounded-xl border border-[#dee0e3] bg-white px-6 py-10 text-[13px] text-[#646a73]">
        {t("演示文稿不包含幻灯片")}
      </div>
    );
  }

  const darkBg = isDarkHexColor(slide.background);
  const titleColor = darkBg ? "#ffffff" : "#1f2329";
  const bodyColor = darkBg ? "#e5e7eb" : "#374151";

  return (
    <div className="flex h-full max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#e5e6eb] bg-[#f8f9fa] px-4 py-2.5 text-[12px] text-[#646a73]">
        <span className="inline-flex items-center gap-1 rounded bg-[#fff3e8] px-2 py-0.5 font-medium text-[#ff8800]">
          <Presentation size={12} />
          PPTX
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-[#1f2329]">{name}</span>
        {slide.hidden && (
          <span className="rounded bg-[#f2f3f5] px-2 py-0.5 text-[11px] text-[#8f959e]">{t("隐藏页")}</span>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("上一页")}
            disabled={safeIndex <= 0}
            onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
            className="grid size-7 place-items-center rounded border border-[#dee0e3] bg-white text-[#1f2329] hover:bg-[#f2f3f5] disabled:opacity-40"
          >
            <ChevronLeft size={15} />
          </button>
          <span data-pptx-counter className="min-w-[68px] text-center font-medium tabular-nums text-[#1f2329]">
            {safeIndex + 1} / {total}
          </span>
          <button
            type="button"
            aria-label={t("下一页")}
            disabled={safeIndex >= total - 1}
            onClick={() => setPageIndex((p) => Math.min(total - 1, p + 1))}
            className="grid size-7 place-items-center rounded border border-[#dee0e3] bg-white text-[#1f2329] hover:bg-[#f2f3f5] disabled:opacity-40"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto bg-[#f0f2f5] p-5">
        <div
          data-pptx-slide-stage
          className="relative aspect-video w-full max-w-[820px] shrink-0 overflow-hidden rounded-lg border border-[#dee0e3] shadow-md"
          style={{ backgroundColor: slide.background || "#ffffff" }}
        >
          {slide.layout === "title" ? (
            <div className="flex h-full w-full flex-col items-center justify-center px-[8%] text-center">
              {slide.title && (
                <h2 className="text-[28px] font-semibold leading-tight sm:text-[34px]" style={{ color: titleColor }}>
                  {slide.title}
                </h2>
              )}
              {slide.body && (
                <p
                  className="mt-4 whitespace-pre-wrap text-[16px] leading-relaxed sm:text-[18px]"
                  style={{ color: bodyColor }}
                >
                  {slide.body}
                </p>
              )}
            </div>
          ) : (
            <div className="flex h-full w-full flex-col px-[6%] py-[5%]">
              {slide.title && (
                <h2 className="text-[22px] font-semibold leading-snug sm:text-[26px]" style={{ color: titleColor }}>
                  {slide.title}
                </h2>
              )}
              {slide.body && (
                <div
                  className="mt-3 flex-1 overflow-auto whitespace-pre-wrap text-[14px] leading-relaxed sm:text-[16px]"
                  style={{ color: bodyColor }}
                >
                  {slide.body}
                </div>
              )}
            </div>
          )}

          {slide.shapes.map((shape) => (
            <SlideShapeView key={shape.id} shape={shape} mediaUrls={mediaUrls} />
          ))}
        </div>

        {slide.notes && (
          <div
            data-pptx-notes
            className="w-full max-w-[820px] rounded-lg border border-[#e5e6eb] bg-white px-4 py-3 text-[13px] text-[#646a73]"
          >
            <div className="mb-1 text-[11.5px] font-medium text-[#8f959e]">{t("演讲者备注")}</div>
            <p className="whitespace-pre-wrap leading-relaxed text-[#1f2329]">{slide.notes}</p>
          </div>
        )}
      </div>

      {total > 1 && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-t border-[#e5e6eb] bg-white px-4 py-2">
          {presentation.pages.map((p, idx) => (
            <button
              key={idx}
              type="button"
              data-pptx-thumb={idx}
              onClick={() => setPageIndex(idx)}
              className={cn(
                "flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors",
                idx === safeIndex
                  ? "border-[#3370ff] bg-[#edf2ff] font-medium text-[#3370ff]"
                  : "border-[#dee0e3] bg-[#f8f9fa] text-[#646a73] hover:bg-[#f2f3f5]",
              )}
            >
              <span className="tabular-nums">{idx + 1}</span>
              <span className="max-w-[110px] truncate">{p.title || t("无标题页")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PptxPreview({
  src,
  name,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [presentation, setPresentation] = useState<PptxImportResult | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Map<string, string>>(() => new Map());
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const createdUrls: string[] = [];
    const controller = new AbortController();
    setPresentation(null);
    setMediaUrls(new Map());
    setError("");

    fetch(src, { credentials: "same-origin", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength > PPTX_MAX_BYTES) throw new Error(t("演示文稿超过 25 MB 预览限制"));
        const parsed = await parsePptxToSlides(new Uint8Array(buf));
        if (!active) return;
        const map = new Map<string, string>();
        if (parsed.media) {
          for (const [id, asset] of Object.entries(parsed.media)) {
            const url = URL.createObjectURL(new Blob([asset.data.slice().buffer as ArrayBuffer], { type: asset.mimeType }));
            createdUrls.push(url);
            map.set(id, url);
          }
        }
        setMediaUrls(map);
        setPresentation(parsed);
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : t("无法解析演示文稿"));
      });

    return () => {
      active = false;
      controller.abort();
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [src]);

  return (
    <div data-pptx-preview className="flex h-full w-full items-center justify-center">
      {error ? (
        <PreviewError message={`${t("加载失败")}：${error}`} src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : !presentation ? (
        <PreviewLoading label={t("正在解析演示文稿…")} theme={theme} />
      ) : (
        <PptxPreviewContent presentation={presentation} name={name} mediaUrls={mediaUrls} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line-numbered source viewer (shared by Markdown / CSV / Code)
// ---------------------------------------------------------------------------

function LineNumberedSource({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").split("\n"), [text]);
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-white p-4 font-mono text-[13px] leading-6 text-[#1f2329]">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, idx) => (
            <tr key={idx} className="hover:bg-[#f7f9fc]">
              <td
                aria-hidden="true"
                className="w-12 select-none pr-4 text-right align-top tabular-nums text-[#8f959e]"
              >
                {idx + 1}
              </td>
              <td className="whitespace-pre-wrap break-words align-top">{line || "\u00a0"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown Preview
// ---------------------------------------------------------------------------

export function MarkdownPreviewContent({
  text,
  name,
  truncated = false,
}: {
  text: string;
  name: string;
  truncated?: boolean;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  return (
    <div className="flex h-full max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#e5e6eb] bg-[#f8f9fa] px-4 py-2 text-[12px] text-[#646a73]">
        <span className="inline-flex items-center gap-1 rounded bg-[#eef2ff] px-2 py-0.5 font-medium text-[#3370ff]">
          <FileText size={12} />
          Markdown
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-[#1f2329]">{name}</span>
        {truncated && (
          <span className="rounded bg-[#fff7e8] px-2 py-0.5 text-[11.5px] text-[#9a5700]">
            {t("内容较长，已截断显示")}
          </span>
        )}
        <div role="group" aria-label={t("视图切换")} className="flex items-center rounded-md border border-[#dee0e3] bg-white p-0.5">
          <button
            type="button"
            data-md-mode="preview"
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2.5 py-1 text-[12px]",
              mode === "preview" ? "bg-[#edf2ff] font-medium text-[#3370ff]" : "text-[#646a73] hover:bg-[#f2f3f5]",
            )}
          >
            <Eye size={13} />
            {t("渲染预览")}
          </button>
          <button
            type="button"
            data-md-mode="source"
            aria-pressed={mode === "source"}
            onClick={() => setMode("source")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2.5 py-1 text-[12px]",
              mode === "source" ? "bg-[#edf2ff] font-medium text-[#3370ff]" : "text-[#646a73] hover:bg-[#f2f3f5]",
            )}
          >
            <Code2 size={13} />
            {t("源码视图")}
          </button>
        </div>
      </div>

      {mode === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto px-7 py-6 sm:px-10">
          {blocks.length > 0 ? (
            <RenderBlockList blocks={blocks} />
          ) : (
            <p className="text-[13px] text-[#8f959e]">{t("空文档")}</p>
          )}
        </div>
      ) : (
        <LineNumberedSource text={text} />
      )}
    </div>
  );
}

function MarkdownPreview({
  src,
  name,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [state, setState] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState(null);
    setError("");

    fetch(src, { credentials: "same-origin", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (!active) return;
        const truncated = raw.length > MARKDOWN_MAX_CHARS;
        setState({ text: truncated ? raw.slice(0, MARKDOWN_MAX_CHARS) : raw, truncated });
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : t("无法加载文件内容"));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [src]);

  return (
    <div data-markdown-preview className="flex h-full w-full items-center justify-center">
      {error ? (
        <PreviewError message={`${t("加载失败")}：${error}`} src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : !state ? (
        <PreviewLoading label={t("正在加载预览…")} theme={theme} />
      ) : (
        <MarkdownPreviewContent text={state.text} name={name} truncated={state.truncated} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV / TSV Preview
// ---------------------------------------------------------------------------

export function CsvPreviewContent({
  text,
  name,
  tsv = false,
  truncated = false,
}: {
  text: string;
  name: string;
  tsv?: boolean;
  truncated?: boolean;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"table" | "source">("table");
  const parsed = useMemo(() => {
    const allRows = tsv ? parseTSV(text) : parseCsv(text);
    const totalRows = allRows.length;
    const totalCols = allRows.reduce((m, row) => Math.max(m, row.length), 0);
    const rowsTruncated = totalRows > CSV_MAX_PREVIEW_ROWS || totalCols > CSV_MAX_PREVIEW_COLS;
    const displayRows = allRows.slice(0, CSV_MAX_PREVIEW_ROWS);
    const displayCols = Math.min(totalCols, CSV_MAX_PREVIEW_COLS);
    return { totalRows, totalCols, displayRows, displayCols, rowsTruncated };
  }, [text, tsv]);

  return (
    <div className="flex h-full max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#e5e6eb] bg-[#f8f9fa] px-4 py-2 text-[12px] text-[#646a73]">
        <span className="inline-flex items-center gap-1 rounded bg-[#eef9ec] px-2 py-0.5 font-medium text-[#2ea121]">
          <Table2 size={12} />
          {tsv ? "TSV" : "CSV"}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-[#1f2329]">{name}</span>
        <span>
          {parsed.totalRows} × {parsed.totalCols}
        </span>
        {(truncated || parsed.rowsTruncated) && (
          <span className="rounded bg-[#fff7e8] px-2 py-0.5 text-[11.5px] text-[#9a5700]">
            {t("内容较长，已截断显示")}
          </span>
        )}
        <div role="group" aria-label={t("视图切换")} className="flex items-center rounded-md border border-[#dee0e3] bg-white p-0.5">
          <button
            type="button"
            data-csv-mode="table"
            aria-pressed={mode === "table"}
            onClick={() => setMode("table")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2.5 py-1 text-[12px]",
              mode === "table" ? "bg-[#edf2ff] font-medium text-[#3370ff]" : "text-[#646a73] hover:bg-[#f2f3f5]",
            )}
          >
            <Table2 size={13} />
            {t("表格视图")}
          </button>
          <button
            type="button"
            data-csv-mode="source"
            aria-pressed={mode === "source"}
            onClick={() => setMode("source")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2.5 py-1 text-[12px]",
              mode === "source" ? "bg-[#edf2ff] font-medium text-[#3370ff]" : "text-[#646a73] hover:bg-[#f2f3f5]",
            )}
          >
            <Code2 size={13} />
            {t("源码视图")}
          </button>
        </div>
      </div>

      {mode === "table" ? (
        parsed.displayRows.length === 0 ? (
          <div className="grid flex-1 place-items-center p-8 text-[13px] text-[#8f959e]">{t("文件内容为空")}</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="min-w-full border-collapse text-[13px] text-[#1f2329]">
              <thead className="sticky top-0 z-10 bg-[#f5f6f7]">
                <tr>
                  <th className="w-10 border-b border-r border-[#dee0e3] bg-[#f5f6f7] px-2 py-2 text-center text-[11px] font-medium text-[#8f959e]">
                    #
                  </th>
                  {Array.from({ length: parsed.displayCols }, (_, c) => (
                    <th
                      key={c}
                      className="max-w-[260px] truncate border-b border-r border-[#dee0e3] bg-[#f5f6f7] px-3 py-2 text-left font-medium text-[#1f2329]"
                      title={parsed.displayRows[0]?.[c] ?? ""}
                    >
                      {parsed.displayRows[0]?.[c] ?? ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.displayRows.slice(1).map((row, ri) => (
                  <tr key={ri} className={ri % 2 === 1 ? "bg-[#fafbfc]" : "bg-white"}>
                    <td className="border-b border-r border-[#ebedf0] bg-[#f8f9fa] px-2 py-1.5 text-center text-[11px] tabular-nums text-[#8f959e]">
                      {ri + 1}
                    </td>
                    {Array.from({ length: parsed.displayCols }, (_, c) => (
                      <td
                        key={c}
                        className="max-w-[260px] truncate border-b border-r border-[#ebedf0] px-3 py-1.5"
                        title={row[c] ?? ""}
                      >
                        {row[c] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <LineNumberedSource text={text} />
      )}
    </div>
  );
}

function CsvPreview({
  src,
  name,
  mime,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  mime?: string;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [state, setState] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const tsv = fileExtension(name) === "tsv" || normalizeMime(mime) === "text/tab-separated-values";

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState(null);
    setError("");

    fetch(src, { credentials: "same-origin", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (!active) return;
        const truncated = raw.length > CSV_MAX_CHARS;
        setState({ text: truncated ? raw.slice(0, CSV_MAX_CHARS) : raw, truncated });
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : t("无法加载文件内容"));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [src]);

  return (
    <div data-csv-preview className="flex h-full w-full items-center justify-center">
      {error ? (
        <PreviewError message={`${t("加载失败")}：${error}`} src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : !state ? (
        <PreviewLoading label={t("正在加载预览…")} theme={theme} />
      ) : (
        <CsvPreviewContent text={state.text} name={name} tsv={tsv} truncated={state.truncated} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code / JSON / YAML / XML / SQL / Plain Text Preview
// ---------------------------------------------------------------------------

export function CodePreviewContent({
  text,
  name,
  mime,
  allowCopy = true,
  truncated = false,
}: {
  text: string;
  name: string;
  mime?: string;
  allowCopy?: boolean;
  truncated?: boolean;
}) {
  const { t } = useI18n();
  const language = detectCodeLanguage(name, mime);
  const formattedJson = useMemo(() => {
    if (truncated || (language !== "JSON" && normalizeMime(mime) !== "application/json")) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null;
    }
  }, [text, language, mime, truncated]);

  const [prettyJson, setPrettyJson] = useState(true);
  const [copied, setCopied] = useState(false);

  const displayed = formattedJson !== null && prettyJson ? formattedJson : text;
  const lineCount = useMemo(() => displayed.replace(/\r\n?/g, "\n").split("\n").length, [displayed]);

  const copyText = async () => {
    if (!allowCopy || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(displayed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore clipboard denial */
    }
  };

  return (
    <div className="flex h-full max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#e5e6eb] bg-[#f8f9fa] px-4 py-2 text-[12px] text-[#646a73]">
        <span
          data-code-lang
          className="inline-flex items-center gap-1 rounded bg-[#f2f3f5] px-2 py-0.5 font-medium text-[#1f2329]"
        >
          <FileCode2 size={12} className="text-[#3370ff]" />
          {language}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-[#1f2329]">{name}</span>
        <span className="tabular-nums">{t("{n} 行", { n: lineCount })}</span>
        {truncated && (
          <span className="rounded bg-[#fff7e8] px-2 py-0.5 text-[11.5px] text-[#9a5700]">
            {t("内容较长，已截断显示")}
          </span>
        )}
        {formattedJson !== null && (
          <button
            type="button"
            data-json-pretty-toggle
            onClick={() => setPrettyJson((v) => !v)}
            className="rounded border border-[#dee0e3] bg-white px-2.5 py-1 text-[12px] text-[#1f2329] hover:bg-[#f2f3f5]"
          >
            {prettyJson ? t("查看原始文本") : t("格式化 JSON")}
          </button>
        )}
        {allowCopy && (
          <button
            type="button"
            onClick={() => void copyText()}
            className="inline-flex items-center gap-1 rounded border border-[#dee0e3] bg-white px-2.5 py-1 text-[12px] text-[#1f2329] hover:bg-[#f2f3f5]"
          >
            {copied ? <Check size={13} className="text-[#2ea121]" /> : <Copy size={13} />}
            {copied ? t("已复制") : t("复制")}
          </button>
        )}
      </div>

      <LineNumberedSource text={displayed} />
    </div>
  );
}

function CodePreview({
  src,
  name,
  mime,
  allowCopy,
  allowPrint,
  theme,
}: {
  src: string;
  name: string;
  mime?: string;
  allowCopy: boolean;
  allowPrint: boolean;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [state, setState] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState(null);
    setError("");

    fetch(src, { credentials: "same-origin", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (!active) return;
        const truncated = raw.length > CODE_MAX_CHARS;
        setState({ text: truncated ? raw.slice(0, CODE_MAX_CHARS) : raw, truncated });
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === "AbortError")) return;
        setError(err instanceof Error ? err.message : t("无法加载文件内容"));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [src]);

  return (
    <div data-code-preview className="flex h-full w-full items-center justify-center">
      {error ? (
        <PreviewError message={`${t("加载失败")}：${error}`} src={src} name={name} allowPrint={allowPrint} theme={theme} />
      ) : !state ? (
        <PreviewLoading label={t("正在加载预览…")} theme={theme} />
      ) : (
        <CodePreviewContent text={state.text} name={name} mime={mime} allowCopy={allowCopy} truncated={state.truncated} />
      )}
    </div>
  );
}
