import { useEffect } from "react";
import { FileDown, Printer, RotateCcw, X } from "lucide-react";
import type { Comment } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type PrintPaperSize = "a4" | "letter";
export type PrintOrientation = "portrait" | "landscape";
export type PrintMargins = "normal" | "narrow" | "wide";

export interface DocPrintSettings {
  paper: PrintPaperSize;
  orientation: PrintOrientation;
  margins: PrintMargins;
  showHeader: boolean;
  headerText: string;
  showFooter: boolean;
  footerText: string;
  includeComments: boolean;
}

export const DEFAULT_PRINT_SETTINGS: DocPrintSettings = {
  paper: "a4",
  orientation: "portrait",
  margins: "normal",
  showHeader: false,
  headerText: "",
  showFooter: false,
  footerText: "",
  includeComments: false,
};

export interface PrintableCommentThread {
  root: Comment;
  replies: Comment[];
}

export interface PrintPreviewLine {
  kind: "heading" | "paragraph" | "table" | "callout";
  text: string;
}

const PAPER_CSS: Record<PrintPaperSize, string> = {
  a4: "A4",
  letter: "Letter",
};

const MARGIN_CSS: Record<PrintMargins, string> = {
  normal: "18mm 16mm",
  narrow: "10mm 10mm",
  wide: "24mm 24mm",
};

const PREVIEW_PADDING: Record<PrintMargins, string> = {
  normal: "p-5 sm:p-6",
  narrow: "p-3 sm:p-3.5",
  wide: "p-7 sm:p-8",
};

/** Generates a standards-compliant @page rule matching user print preferences. */
export function buildPrintPageCss(settings: DocPrintSettings): string {
  const size = `${PAPER_CSS[settings.paper]} ${settings.orientation}`;
  const margin = MARGIN_CSS[settings.margins];
  return `@page { size: ${size}; margin: ${margin}; }`;
}

/**
 * Injects a temporary `<style data-doc-print-style>` into `document.head`
 * before `window.print()`. Returns a cleanup callback to remove the tag.
 */
export function applyPrintPageStyle(settings: DocPrintSettings, doc: Document = document): () => void {
  const existing = doc.head.querySelectorAll("style[data-doc-print-style]");
  for (const node of existing) node.remove();
  const style = doc.createElement("style");
  style.setAttribute("data-doc-print-style", "1");
  style.textContent = buildPrintPageCss(settings);
  doc.head.appendChild(style);
  return () => {
    style.remove();
  };
}

/** Groups flat comments into ordered root threads with nested replies for printing or Word export. */
export function buildPrintCommentsThreads(comments: Comment[]): PrintableCommentThread[] {
  const byParent = new Map<number, Comment[]>();
  const roots: Comment[] = [];
  for (const item of comments) {
    if (item.parentId) {
      const list = byParent.get(item.parentId);
      if (list) list.push(item);
      else byParent.set(item.parentId, [item]);
    } else {
      roots.push(item);
    }
  }
  return roots.map((root) => ({
    root,
    replies: byParent.get(root.id) ?? [],
  }));
}

function previewAspectClass(paper: PrintPaperSize, orientation: PrintOrientation): string {
  if (paper === "letter") {
    return orientation === "landscape" ? "aspect-[279/216] max-w-[360px]" : "aspect-[216/279] max-w-[270px]";
  }
  return orientation === "landscape" ? "aspect-[297/210] max-w-[360px]" : "aspect-[210/297] max-w-[260px]";
}

