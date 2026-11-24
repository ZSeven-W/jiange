import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BarChart3,
  Check,
  Clock,
  Edit3,
  Eye,
  ExternalLink,
  Link2,
  PanelsTopLeft,
  Play,
  Plus,
  Settings2,
  Timer,
  Trash2,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { safeURL } from "@/lib/safe-url";
import { cn } from "@/lib/utils";

export interface UploadedMedia {
  id: number;
  name: string;
  mime: string;
  size: number;
}

export type MediaUploadFn = (file: File, onProgress?: (percent: number) => void) => Promise<UploadedMedia>;

const CANONICAL_FILE_ID = /^[1-9]\d*$/;
const INTERNAL_FILE_URL = /^\/api\/files\/[1-9]\d*(?:\?version=[1-9]\d*)?$/;
const INTERNAL_PUBLIC_FILE_URL = /^\/api\/public\/[A-Za-z0-9_-]{1,256}\/files\/[1-9]\d*$/;

/** Resolve an uploaded file ID to its authenticated or public API stream URL. */
export function resolveMediaFileUrl(fileId?: string, publicToken?: string, versionSeq?: number): string | undefined {
  if (!fileId || !CANONICAL_FILE_ID.test(fileId)) return undefined;
  if (publicToken) return `/api/public/${encodeURIComponent(publicToken)}/files/${fileId}`;
  const suffix = Number.isSafeInteger(versionSeq) && (versionSeq ?? 0) > 0 ? `?version=${versionSeq}` : "";
  return `/api/files/${fileId}${suffix}`;
}

/** Validate a media playback URL: allows http(s) and internal `/api/files/...` paths only. */
export function safeMediaUrl(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (INTERNAL_FILE_URL.test(trimmed) || INTERNAL_PUBLIC_FILE_URL.test(trimmed)) return trimmed;
  const checked = safeURL(trimmed);
  if (checked && /^https?:\/\//i.test(checked)) return checked;
  return undefined;
}

/** Whether a validated URL points directly to a browser-playable HTML5 video file. */
export function isDirectVideoUrl(raw?: string): boolean {
  const safe = safeMediaUrl(raw);
  if (!safe) return false;
  if (INTERNAL_FILE_URL.test(safe) || INTERNAL_PUBLIC_FILE_URL.test(safe)) return true;
  return /^https?:\/\//i.test(safe) && /\.(mp4|webm|ogg|mov)(\?|$)/i.test(safe);
}

export interface VideoEmbedInfo {
  provider: "youtube" | "bilibili" | "vimeo";
  label: string;
  embedSrc: string;
}

/** Parse known safe video embed URLs (YouTube, Bilibili, Vimeo) into canonical iframe URLs. */
export function videoEmbedUrl(raw?: string): VideoEmbedInfo | null {
  const safe = safeURL(raw?.trim());
  if (!safe || !/^https?:\/\//i.test(safe)) return null;
  let parsed: URL;
  try {
    parsed = new URL(safe);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // YouTube
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") || host === "www.youtube-nocookie.com") {
    let id = "";
    if (host === "youtu.be") {
      id = path.replace(/^\/+/, "").split("/")[0] ?? "";
    } else if (path === "/watch") {
      id = parsed.searchParams.get("v") ?? "";
    } else {
      const m = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,32})(?:\/|$)/.exec(path);
      if (m) id = m[1];
    }
    if (/^[A-Za-z0-9_-]{6,32}$/.test(id)) {
      return { provider: "youtube", label: "YouTube", embedSrc: `https://www.youtube.com/embed/${id}` };
    }
  }

  // Bilibili
  if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
    if (host === "player.bilibili.com" && path === "/player.html") {
      const bvid = parsed.searchParams.get("bvid") ?? "";
      const aid = parsed.searchParams.get("aid") ?? "";
      if (/^BV[A-Za-z0-9]{6,20}$/.test(bvid)) {
        return {
          provider: "bilibili",
          label: "Bilibili",
          embedSrc: `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&high_quality=1&autoplay=0`,
        };
      }
      if (/^[1-9]\d{0,15}$/.test(aid)) {
        return {
          provider: "bilibili",
          label: "Bilibili",
          embedSrc: `https://player.bilibili.com/player.html?aid=${encodeURIComponent(aid)}&high_quality=1&autoplay=0`,
        };
      }
    }
    const bv = /^\/video\/(BV[A-Za-z0-9]{6,20})(?:\/|$)/.exec(path);
    if (bv) {
      return {
        provider: "bilibili",
        label: "Bilibili",
        embedSrc: `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bv[1])}&high_quality=1&autoplay=0`,
      };
    }
    const av = /^\/video\/av([1-9]\d{0,15})(?:\/|$)/i.exec(path);
    if (av) {
      return {
        provider: "bilibili",
        label: "Bilibili",
        embedSrc: `https://player.bilibili.com/player.html?aid=${encodeURIComponent(av[1])}&high_quality=1&autoplay=0`,
      };
    }
  }

  // Vimeo
  if (host === "vimeo.com" || host === "www.vimeo.com" || host === "player.vimeo.com") {
    const m = /^\/(?:video\/)?([1-9]\d{3,15})(?:\/|$)/.exec(path);
    if (m) {
      return {
        provider: "vimeo",
        label: "Vimeo",
        embedSrc: `https://player.vimeo.com/video/${m[1]}`,
      };
    }
  }

  return null;
}

// ============================================================================
// 1. Audio Block
// ============================================================================

