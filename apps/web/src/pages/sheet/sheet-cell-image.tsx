import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isSafeSheetImageUrl } from "@zseven-w/sheet-sdk/formula-functions";
import { ExternalLink, Image as ImageIcon, Upload, X } from "lucide-react";
import { FeishuSelect } from "@/components/feishu-select";
import { ApiError, driveApi } from "@/lib/api";
import { t } from "@/lib/i18n";

function escapeFormulaString(value: string): string {
  return value.replace(/"/g, '""');
}

/** Construct a valid `=IMAGE(...)` formula string from validated inputs. */
export function buildImageFormula(url: string, altText = "", mode = 1): string {
  const safeUrl = escapeFormulaString(url.trim());
  const cleanAlt = altText.trim();
  if (!cleanAlt && mode === 1) {
    return `=IMAGE("${safeUrl}")`;
  }
  if (mode === 1) {
    return `=IMAGE("${safeUrl}", "${escapeFormulaString(cleanAlt)}")`;
  }
  return `=IMAGE("${safeUrl}", "${escapeFormulaString(cleanAlt)}", ${mode})`;
}

export interface SheetCellImagePopoverProps {
  userId: number;
  targetAddress: string;
  initialUrl?: string;
  initialAlt?: string;
  initialMode?: number;
  anchorRect: { left: number; bottom: number; top: number; right: number };
  onInsertFormula: (formula: string) => Promise<void> | void;
  onClose: () => void;
}

export function SheetCellImagePopover({
  userId,
  targetAddress,
  initialUrl = "",
  initialAlt = "",
  initialMode = 1,
  anchorRect,
  onInsertFormula,
  onClose,
}: SheetCellImagePopoverProps) {
  const [url, setUrl] = useState(initialUrl);
  const [altText, setAltText] = useState(initialAlt);
  const [mode, setMode] = useState<string>(String(initialMode || 1));
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[role="listbox"]')) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const trimmedUrl = url.trim();
  const validPreview = trimmedUrl.length > 0 && isSafeSheetImageUrl(trimmedUrl);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const popW = Math.min(324, vw - 16);
  const left = Math.max(8, Math.min(anchorRect.left, vw - popW - 8));
  const top = anchorRect.bottom + 6 + 340 <= vh ? anchorRect.bottom + 6 : Math.max(8, vh - 350);

  const handleInsert = async () => {
    if (!trimmedUrl) {
      setError(t("请输入图片链接或上传本地图片"));
      return;
    }
    if (!isSafeSheetImageUrl(trimmedUrl)) {
      setError(t("仅支持 https://、http://、/api/files/ 或 data:image/ 安全图片地址"));
      return;
    }
    setError("");
    await onInsertFormula(buildImageFormula(trimmedUrl, altText, Number(mode) || 1));
    onClose();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(t("请选择有效的图片文件"));
      return;
    }
    setError("");
    setUploading(true);
    try {
      let entry;
      try {
        entry = await driveApi.uploadFile(file, null, false, undefined, userId);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          entry = await driveApi.uploadFile(file, null, true, undefined, userId);
        } else {
          throw err;
        }
      }
      const meta = await driveApi.file(entry.id);
      const uploadedUrl = `/api/files/${meta.id}`;
      const nextAlt = altText.trim() || file.name.replace(/\.[^.]+$/, "");
      setUrl(uploadedUrl);
      setAltText(nextAlt);
      await onInsertFormula(buildImageFormula(uploadedUrl, nextAlt, Number(mode) || 1));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("上传图片失败"));
    } finally {
      setUploading(false);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("插入单元格图片")}
      data-sheet-cell-image-popover
      style={{ left, top, width: popW }}
      className="fixed z-[125] rounded-lg border border-[#dee0e3] bg-white p-3 text-[12px] text-[#1f2329] shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
    >
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <ImageIcon size={14} className="text-[#3370ff]" />
          <span className="text-[13px] font-semibold">{t("插入单元格图片")}</span>
          <span className="rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[10.5px] font-medium text-[#646a73]">
            {targetAddress}
          </span>
        </div>
        <button
          type="button"
          aria-label={t("关闭")}
          onClick={onClose}
          className="grid size-6 place-items-center rounded text-[#8f959e] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-2.5">
        <div>
          <label className="mb-1 block text-[#646a73]">{t("图片地址")}</label>
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError("");
            }}
            placeholder="https://example.com/image.png"
            data-sheet-cell-image-url-input
            className="h-7 w-full rounded border border-[#dee0e3] px-2 text-[12px] outline-none focus:border-[#3370ff]"
          />
        </div>

        <div>
          <label className="mb-1 block text-[#646a73]">{t("替代文本（可选）")}</label>
          <input
            type="text"
            value={altText}
            onChange={(e) => setAltText(e.target.value)}
            placeholder={t("图片描述")}
            data-sheet-cell-image-alt-input
            className="h-7 w-full rounded border border-[#dee0e3] px-2 text-[12px] outline-none focus:border-[#3370ff]"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <label className="shrink-0 text-[#646a73]">{t("缩放模式")}</label>
          <FeishuSelect
            value={mode}
            onChange={setMode}
            ariaLabel={t("缩放模式")}
            className="h-7 w-[176px] border border-[#dee0e3] bg-white text-[12px]"
            options={[
              { value: "1", label: t("适应单元格") },
              { value: "2", label: t("拉伸填充") },
              { value: "3", label: t("原始尺寸") },
            ]}
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={(e) => void handleFileChange(e)}
            className="hidden"
            data-sheet-cell-image-file-input
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded border border-dashed border-[#c9cdd4] bg-[#fafbfc] text-[12px] text-[#4b5058] hover:border-[#3370ff] hover:text-[#3370ff] disabled:opacity-50"
          >
            <Upload size={13} />
            <span>{uploading ? t("上传中...") : t("上传本地图片")}</span>
          </button>
        </div>

        {validPreview && (
          <div className="flex h-20 items-center justify-center overflow-hidden rounded border border-[#eff0f1] bg-[#fafbfc] p-1">
            <img
              src={trimmedUrl}
              alt={altText || t("图片预览")}
              className="max-h-full max-w-full rounded object-contain"
            />
          </div>
        )}

        {error && <p className="text-[11px] text-[#d83931]">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="h-7 rounded border border-[#dee0e3] px-3 text-[12px] text-[#4b5058] hover:bg-[#f2f3f5]"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            disabled={uploading}
            data-sheet-cell-image-submit
            onClick={() => void handleInsert()}
            className="h-7 rounded bg-[#3370ff] px-3 text-[12px] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
          >
            {t("插入公式")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export interface SheetCellImagePreviewModalProps {
  url: string;
  alt?: string;
  address: string;
  canEdit: boolean;
  onEditFormula: () => void;
  onClose: () => void;
}

export function SheetCellImagePreviewModal({
  url,
  alt,
  address,
  canEdit,
  onEditFormula,
  onClose,
}: SheetCellImagePreviewModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined" || !isSafeSheetImageUrl(url)) return null;
  const isExternalHttp = /^https?:\/\//i.test(url);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("预览单元格图片")}
      data-sheet-cell-image-modal
      onClick={onClose}
      className="fixed inset-0 z-[150] flex items-center justify-center bg-[#1f2329]/60 p-6 backdrop-blur-[1px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] max-w-[85vw] flex-col overflow-hidden rounded-xl border border-[#dee0e3] bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-[#eff0f1] px-4 py-2.5 text-[13px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded bg-[#eef3ff] px-1.5 py-0.5 text-[11px] font-medium text-[#3370ff]">
              {address}
            </span>
            <span className="truncate font-medium text-[#1f2329]">{alt || t("图片预览")}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onEditFormula();
                }}
                className="h-7 rounded border border-[#dee0e3] px-2.5 text-[12px] text-[#4b5058] hover:bg-[#f2f3f5]"
              >
                {t("编辑公式")}
              </button>
            )}
            {isExternalHttp && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title={t("新窗口打开")}
                className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
              >
                <ExternalLink size={14} />
              </a>
            )}
            <button
              type="button"
              aria-label={t("关闭")}
              onClick={onClose}
              className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] hover:text-[#1f2329]"
            >
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="flex min-h-[200px] min-w-[280px] flex-1 items-center justify-center overflow-auto bg-[#f5f6f7] p-4">
          <img
            src={url}
            alt={alt || ""}
            className="max-h-[70vh] max-w-[78vw] rounded object-contain shadow-sm"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