export function DocPrintDialog({
  title,
  settings,
  onChange,
  previewLines,
  commentCount,
  defaultHeaderText,
  defaultFooterText,
  onConfirm,
  onClose,
}: {
  title: string;
  settings: DocPrintSettings;
  onChange: (updater: DocPrintSettings | ((prev: DocPrintSettings) => DocPrintSettings)) => void;
  previewLines: PrintPreviewLine[];
  commentCount: number;
  defaultHeaderText: string;
  defaultFooterText: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const update = (patch: Partial<DocPrintSettings>) => onChange((prev) => ({ ...prev, ...patch }));
  const reset = () =>
    onChange({
      ...DEFAULT_PRINT_SETTINGS,
      headerText: defaultHeaderText,
      footerText: defaultFooterText,
    });

  const displayTitle = title.trim() || t("未命名文档");
  const effectiveHeader = settings.headerText.trim() || displayTitle;
  const effectiveFooter = settings.footerText.trim() || t("鉴格云文档");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("打印与导出 PDF 设置")}
      data-doc-print-dialog
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92dvh] w-full max-w-[780px] flex-col overflow-hidden rounded-xl border border-[#DEE0E3] bg-surface shadow-2xl dark:border-border">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Printer className="size-4 text-primary" />
            <h2 className="text-[15px] font-semibold text-foreground">{t("打印 / 导出 PDF 设置")}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("关闭打印设置")}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
            data-doc-print-close
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[310px_1fr]">
          {/* Left: print parameters */}
          <div className="space-y-4 border-b p-5 md:border-b-0 md:border-r">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">{t("纸张大小")}</div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: "a4", label: "A4", sub: "210×297 mm" },
                  { value: "letter", label: "Letter", sub: "216×279 mm" },
                ] as const).map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={settings.paper === item.value}
                    data-print-paper={item.value}
                    onClick={() => update({ paper: item.value })}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left",
                      settings.paper === item.value
                        ? "border-primary bg-primary/8 text-primary"
                        : "border-border hover:bg-hover",
                    )}
                  >
                    <div className="text-[13px] font-medium">{item.label}</div>
                    <div className="text-[11px] text-muted-foreground">{item.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">{t("页面方向")}</div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: "portrait", label: t("纵向") },
                  { value: "landscape", label: t("横向") },
                ] as const).map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={settings.orientation === item.value}
                    data-print-orientation={item.value}
                    onClick={() => update({ orientation: item.value })}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-[13px] font-medium",
                      settings.orientation === item.value
                        ? "border-primary bg-primary/8 text-primary"
                        : "border-border text-foreground hover:bg-hover",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">{t("页边距")}</div>
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  { value: "narrow", label: t("窄边距") },
                  { value: "normal", label: t("标准") },
                  { value: "wide", label: t("宽边距") },
                ] as const).map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={settings.margins === item.value}
                    data-print-margin={item.value}
                    onClick={() => update({ margins: item.value })}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-[12px] font-medium",
                      settings.margins === item.value
                        ? "border-primary bg-primary/8 text-primary"
                        : "border-border text-foreground hover:bg-hover",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2.5 border-t pt-3.5">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
                <input
                  type="checkbox"
                  checked={settings.showHeader}
                  onChange={(event) =>
                    update({
                      showHeader: event.target.checked,
                      headerText: event.target.checked && !settings.headerText.trim() ? effectiveHeader : settings.headerText,
                    })
                  }
                  className="size-4 rounded border-border accent-primary"
                  data-print-header-toggle
                />
                <span>{t("显示页眉")}</span>
              </label>
              {settings.showHeader && (
                <input
                  type="text"
                  value={settings.headerText}
                  onChange={(event) => update({ headerText: event.target.value })}
                  placeholder={displayTitle}
                  maxLength={120}
                  aria-label={t("页眉文本")}
                  data-print-header-input
                  className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-primary"
                />
              )}

              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
                <input
                  type="checkbox"
                  checked={settings.showFooter}
                  onChange={(event) =>
                    update({
                      showFooter: event.target.checked,
                      footerText: event.target.checked && !settings.footerText.trim() ? effectiveFooter : settings.footerText,
                    })
                  }
                  className="size-4 rounded border-border accent-primary"
                  data-print-footer-toggle
                />
                <span>{t("显示页脚")}</span>
              </label>
              {settings.showFooter && (
                <input
                  type="text"
                  value={settings.footerText}
                  onChange={(event) => update({ footerText: event.target.value })}
                  placeholder={t("鉴格云文档")}
                  maxLength={120}
                  aria-label={t("页脚文本")}
                  data-print-footer-input
                  className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-primary"
                />
              )}
            </div>

            <div className="border-t pt-3.5">
              <label className="flex cursor-pointer items-center justify-between gap-2 text-[13px] text-foreground">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={settings.includeComments}
                    onChange={(event) => update({ includeComments: event.target.checked })}
                    className="size-4 rounded border-border accent-primary"
                    data-print-comments-toggle
                  />
                  <span>{t("导出评论附录")}</span>
                </span>
                <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t("{count} 条", { count: commentCount })}
                </span>
              </label>
              <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
                {t("将文档评论及回复汇总附在正文末尾，便于评审归档。")}
              </p>
            </div>
          </div>

          {/* Right: live scaled paper preview */}
          <div className="flex flex-col items-center justify-between gap-4 bg-[#F5F6F7] p-5 dark:bg-hover/30" data-print-preview>
            <div className="flex w-full items-center justify-between text-[12px] text-muted-foreground">
              <span>{t("版式预览")}</span>
              <span>
                {PAPER_CSS[settings.paper]} · {settings.orientation === "landscape" ? t("横向") : t("纵向")} ·{" "}
                {settings.margins === "narrow" ? t("窄边距") : settings.margins === "wide" ? t("宽边距") : t("标准边距")}
              </span>
            </div>

            <div
              className={cn(
                "flex w-full flex-col justify-between overflow-hidden rounded border border-[#DEE0E3] bg-white text-[#1F2329] shadow-md",
                previewAspectClass(settings.paper, settings.orientation),
                PREVIEW_PADDING[settings.margins],
              )}
              data-print-preview-sheet
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                {settings.showHeader && (
                  <div className="mb-2.5 truncate border-b border-[#E5E6EB] pb-1 text-[9px] text-[#646A73]" data-print-preview-header>
                    {effectiveHeader}
                  </div>
                )}
                <div className="truncate text-[13px] font-semibold leading-snug text-[#1F2329]">
                  {displayTitle}
                </div>
                <div className="mt-2 space-y-1.5">
                  {(previewLines.length ? previewLines : [{ kind: "paragraph" as const, text: t("文档正文内容将按所选纸张尺寸与边距自动分页排版…") }]).slice(0, settings.orientation === "landscape" ? (settings.includeComments ? 4 : 5) : 6).map((line, index) => (
                    <div
                      key={index}
                      className={cn(
                        "truncate text-[9px] leading-relaxed",
                        line.kind === "heading" && "mt-1.5 font-semibold text-[#1F2329]",
                        line.kind === "paragraph" && "text-[#4E5969]",
                        line.kind === "table" && "rounded border border-[#E5E6EB] bg-[#F7F8FA] px-1.5 py-0.5 text-[#4E5969]",
                        line.kind === "callout" && "rounded border-l-2 border-[#3370FF] bg-[#F0F4FF] px-1.5 py-0.5 text-[#1F2329]",
                      )}
                    >
                      {line.text}
                    </div>
                  ))}
                </div>
                {settings.includeComments && (
                  <div className="mt-3 rounded border border-dashed border-[#C9CDD4] bg-[#F7F8FA] px-2 py-1 text-[8.5px] text-[#4E5969]" data-print-preview-comments>
                    {t("评论附录（{n} 条线程）", { n: commentCount })}
                  </div>
                )}
              </div>

              {settings.showFooter && (
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-[#E5E6EB] pt-1 text-[9px] text-[#646A73]" data-print-preview-footer>
                  <span className="truncate">{effectiveFooter}</span>
                  <span className="shrink-0">1 / 1</span>
                </div>
              )}
            </div>

            <p className="w-full rounded-md bg-surface/80 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              {t("提示：点击下方按钮打开系统打印窗口，将目标打印机选为「另存为 PDF」即可输出高清矢量分页 PDF；标题防孤行、表格跨页重复表头与媒体防截断已自动启用。")}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
            data-doc-print-reset
          >
            <RotateCcw className="size-3.5" />
            {t("重置默认")}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3.5 py-1.5 text-[13px] text-foreground hover:bg-hover"
            >
              {t("取消")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              data-doc-print-confirm
              className="inline-flex items-center gap-1.5 rounded-md bg-[#1456F0] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[#0F4DD6]"
            >
              <FileDown className="size-4" />
              {t("打印 / 另存为 PDF")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