export function AudioBlockView({
  url,
  fileId,
  name,
  title,
  publicToken,
  versionSeq,
  readOnly = false,
  disableFileDownloads = false,
  onUpdate,
  onUpload,
  onDelete,
}: {
  url?: string;
  fileId?: string;
  name?: string;
  title?: string;
  publicToken?: string;
  versionSeq?: number;
  readOnly?: boolean;
  disableFileDownloads?: boolean;
  onUpdate?: (patch: Record<string, string>) => void;
  onUpload?: MediaUploadFn;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const fileSrc = resolveMediaFileUrl(fileId, publicToken, versionSeq);
  const urlSrc = safeMediaUrl(url);
  const src = fileSrc || urlSrc;

  const [editing, setEditing] = useState(!src && !readOnly);
  const [failed, setFailed] = useState(false);
  const [urlDraft, setUrlDraft] = useState(url ?? "");
  const [titleDraft, setTitleDraft] = useState(title ?? name ?? "");
  const [error, setError] = useState("");
  const [uploadingPct, setUploadingPct] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (src && !urlDraft && url) setUrlDraft(url);
  }, [src, url, urlDraft]);

  const canEdit = !readOnly && !!onUpdate;
  const displayTitle = title || name || t("音频");

  const handleSaveUrl = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onUpdate) return;
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      setError(t("请输入有效的音频链接"));
      return;
    }
    const safe = safeMediaUrl(trimmed);
    if (!safe) {
      setError(t("仅支持 https://、http:// 或 /api/files/ 音频链接"));
      return;
    }
    setError("");
    const inferredName = trimmed.split("/").pop()?.split("?")[0] || "";
    onUpdate({
      url: safe,
      fileId: "",
      name: inferredName || name || "",
      title: titleDraft.trim() || inferredName || t("音频"),
    });
    setEditing(false);
  };

  const handleFileChange = async (file: File | undefined) => {
    if (!file || !onUpload || !onUpdate) return;
    setError("");
    setUploadingPct(0);
    try {
      const uploaded = await onUpload(file, (pct) => setUploadingPct(pct));
      onUpdate({
        fileId: String(uploaded.id),
        url: "",
        name: uploaded.name,
        title: titleDraft.trim() || uploaded.name,
      });
      setTitleDraft(titleDraft.trim() || uploaded.name);
      setUrlDraft("");
      setEditing(false);
    } catch {
      setError(t("上传失败，请重试。"));
    } finally {
      setUploadingPct(null);
    }
  };

  return (
    <div
      contentEditable={false}
      data-audio-block
      className="my-2 w-full max-w-[640px] overflow-hidden rounded-lg border border-[#DEE0E3] bg-surface shadow-[0_1px_2px_rgba(31,35,41,0.04)] dark:border-border"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-indigo-50/40 px-3.5 py-2 dark:bg-indigo-950/20">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-indigo-100 text-indigo-600 dark:bg-indigo-950/70 dark:text-indigo-300">
            <Volume2 size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground" data-audio-title>
              {displayTitle}
            </div>
            {name && title && name !== title && (
              <div className="truncate text-[11px] text-subtle">{name}</div>
            )}
          </div>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setUrlDraft(url ?? "");
                setTitleDraft(title ?? name ?? "");
                setError("");
                setEditing((v) => !v);
              }}
              data-audio-edit-btn
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <Edit3 size={11} />
              {editing ? t("收起") : t("编辑")}
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                aria-label={t("删除音频块")}
                className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="p-3">
        {src && !failed ? (
          <audio
            src={src}
            controls
            controlsList={disableFileDownloads ? "nodownload" : undefined}
            onContextMenu={(e) => {
              if (disableFileDownloads) e.preventDefault();
            }}
            onError={() => setFailed(true)}
            className="h-10 w-full"
            data-audio-player
          />
        ) : failed ? (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground" role="status">
            {t("音频无法播放，请检查链接或重新上传")}
          </div>
        ) : !canEdit ? (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground" role="status">
            {t("暂无音频来源")}
          </div>
        ) : null}

        {canEdit && (editing || !src) && (
          <div className={cn("space-y-2 text-[12px]", src && "mt-3 border-t border-border/60 pt-3")} data-audio-editor>
            <form onSubmit={handleSaveUrl} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  placeholder={t("音频标题（可选）")}
                  data-audio-title-input
                  className="h-8 min-w-[140px] flex-1 rounded-md border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary"
                />
                <input
                  type="text"
                  value={urlDraft}
                  onChange={(e) => {
                    setUrlDraft(e.target.value);
                    if (error) setError("");
                  }}
                  placeholder={t("粘贴音频链接（https:// 或 /api/files/…）")}
                  data-audio-url-input
                  className="h-8 min-w-[200px] flex-[2] rounded-md border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {onUpload && (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="audio/*"
                        hidden
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          void handleFileChange(file);
                        }}
                      />
                      <button
                        type="button"
                        disabled={uploadingPct !== null}
                        onClick={() => fileInputRef.current?.click()}
                        data-audio-upload-btn
                        className="inline-flex h-7 items-center gap-1 rounded-md border bg-surface px-2.5 text-[12px] font-medium text-foreground hover:bg-hover disabled:opacity-50"
                      >
                        <Upload size={12} />
                        {uploadingPct !== null ? `${t("上传中")} ${Math.round(uploadingPct)}%` : t("上传音频")}
                      </button>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {src && (
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="h-7 rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-hover"
                    >
                      {t("取消")}
                    </button>
                  )}
                  <button
                    type="submit"
                    data-audio-save-btn
                    className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-white hover:bg-primary/90"
                  >
                    <Link2 size={12} />
                    {t("应用链接")}
                  </button>
                </div>
              </div>
            </form>
            {error && <p className="text-[12px] text-destructive" role="alert">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 2. Upgraded Video Block (HTML5 direct playback + upload + YouTube/Bilibili/Vimeo embeds)
// ============================================================================

export function VideoBlockView({
  url,
  fileId,
  name,
  title,
  publicToken,
  versionSeq,
  readOnly = false,
  disableFileDownloads = false,
  onUpdate,
  onUpload,
  onDelete,
}: {
  url?: string;
  fileId?: string;
  name?: string;
  title?: string;
  publicToken?: string;
  versionSeq?: number;
  readOnly?: boolean;
  disableFileDownloads?: boolean;
  onUpdate?: (patch: Record<string, string>) => void;
  onUpload?: MediaUploadFn;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const fileSrc = resolveMediaFileUrl(fileId, publicToken, versionSeq);
  const mediaUrl = safeMediaUrl(url);
  const href = safeURL(url);
  const [failed, setFailed] = useState(false);

  const nativeSrc = !failed ? (fileSrc || (isDirectVideoUrl(mediaUrl) ? mediaUrl : undefined)) : undefined;
  const embed = !nativeSrc ? videoEmbedUrl(url) : null;
  const hasAnySource = !!(fileSrc || href);

  const [editing, setEditing] = useState(!hasAnySource && !readOnly);
  const [urlDraft, setUrlDraft] = useState(url ?? "");
  const [titleDraft, setTitleDraft] = useState(title ?? name ?? "");
  const [error, setError] = useState("");
  const [uploadingPct, setUploadingPct] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setFailed(false);
  }, [fileSrc, mediaUrl]);

  const canEdit = !readOnly && !!onUpdate;
  const displayTitle = title || name || (!disableFileDownloads && url) || t("视频链接");

  const handleSaveUrl = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onUpdate) return;
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      setError(t("请输入有效的视频链接"));
      return;
    }
    const safe = safeMediaUrl(trimmed) ?? safeURL(trimmed);
    if (!safe || (!/^https?:\/\//i.test(safe) && !INTERNAL_FILE_URL.test(safe))) {
      setError(t("仅支持 https://、http:// 或 /api/files/ 视频链接"));
      return;
    }
    setError("");
    const inferredName = trimmed.split("/").pop()?.split("?")[0] || "";
    onUpdate({
      url: safe,
      fileId: "",
      name: inferredName || name || "",
      title: titleDraft.trim() || inferredName || "",
    });
    setEditing(false);
  };

  const handleFileChange = async (file: File | undefined) => {
    if (!file || !onUpload || !onUpdate) return;
    setError("");
    setUploadingPct(0);
    try {
      const uploaded = await onUpload(file, (pct) => setUploadingPct(pct));
      onUpdate({
        fileId: String(uploaded.id),
        url: "",
        name: uploaded.name,
        title: titleDraft.trim() || uploaded.name,
      });
      setTitleDraft(titleDraft.trim() || uploaded.name);
      setUrlDraft("");
      setEditing(false);
    } catch {
      setError(t("上传失败，请重试。"));
    } finally {
      setUploadingPct(null);
    }
  };

  const fallbackContent = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#E1EAFF] text-primary">
        <Play size={14} strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-foreground">{displayTitle}</span>
        <span className="block truncate text-[12px] text-subtle">
          {disableFileDownloads ? "当前不提供外部链接" : url || t("视频链接不可用")}
        </span>
      </span>
    </>
  );

  return (
    <div
      contentEditable={false}
      className="my-2 w-full max-w-[640px] overflow-hidden rounded-lg border border-[#DEE0E3] bg-surface dark:border-border"
      data-video
    >
      {(nativeSrc || (embed && !disableFileDownloads)) && (title || name || canEdit) && (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-sidebar/40 px-3 py-1.5 text-[12px]">
          <div className="flex min-w-0 items-center gap-2">
            <Play size={13} className="shrink-0 text-primary" />
            {embed && (
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {embed.label}
              </span>
            )}
            <span className="truncate font-medium text-foreground">{title || name || t("视频")}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {embed && href && !disableFileDownloads && (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-primary hover:bg-primary/10"
              >
                <ExternalLink size={11} />
                {t("原链接")}
              </a>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  setUrlDraft(url ?? "");
                  setTitleDraft(title ?? name ?? "");
                  setError("");
                  setEditing((v) => !v);
                }}
                data-video-edit-btn
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                <Edit3 size={11} />
                {editing ? t("收起") : t("编辑")}
              </button>
            )}
            {canEdit && onDelete && (
              <button
                type="button"
                onClick={onDelete}
                aria-label={t("删除视频块")}
                className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {nativeSrc ? (
        <video
          src={nativeSrc}
          controls
          controlsList={disableFileDownloads ? "nodownload" : undefined}
          onContextMenu={(event) => {
            if (disableFileDownloads) event.preventDefault();
          }}
          className="aspect-video w-full bg-black"
          onError={() => setFailed(true)}
          data-video-player
        />
      ) : embed && !disableFileDownloads ? (
        <iframe
          src={embed.embedSrc}
          title={title || name || embed.label}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          referrerPolicy="no-referrer"
          allowFullScreen
          className="aspect-video w-full border-0 bg-black"
          data-video-embed={embed.provider}
        />
      ) : href && !disableFileDownloads ? (
        <div className="flex items-center justify-between gap-2">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 no-underline hover:bg-hover"
          >
            {fallbackContent}
          </a>
          {canEdit && (
            <div className="flex shrink-0 items-center gap-1 pr-2">
              <button
                type="button"
                onClick={() => {
                  setUrlDraft(url ?? "");
                  setTitleDraft(title ?? name ?? "");
                  setError("");
                  setEditing((v) => !v);
                }}
                data-video-edit-btn
                className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                {t("编辑")}
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label={t("删除视频块")}
                  className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}
        </div>
      ) : href ? (
        <div className="flex items-center gap-3 px-3.5 py-3 text-subtle">{fallbackContent}</div>
      ) : !canEdit ? (
        <div className="px-3.5 py-3 text-[13px] text-subtle">视频链接不可用</div>
      ) : null}

      {canEdit && (editing || !hasAnySource) && (
        <div className={cn("space-y-2 p-3 text-[12px]", hasAnySource && "border-t border-border/60")} data-video-editor>
          <form onSubmit={handleSaveUrl} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder={t("视频标题（可选）")}
                data-video-title-input
                className="h-8 min-w-[140px] flex-1 rounded-md border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary"
              />
              <input
                type="text"
                value={urlDraft}
                onChange={(e) => {
                  setUrlDraft(e.target.value);
                  if (error) setError("");
                }}
                placeholder={t("粘贴 mp4/webm/YouTube/Bilibili/Vimeo 链接")}
                data-video-url-input
                className="h-8 min-w-[220px] flex-[2] rounded-md border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {onUpload && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/*"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        void handleFileChange(file);
                      }}
                    />
                    <button
                      type="button"
                      disabled={uploadingPct !== null}
                      onClick={() => fileInputRef.current?.click()}
                      data-video-upload-btn
                      className="inline-flex h-7 items-center gap-1 rounded-md border bg-surface px-2.5 text-[12px] font-medium text-foreground hover:bg-hover disabled:opacity-50"
                    >
                      <Upload size={12} />
                      {uploadingPct !== null ? `${t("上传中")} ${Math.round(uploadingPct)}%` : t("上传视频")}
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {hasAnySource && (
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="h-7 rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-hover"
                  >
                    {t("取消")}
                  </button>
                )}
                <button
                  type="submit"
                  data-video-save-btn
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-white hover:bg-primary/90"
                >
                  <Play size={11} />
                  {t("保存视频")}
                </button>
              </div>
            </div>
          </form>
          {error && <p className="text-[12px] text-destructive" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 3. Poll Block (CRDT LWW per-user vote.<userId> registers)
// ============================================================================

export interface PollOption {
  id: string;
  text: string;
}

export const DEFAULT_POLL_OPTIONS: PollOption[] = [
  { id: "opt-1", text: "选项 1" },
  { id: "opt-2", text: "选项 2" },
];

export function parsePollOptions(raw?: string): PollOption[] {
  if (!raw) return DEFAULT_POLL_OPTIONS.map((o) => ({ ...o }));
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const seen = new Set<string>();
      const out: PollOption[] = [];
      for (let i = 0; i < parsed.length && out.length < 30; i++) {
        const item = parsed[i];
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(rec.id) ? rec.id : `opt-${i + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const text = typeof rec.text === "string" ? rec.text : "";
        out.push({ id, text });
      }
      if (out.length > 0) return out;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_POLL_OPTIONS.map((o) => ({ ...o }));
}

const VOTE_KEY_RE = /^vote\.([A-Za-z0-9_-]{1,64})$/;

/** Aggregate per-user CRDT vote registers (`vote.<userId>`) without cross-user overwrites. */
export function parsePollVotes(
  props: Record<string, string>,
  validOptionIds: ReadonlySet<string>,
): { counts: Map<string, number>; voterCount: number; byUser: Map<string, string[]> } {
  const counts = new Map<string, number>();
  for (const id of validOptionIds) counts.set(id, 0);
  const byUser = new Map<string, string[]>();
  let voterCount = 0;

  for (const [key, raw] of Object.entries(props)) {
    const m = VOTE_KEY_RE.exec(key);
    if (!m || !raw) continue;
    const userId = m[1];
    const picked = [...new Set(raw.split(",").map((s) => s.trim()).filter((id) => validOptionIds.has(id)))];
    if (!picked.length) continue;
    byUser.set(userId, picked);
    voterCount += 1;
    for (const id of picked) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { counts, voterCount, byUser };
}

/** Compute next selection for a voter toggling `optionId`. */
export function togglePollVote(current: readonly string[], optionId: string, multiple: boolean): string[] {
  const has = current.includes(optionId);
  if (multiple) {
    return has ? current.filter((id) => id !== optionId) : [...current, optionId];
  }
  return has ? [] : [optionId];
}

export function PollBlockView({
  props,
  voterId,
  readOnly = false,
  onSetProp,
  onSetProps,
  onDelete,
}: {
  props: Record<string, string>;
  voterId?: string;
  readOnly?: boolean;
  onSetProp?: (key: string, value: string) => void;
  onSetProps?: (patch: Record<string, string>) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const options = useMemo(() => parsePollOptions(props.options), [props.options]);
  const optionIdSet = useMemo(() => new Set(options.map((o) => o.id)), [options]);
  const multiple = props.multiple === "true";
  const question = props.question || t("发起投票");

  const { counts, voterCount, byUser } = useMemo(
    () => parsePollVotes(props, optionIdSet),
    [props, optionIdSet],
  );
  const totalSelections = useMemo(() => {
    let sum = 0;
    for (const n of counts.values()) sum += n;
    return sum;
  }, [counts]);

  const sanitizedVoter = voterId && /^[A-Za-z0-9_-]{1,64}$/.test(voterId) ? voterId : "guest";
  const myVotes = byUser.get(sanitizedVoter) ?? [];
  const canEdit = !readOnly && !!onSetProp;

  const [editing, setEditing] = useState(false);
  const [questionDraft, setQuestionDraft] = useState(props.question ?? "");
  const [lastQuestion, setLastQuestion] = useState(props.question ?? "");
  if ((props.question ?? "") !== lastQuestion) {
    setLastQuestion(props.question ?? "");
    setQuestionDraft(props.question ?? "");
  }

  const handleVote = (optionId: string) => {
    if (!canEdit || !onSetProp) return;
    const next = togglePollVote(myVotes, optionId, multiple);
    onSetProp(`vote.${sanitizedVoter}`, next.join(","));
  };

  const commitOptions = (next: PollOption[]) => {
    onSetProp?.("options", JSON.stringify(next));
  };

  const handleAddOption = () => {
    if (!canEdit) return;
    const id = `opt-${Date.now().toString(36).slice(-4)}-${options.length + 1}`;
    commitOptions([...options, { id, text: `${t("选项")} ${options.length + 1}` }]);
  };

  const handleRemoveOption = (optId: string) => {
    if (!canEdit || options.length <= 1) return;
    commitOptions(options.filter((o) => o.id !== optId));
  };

  const handleToggleMultiple = () => {
    if (!canEdit) return;
    const nextMulti = !multiple;
    if (onSetProps) {
      onSetProps({ multiple: nextMulti ? "true" : "false" });
    } else {
      onSetProp?.("multiple", nextMulti ? "true" : "false");
    }
  };

  return (
    <div
      contentEditable={false}
      data-poll-block
      data-poll-multiple={multiple ? "true" : "false"}
      className="my-2.5 w-full max-w-[640px] overflow-hidden rounded-lg border border-[#DEE0E3] bg-surface shadow-[0_1px_2px_rgba(31,35,41,0.04)] dark:border-border"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-blue-50/40 px-4 py-2.5 dark:bg-blue-950/20">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-blue-100 text-primary dark:bg-blue-950/70">
            <BarChart3 size={15} />
          </span>
          {canEdit && editing ? (
            <input
              type="text"
              value={questionDraft}
              onChange={(e) => setQuestionDraft(e.target.value)}
              onBlur={() => {
                const trimmed = questionDraft.trim();
                if (trimmed !== (props.question ?? "")) onSetProp?.("question", trimmed || t("发起投票"));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder={t("输入投票主题…")}
              data-poll-question-input
              className="h-7 min-w-[160px] flex-1 rounded border bg-surface px-2 text-[14px] font-medium text-foreground outline-none focus:border-primary"
            />
          ) : (
            <span className="truncate text-[14px] font-semibold text-foreground" data-poll-question>
              {question}
            </span>
          )}
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {multiple ? t("多选") : t("单选")}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[12px] text-muted-foreground" data-poll-voter-count>
            {t("{n} 人已投票", { n: voterCount })}
          </span>
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                data-poll-edit-toggle
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors",
                  editing ? "bg-primary text-white" : "text-muted-foreground hover:bg-hover hover:text-foreground",
                )}
              >
                <Edit3 size={11} />
                {editing ? t("完成") : t("编辑选项")}
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label={t("删除投票")}
                  className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="space-y-2 p-3.5">
        {canEdit && editing ? (
          <div className="space-y-2" data-poll-editor>
            {options.map((opt, idx) => (
              <div key={opt.id} className="flex items-center gap-2">
                <span className="w-5 text-center text-[12px] text-subtle">{idx + 1}.</span>
                <input
                  type="text"
                  value={opt.text}
                  onChange={(e) => {
                    const nextText = e.target.value;
                    commitOptions(options.map((o) => (o.id === opt.id ? { ...o, text: nextText } : o)));
                  }}
                  placeholder={t("输入选项内容")}
                  data-poll-option-input={opt.id}
                  className="h-8 flex-1 rounded-md border bg-surface px-2.5 text-[13px] text-foreground outline-none focus:border-primary"
                />
                {options.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveOption(opt.id)}
                    aria-label={t("删除选项")}
                    data-poll-remove-option={opt.id}
                    className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={handleAddOption}
                data-poll-add-option
                className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-primary/50 px-2.5 text-[12px] font-medium text-primary hover:bg-primary/5"
              >
                <Plus size={12} />
                {t("添加选项")}
              </button>
              <button
                type="button"
                onClick={handleToggleMultiple}
                aria-pressed={multiple}
                data-poll-multiple-toggle
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors",
                  multiple
                    ? "border-primary/40 bg-primary/10 font-medium text-primary"
                    : "border-border bg-surface text-muted-foreground hover:bg-hover",
                )}
              >
                <Check size={12} className={multiple ? "opacity-100" : "opacity-30"} />
                {t("允许多选")}
              </button>
            </div>
          </div>
        ) : (
          options.map((opt) => {
            const count = counts.get(opt.id) ?? 0;
            const denom = multiple ? Math.max(voterCount, 1) : Math.max(totalSelections, 1);
            const pct = voterCount > 0 ? Math.round((count / denom) * 100) : 0;
            const selected = myVotes.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                disabled={!canEdit}
                onClick={() => handleVote(opt.id)}
                aria-pressed={selected}
                data-poll-option={opt.id}
                data-poll-selected={selected ? "true" : "false"}
                className={cn(
                  "relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-md border px-3 py-2 text-left text-[13px] transition-colors",
                  selected
                    ? "border-primary/60 bg-primary/[0.04]"
                    : "border-border/80 bg-background hover:border-primary/40 hover:bg-hover/50",
                  !canEdit && "cursor-default hover:border-border/80 hover:bg-background",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-300",
                    selected ? "bg-primary/15" : "bg-muted/70",
                  )}
                  style={{ width: `${pct}%` }}
                />
                <span className="relative z-10 flex min-w-0 items-center gap-2.5">
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center border transition-colors",
                      multiple ? "rounded-[4px]" : "rounded-full",
                      selected
                        ? "border-primary bg-primary text-white"
                        : "border-[#BBBFC4] bg-surface",
                    )}
                  >
                    {selected && <Check size={10} strokeWidth={3} />}
                  </span>
                  <span className="truncate font-medium text-foreground">{opt.text || t("未命名选项")}</span>
                </span>
                <span className="relative z-10 shrink-0 tabular-nums text-[12px] text-muted-foreground" data-poll-stat={opt.id}>
                  {t("{n} 票", { n: count })} · {pct}%
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 4. Countdown Block
// ============================================================================

export type CountdownTheme = "blue" | "orange" | "green" | "purple";

export const COUNTDOWN_THEMES: Record<
  CountdownTheme,
  { label: string; card: string; accent: string; tile: string; dot: string }
> = {
  blue: {
    label: "蓝色",
    card: "border-blue-200/90 bg-gradient-to-r from-blue-50/70 to-indigo-50/40 dark:border-blue-900/70 dark:from-blue-950/30 dark:to-indigo-950/20",
    accent: "text-blue-600 dark:text-blue-300",
    tile: "border-blue-200/80 bg-surface text-blue-700 dark:border-blue-800/70 dark:text-blue-200",
    dot: "#3370FF",
  },
  orange: {
    label: "橙色",
    card: "border-amber-200/90 bg-gradient-to-r from-amber-50/70 to-orange-50/40 dark:border-amber-900/70 dark:from-amber-950/30 dark:to-orange-950/20",
    accent: "text-orange-600 dark:text-orange-300",
    tile: "border-amber-200/80 bg-surface text-orange-700 dark:border-amber-800/70 dark:text-orange-200",
    dot: "#FF8800",
  },
  green: {
    label: "绿色",
    card: "border-emerald-200/90 bg-gradient-to-r from-emerald-50/70 to-teal-50/40 dark:border-emerald-900/70 dark:from-emerald-950/30 dark:to-teal-950/20",
    accent: "text-emerald-600 dark:text-emerald-300",
    tile: "border-emerald-200/80 bg-surface text-emerald-700 dark:border-emerald-800/70 dark:text-emerald-200",
    dot: "#00B42A",
  },
  purple: {
    label: "紫色",
    card: "border-violet-200/90 bg-gradient-to-r from-violet-50/70 to-purple-50/40 dark:border-violet-900/70 dark:from-violet-950/30 dark:to-purple-950/20",
    accent: "text-violet-600 dark:text-violet-300",
    tile: "border-violet-200/80 bg-surface text-violet-700 dark:border-violet-800/70 dark:text-violet-200",
    dot: "#7F3BF5",
  },
};

export function normalizeCountdownTheme(raw?: string): CountdownTheme {
  return raw === "orange" || raw === "green" || raw === "purple" ? raw : "blue";
}

/** Default countdown target: 7 days ahead, rounded to the current minute. */
export function defaultCountdownTarget(now = new Date()): string {
  const future = new Date(now.getTime() + 7 * 86400 * 1000);
  future.setSeconds(0, 0);
  return future.toISOString();
}

export interface CountdownParts {
  valid: boolean;
  expired: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Pure remaining-time breakdown for a target ISO date-time string. */
export function computeCountdown(targetAt?: string, nowMs = Date.now()): CountdownParts {
  if (!targetAt) return { valid: false, expired: false, days: 0, hours: 0, minutes: 0, seconds: 0 };
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) return { valid: false, expired: false, days: 0, hours: 0, minutes: 0, seconds: 0 };
  const diff = targetMs - nowMs;
  if (diff <= 0) return { valid: true, expired: true, days: 0, hours: 0, minutes: 0, seconds: 0 };
  const totalSec = Math.floor(diff / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return { valid: true, expired: false, days, hours, minutes, seconds };
}

export function toDateTimeLocalValue(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDateTimeLocalValue(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "";
}

function formatTargetDisplay(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CountdownBlockView({
  title,
  targetAt,
  theme,
  readOnly = false,
  onUpdate,
  onDelete,
}: {
  title?: string;
  targetAt?: string;
  theme?: string;
  readOnly?: boolean;
  onUpdate?: (patch: Record<string, string>) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const safeTheme = normalizeCountdownTheme(theme);
  const palette = COUNTDOWN_THEMES[safeTheme];
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title ?? "");
  const [lastPropTitle, setLastPropTitle] = useState(title ?? "");
  if ((title ?? "") !== lastPropTitle) {
    setLastPropTitle(title ?? "");
    setTitleDraft(title ?? "");
  }

  const parts = computeCountdown(targetAt, nowMs);

  useEffect(() => {
    if (!parts.valid || parts.expired) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [parts.valid, parts.expired, targetAt]);

  const canEdit = !readOnly && !!onUpdate;
  const pad2 = (n: number) => String(n).padStart(2, "0");

  const applyOffsetDays = (days: number) => {
    const next = new Date(Date.now() + days * 86400 * 1000);
    next.setSeconds(0, 0);
    onUpdate?.({ targetAt: next.toISOString() });
  };

  return (
    <div
      contentEditable={false}
      data-countdown-block
      data-countdown-theme={safeTheme}
      data-countdown-expired={parts.expired ? "true" : "false"}
      className={cn("my-2.5 w-full max-w-[640px] rounded-lg border p-4 shadow-[0_1px_2px_rgba(31,35,41,0.04)]", palette.card)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Timer size={16} className={cn("shrink-0", palette.accent)} />
          <span className="truncate text-[14px] font-semibold text-foreground" data-countdown-title>
            {title || t("倒计时")}
          </span>
          {targetAt && formatTargetDisplay(targetAt) && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex" data-countdown-target-text>
              <Clock size={11} />
              {formatTargetDisplay(targetAt)}
            </span>
          )}
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              data-countdown-edit-btn
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium text-muted-foreground hover:bg-surface/80 hover:text-foreground"
            >
              <Settings2 size={11} />
              {editing ? t("收起") : t("设置")}
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                aria-label={t("删除倒计时")}
                className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-surface/80 hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mt-3">
        {!parts.valid ? (
          <div className="rounded-md border border-dashed border-border bg-surface/70 px-3 py-2 text-[12px] text-muted-foreground">
            {t("请设置目标截止时间")}
          </div>
        ) : parts.expired ? (
          <div className="inline-flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-[13px] font-semibold text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300" data-countdown-status>
            <Clock size={14} />
            {t("已到期")}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 sm:max-w-[380px]">
            {[
              { key: "days", value: String(parts.days), unit: t("天") },
              { key: "hours", value: pad2(parts.hours), unit: t("时") },
              { key: "minutes", value: pad2(parts.minutes), unit: t("分") },
              { key: "seconds", value: pad2(parts.seconds), unit: t("秒") },
            ].map((item) => (
              <div
                key={item.key}
                data-countdown-unit={item.key}
                className={cn("flex flex-col items-center justify-center rounded-md border px-2 py-2 shadow-2xs", palette.tile)}
              >
                <span className="text-[22px] font-bold leading-tight tabular-nums">{item.value}</span>
                <span className="mt-0.5 text-[11px] text-muted-foreground">{item.unit}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {canEdit && editing && (
        <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3 text-[12px]" data-countdown-editor>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const trimmed = titleDraft.trim();
                if (trimmed !== (title ?? "")) onUpdate?.({ title: trimmed || t("倒计时") });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder={t("倒计时标题")}
              data-countdown-title-input
              className="h-8 min-w-[150px] flex-1 rounded-md border bg-surface px-2.5 text-[12px] text-foreground outline-none focus:border-primary"
            />
            <input
              type="datetime-local"
              value={toDateTimeLocalValue(targetAt)}
              onChange={(e) => {
                const iso = fromDateTimeLocalValue(e.target.value);
                if (iso) onUpdate?.({ targetAt: iso });
              }}
              data-countdown-target-input
              className="h-8 rounded-md border bg-surface px-2 text-[12px] text-foreground outline-none focus:border-primary"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">{t("快捷设置")}</span>
              <button
                type="button"
                onClick={() => applyOffsetDays(1)}
                data-countdown-preset="1d"
                className="h-6 rounded border bg-surface px-2 text-[11px] hover:bg-hover"
              >
                +1 {t("天")}
              </button>
              <button
                type="button"
                onClick={() => applyOffsetDays(7)}
                data-countdown-preset="7d"
                className="h-6 rounded border bg-surface px-2 text-[11px] hover:bg-hover"
              >
                +7 {t("天")}
              </button>
              <button
                type="button"
                onClick={() => applyOffsetDays(30)}
                data-countdown-preset="30d"
                className="h-6 rounded border bg-surface px-2 text-[11px] hover:bg-hover"
              >
                +30 {t("天")}
              </button>
            </div>
            <div className="flex items-center gap-1.5" role="group" aria-label={t("主题色")}>
              {(Object.keys(COUNTDOWN_THEMES) as CountdownTheme[]).map((themeKey) => (
                <button
                  key={themeKey}
                  type="button"
                  title={COUNTDOWN_THEMES[themeKey].label}
                  aria-label={COUNTDOWN_THEMES[themeKey].label}
                  aria-pressed={safeTheme === themeKey}
                  data-countdown-theme-option={themeKey}
                  onClick={() => onUpdate?.({ theme: themeKey })}
                  style={{ backgroundColor: COUNTDOWN_THEMES[themeKey].dot }}
                  className={cn(
                    "size-4.5 rounded-full transition-transform",
                    safeTheme === themeKey && "ring-2 ring-foreground/60 ring-offset-1 scale-110",
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 5. Tabs Block
// ============================================================================

export interface TabItem {
  id: string;
  label: string;
  content: string;
}

export const DEFAULT_TABS: TabItem[] = [
  { id: "tab-1", label: "方案 A", content: "" },
  { id: "tab-2", label: "方案 B", content: "" },
];

export function parseTabsData(raw?: string): TabItem[] {
  if (!raw) return DEFAULT_TABS.map((t) => ({ ...t }));
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const seen = new Set<string>();
      const out: TabItem[] = [];
      for (let i = 0; i < parsed.length && out.length < 20; i++) {
        const item = parsed[i];
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(rec.id) ? rec.id : `tab-${i + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const label = typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : `标签页 ${i + 1}`;
        const content = typeof rec.content === "string" ? rec.content : "";
        out.push({ id, label, content });
      }
      if (out.length > 0) return out;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_TABS.map((t) => ({ ...t }));
}

function renderInlineMarkdown(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > lastIdx) parts.push(line.slice(lastIdx, match.index));
    const tok = match[0];
    if (tok.startsWith("**") && tok.endsWith("**")) {
      parts.push(<strong key={key++} className="font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      parts.push(
        <code key={key++} className="rounded bg-muted px-1 py-px font-mono text-[12px] text-[#D83931]">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    lastIdx = match.index + tok.length;
  }
  if (lastIdx < line.length) parts.push(line.slice(lastIdx));
  return parts;
}

function TabMarkdownBody({ content, emptyLabel }: { content: string; emptyLabel: string }) {
  if (!content.trim()) {
    return <p className="py-2 text-[13px] text-subtle">{emptyLabel}</p>;
  }
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  return (
    <div className="space-y-1.5 text-[14px] leading-[1.7] text-foreground">
      {lines.map((line, i) => {
        if (/^###\s+/.test(line)) {
          return <h4 key={i} className="pt-1 text-[15px] font-semibold">{renderInlineMarkdown(line.replace(/^###\s+/, ""))}</h4>;
        }
        if (/^##\s+/.test(line)) {
          return <h3 key={i} className="pt-1 text-[16px] font-semibold">{renderInlineMarkdown(line.replace(/^##\s+/, ""))}</h3>;
        }
        if (/^#\s+/.test(line)) {
          return <h2 key={i} className="pt-1 text-[17px] font-semibold">{renderInlineMarkdown(line.replace(/^#\s+/, ""))}</h2>;
        }
        if (/^[-*]\s+/.test(line)) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="text-primary">•</span>
              <span className="min-w-0 flex-1 break-words">{renderInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</span>
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-2" />;
        return <p key={i} className="whitespace-pre-wrap break-words">{renderInlineMarkdown(line)}</p>;
      })}
    </div>
  );
}

export function TabsBlockView({
  raw,
  readOnly = false,
  onChange,
  onDelete,
}: {
  raw?: string;
  readOnly?: boolean;
  onChange?: (nextJson: string) => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const tabs = useMemo(() => parseTabsData(raw), [raw]);
  const [activeId, setActiveId] = useState<string>(tabs[0]?.id ?? "tab-1");
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [previewMode, setPreviewMode] = useState(false);

  const [contentDraft, setContentDraft] = useState(activeTab?.content ?? "");
  const [syncedTabKey, setSyncedTabKey] = useState(`${activeTab?.id ?? ""}:${activeTab?.content ?? ""}`);
  const saveTimer = useRef<number | null>(null);

  const currentTabKey = `${activeTab?.id ?? ""}:${activeTab?.content ?? ""}`;
  if (currentTabKey !== syncedTabKey) {
    setSyncedTabKey(currentTabKey);
    setContentDraft(activeTab?.content ?? "");
  }

  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
  }, []);

  const canEdit = !readOnly && !!onChange;

  const commitTabs = (next: TabItem[]) => {
    onChange?.(JSON.stringify(next));
  };

  const flushContent = (targetId: string, nextContent: string) => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!canEdit) return;
    const current = tabs.find((tab) => tab.id === targetId);
    if (!current || current.content === nextContent) return;
    commitTabs(tabs.map((tab) => (tab.id === targetId ? { ...tab, content: nextContent } : tab)));
  };

  const handleSelectTab = (nextId: string) => {
    if (activeTab && nextId !== activeTab.id) {
      flushContent(activeTab.id, contentDraft);
    }
    setActiveId(nextId);
    setRenamingId(null);
  };

  const handleAddTab = () => {
    if (!canEdit) return;
    if (activeTab) flushContent(activeTab.id, contentDraft);
    const id = `tab-${Date.now().toString(36).slice(-4)}-${tabs.length + 1}`;
    const next: TabItem[] = [...tabs, { id, label: `${t("标签页")} ${tabs.length + 1}`, content: "" }];
    commitTabs(next);
    setActiveId(id);
  };

  const handleRemoveTab = (tabId: string) => {
    if (!canEdit || tabs.length <= 1) return;
    const idx = tabs.findIndex((tab) => tab.id === tabId);
    const next = tabs.filter((tab) => tab.id !== tabId);
    commitTabs(next);
    if (activeTab?.id === tabId) {
      setActiveId(next[Math.max(0, idx - 1)]?.id ?? next[0].id);
    }
  };

  const commitRename = () => {
    if (!renamingId || !canEdit) {
      setRenamingId(null);
      return;
    }
    const trimmed = renameDraft.trim();
    if (trimmed) {
      commitTabs(tabs.map((tab) => (tab.id === renamingId ? { ...tab, label: trimmed } : tab)));
    }
    setRenamingId(null);
  };

  return (
    <div
      contentEditable={false}
      data-tabs-block
      className="my-2.5 w-full overflow-hidden rounded-lg border border-[#DEE0E3] bg-surface shadow-[0_1px_2px_rgba(31,35,41,0.04)] dark:border-border"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-sidebar/40 px-2.5 pt-1.5">
        <div role="tablist" aria-label={t("标签页")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <span className="mr-1 grid size-6 shrink-0 place-items-center text-muted-foreground" aria-hidden>
            <PanelsTopLeft size={14} />
          </span>
          {tabs.map((tab) => {
            const isActive = activeTab?.id === tab.id;
            const isRenaming = renamingId === tab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group/tab relative flex shrink-0 items-center border-b-2 transition-colors",
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    type="text"
                    value={renameDraft}
                    maxLength={40}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                    data-tab-rename-input
                    className="my-1 h-6 w-28 rounded border border-primary bg-surface px-1.5 text-[12px] text-foreground outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    data-tab-id={tab.id}
                    onClick={() => handleSelectTab(tab.id)}
                    onDoubleClick={() => {
                      if (!canEdit) return;
                      setRenamingId(tab.id);
                      setRenameDraft(tab.label);
                    }}
                    className={cn(
                      "px-2.5 py-1.5 text-[13px] transition-colors",
                      isActive ? "font-medium" : "font-normal",
                    )}
                  >
                    {tab.label}
                  </button>
                )}
                {canEdit && !isRenaming && isActive && (
                  <button
                    type="button"
                    title={t("重命名标签页")}
                    aria-label={t("重命名标签页")}
                    data-tab-rename-btn={tab.id}
                    onClick={() => {
                      setRenamingId(tab.id);
                      setRenameDraft(tab.label);
                    }}
                    className="mr-0.5 grid size-5 place-items-center rounded text-muted-foreground opacity-70 hover:bg-hover hover:text-foreground hover:opacity-100"
                  >
                    <Edit3 size={10} />
                  </button>
                )}
                {canEdit && !isRenaming && tabs.length > 1 && (
                  <button
                    type="button"
                    title={t("删除标签页")}
                    aria-label={t("删除标签页")}
                    data-tab-remove={tab.id}
                    onClick={() => handleRemoveTab(tab.id)}
                    className="mr-1 grid size-4.5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-hover hover:text-destructive group-hover/tab:opacity-100 focus-visible:opacity-100"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            );
          })}
          {canEdit && (
            <button
              type="button"
              onClick={handleAddTab}
              title={t("添加标签页")}
              aria-label={t("添加标签页")}
              data-tabs-add
              className="mb-1 ml-0.5 grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-primary"
            >
              <Plus size={13} />
            </button>
          )}
        </div>

        {canEdit && (
          <div className="mb-1 flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                if (activeTab && !previewMode) flushContent(activeTab.id, contentDraft);
                setPreviewMode((v) => !v);
              }}
              data-tabs-preview-toggle
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              {previewMode ? <Edit3 size={11} /> : <Eye size={11} />}
              {previewMode ? t("编辑") : t("预览")}
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                aria-label={t("删除标签页块")}
                className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-destructive"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {activeTab && (
        <div role="tabpanel" data-tab-panel={activeTab.id} className="p-3.5">
          {canEdit && !previewMode ? (
            <textarea
              rows={4}
              value={contentDraft}
              onChange={(e) => {
                const next = e.target.value;
                setContentDraft(next);
                if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
                const targetId = activeTab.id;
                saveTimer.current = window.setTimeout(() => flushContent(targetId, next), 250);
              }}
              onBlur={() => flushContent(activeTab.id, contentDraft)}
              placeholder={t("输入当前标签页内容，支持 Markdown 标题、列表、**加粗** 与 `代码`…")}
              data-tab-content-input
              className="w-full resize-y rounded-md border border-transparent bg-transparent p-1.5 text-[14px] leading-[1.7] text-foreground outline-none transition-colors hover:border-border/70 focus:border-primary/50 focus:bg-background"
            />
          ) : (
            <TabMarkdownBody content={activeTab.content} emptyLabel={t("该标签页暂无内容")} />
          )}
        </div>
      )}
    </div>
  );
}
