import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SheetCellStyle, SheetNumFmt, SheetWorksheet } from "@/lib/api";
import { t } from "@/lib/i18n";
import {
  Activity,
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  ArrowUpAZ,
  BarChart3,
  Bold,
  Brush,
  ChevronDown,
  ChevronUp,
  Columns3,
  Download,
  Eraser,
  FileUp,
  Filter,
  FoldHorizontal,
  FoldVertical,
  Grid2X2,
  Highlighter,
  History,
  Image as ImageIcon,
  Italic,
  Layers,
  ListChecks,
  Lock,
  Maximize2,
  Menu,
  Merge,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Palette,
  PanelTop,
  Plus,
  Printer,
  Redo2,
  Rows3,
  Search,
  Sparkles,
  Strikethrough,
  TableProperties,
  Tag,
  Trash2,
  Underline,
  Undo2,
  WrapText,
} from "lucide-react";
import type { SheetPanelMode } from "./sheet-panels";

const TEXT_COLORS = ["#1f2329", "#d83931", "#ff8800", "#00b42a", "#3370ff", "#7b56d9"];
const BG_COLORS = ["", "#fff7e6", "#eef3ff", "#e8ffea", "#ffece8", "#f2f3f5"];
const BORDER_COLORS = ["#8f959e", "#1f2329", "#3370ff", "#d83931", "#00b42a"];
const FONT_FAMILIES = ["", "PingFang SC", "Microsoft YaHei", "SimSun", "monospace"];
const FONT_SIZES = [10, 11, 12, 14, 16, 18, 24];
const NUM_FORMATS: { id: SheetNumFmt; label: string }[] = [
  { id: "general", label: "常规" },
  { id: "currency", label: "¥ 货币" },
  { id: "percent", label: "% 百分比" },
  { id: "decimal2", label: "0.00 小数" },
  { id: "decimal1", label: "0.0 小数" },
  { id: "integer", label: "整数" },
  { id: "date", label: "日期 YYYY-MM-DD" },
];

export type SheetBorderPreset = "all" | "outer" | "bottom" | "topBottom" | "none";

const BORDER_PRESETS: readonly { id: SheetBorderPreset; label: string }[] = [
  { id: "all", label: "全边框" },
  { id: "outer", label: "外框线" },
  { id: "bottom", label: "下框线" },
  { id: "topBottom", label: "上下框线" },
  { id: "none", label: "清除边框" },
];

function BorderPresetIcon({ preset }: { preset: SheetBorderPreset }) {
  const stroke = "#1f2329";
  const faint = "#d0d3d6";
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="shrink-0">
      {/* Subtle base grid reference */}
      <rect x="1.5" y="1.5" width="11" height="11" stroke={faint} strokeWidth="1" strokeDasharray={preset === "none" ? "2 1.5" : undefined} />
      <line x1="7" y1="1.5" x2="7" y2="12.5" stroke={faint} strokeWidth="0.9" strokeDasharray="1.5 1.5" />
      <line x1="1.5" y1="7" x2="12.5" y2="7" stroke={faint} strokeWidth="0.9" strokeDasharray="1.5 1.5" />

      {preset === "all" && (
        <>
          <rect x="1.5" y="1.5" width="11" height="11" stroke={stroke} strokeWidth="1.2" />
          <line x1="7" y1="1.5" x2="7" y2="12.5" stroke={stroke} strokeWidth="1.1" />
          <line x1="1.5" y1="7" x2="12.5" y2="7" stroke={stroke} strokeWidth="1.1" />
        </>
      )}
      {preset === "outer" && (
        <rect x="1.5" y="1.5" width="11" height="11" stroke={stroke} strokeWidth="1.35" />
      )}
      {preset === "bottom" && (
        <line x1="1" y1="12.5" x2="13" y2="12.5" stroke={stroke} strokeWidth="1.6" />
      )}
      {preset === "topBottom" && (
        <>
          <line x1="1" y1="1.5" x2="13" y2="1.5" stroke={stroke} strokeWidth="1.4" />
          <line x1="1" y1="12.5" x2="13" y2="12.5" stroke={stroke} strokeWidth="1.4" />
        </>
      )}
    </svg>
  );
}

export interface SheetTabsBarProps {
  sheets: SheetWorksheet[];
  activeSheetId: number;
  canEdit: boolean;
  fullscreen: boolean;
  toolbarCollapsed?: boolean;
  onSelectSheet: (id: number) => void;
  onCreateSheet: () => void;
  onRenameSheet: (id: number) => void;
  onMoveSheet: (id: number, toPos: number) => void;
  onDeleteSheet: (id: number) => void;
  onToggleFullscreen: () => void;
  onToggleToolbarCollapsed?: () => void;
}

export function SheetTabsBar({
  sheets,
  activeSheetId,
  canEdit,
  fullscreen,
  toolbarCollapsed,
  onSelectSheet,
  onCreateSheet,
  onRenameSheet,
  onMoveSheet,
  onDeleteSheet,
  onToggleFullscreen,
  onToggleToolbarCollapsed,
}: SheetTabsBarProps) {
  const [listOpen, setListOpen] = useState(false);
  const [tabMenuId, setTabMenuId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listOpen && tabMenuId === null) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setListOpen(false);
        setTabMenuId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setListOpen(false);
        setTabMenuId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [listOpen, tabMenuId]);

  return (
    <div ref={containerRef} className="relative flex h-[38px] min-w-0 shrink-0 items-end gap-1 border-b border-[#e5e6eb] bg-[#f5f6f7] px-2 sm:px-3" data-sheet-tabs>
      <div className="relative mb-1 shrink-0">
        <button
          type="button"
          title={t("所有工作表")}
          aria-label={t("所有工作表")}
          aria-expanded={listOpen}
          onClick={() => {
            setTabMenuId(null);
            setListOpen((v) => !v);
          }}
          className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#e8eaed]"
        >
          <Layers size={15} />
        </button>
        {listOpen && (
          <div role="menu" className="absolute left-0 top-8 z-50 w-48 rounded-md border border-[#dee0e3] bg-white py-1 shadow-lg">
            {sheets.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelectSheet(s.id);
                  setListOpen(false);
                }}
                className={`flex h-8 w-full items-center px-3 text-left text-[13px] hover:bg-[#f2f3f5] ${s.id === activeSheetId ? "font-medium text-[#3370ff]" : "text-[#1f2329]"}`}
              >
                <span className="truncate">{s.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mobile-scroll-x flex min-w-0 flex-1 items-end gap-0.5 whitespace-nowrap">
        {sheets.map((ws, index) => {
          const active = ws.id === activeSheetId;
          return (
            <div key={ws.id} className="relative shrink-0">
              <div className="flex items-end">
                <button
                  type="button"
                  data-sheet-tab={ws.title}
                  onClick={() => {
                    onSelectSheet(ws.id);
                    setListOpen(false);
                  }}
                  onDoubleClick={() => {
                    if (canEdit) onRenameSheet(ws.id);
                  }}
                  className={`group/tab flex h-[33px] max-w-44 items-center gap-1 rounded-t-md border px-3 text-[13px] transition-colors ${
                    active
                      ? "-mb-px border-[#e5e6eb] border-b-white bg-white font-medium text-[#3370ff]"
                      : "border-transparent bg-transparent text-[#646a73] hover:bg-[#e8eaed]"
                  }`}
                >
                  <span className="truncate">{ws.title}</span>
                  {canEdit && (
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={t("工作表菜单")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectSheet(ws.id);
                        setListOpen(false);
                        setTabMenuId((cur) => (cur === ws.id ? null : ws.id));
                      }}
                      className="grid size-4 place-items-center rounded text-[#8f959e] opacity-70 hover:bg-[#e5e6eb] hover:text-[#1f2329] group-hover/tab:opacity-100"
                    >
                      <ChevronDown size={11} />
                    </span>
                  )}
                </button>
              </div>
              {tabMenuId === ws.id && canEdit && (
                <div role="menu" className="absolute left-0 top-[35px] z-50 w-36 rounded-md border border-[#dee0e3] bg-white py-1 text-[12px] text-[#1f2329] shadow-lg">
                  <button type="button" role="menuitem" onClick={() => { setTabMenuId(null); onRenameSheet(ws.id); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("重命名")}</button>
                  <button type="button" role="menuitem" disabled={index === 0} onClick={() => { setTabMenuId(null); onMoveSheet(ws.id, index - 1); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5] disabled:opacity-40">{t("向左移动")}</button>
                  <button type="button" role="menuitem" disabled={index >= sheets.length - 1} onClick={() => { setTabMenuId(null); onMoveSheet(ws.id, index + 1); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5] disabled:opacity-40">{t("向右移动")}</button>
                  <button type="button" role="menuitem" disabled={sheets.length <= 1} onClick={() => { setTabMenuId(null); onDeleteSheet(ws.id); }} className="flex h-8 w-full items-center px-3 text-left text-[#d83931] hover:bg-[#fff2f0] disabled:opacity-40">{t("删除工作表")}</button>
                </div>
              )}
            </div>
          );
        })}
        {canEdit && (
          <button
            type="button"
            title={t("新建工作表")}
            aria-label={t("新建工作表")}
            data-sheet-add-tab
            onClick={onCreateSheet}
            className="mb-1 ml-0.5 grid size-7 shrink-0 place-items-center rounded text-[#4b5058] hover:bg-[#e9ecf1]"
          >
            <Plus size={16} />
          </button>
        )}
      </div>

      {toolbarCollapsed && onToggleToolbarCollapsed && (
        <button
          type="button"
          title={t("展开工具栏")}
          aria-label={t("展开工具栏")}
          onClick={onToggleToolbarCollapsed}
          className="mb-1 grid size-7 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#e9ecf1]"
        >
          <ChevronDown size={15} />
        </button>
      )}
      <button
        type="button"
        title={fullscreen ? t("退出全屏") : t("全屏显示")}
        aria-label={fullscreen ? t("退出全屏") : t("全屏显示")}
        onClick={onToggleFullscreen}
        className="mb-1 grid size-7 shrink-0 place-items-center rounded text-[#646a73] hover:bg-[#e9ecf1]"
      >
        {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
    </div>
  );
}

export interface SheetToolbarProps {
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  formatBrushActive: boolean;
  activeStyle: SheetCellStyle;
  isMerged: boolean;
  filterEnabled: boolean;
  frozenRows: number;
  frozenCols: number;
  importing: boolean;
  onTriggerImport: () => void;
  /** Omitted when the workbook's download policy forbids export/copies. */
  onExport?: () => void;
  onOpenPrint?: () => void;
  onDuplicate?: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleFormatBrush: () => void;
  onClearFormat: () => void;
  onStylePatch: (patch: Partial<SheetCellStyle>) => void;
  onToggleBorder?: () => void;
  onApplyBorderPreset?: (preset: SheetBorderPreset, color?: string) => void;
  onToggleMerge: () => void;
  onInsertRowAbove: () => void;
  onInsertRowBelow: () => void;
  onInsertColLeft: () => void;
  onInsertColRight: () => void;
  onDeleteRow: () => void;
  onDeleteCol: () => void;
  onFreezeRows: (rows: number, cols?: number) => void;
  onToggleFilter: () => void;
  onSortCol: (ascending: boolean) => void;
  onOpenFind: () => void;
  activePanel: SheetPanelMode | null;
  unresolvedCommentCount: number;
  onTogglePanel: (mode: SheetPanelMode) => void;
  sparklineOpen?: boolean;
  onOpenSparkline?: (anchor: { left: number; top: number; bottom: number; right: number }) => void;
  cellImageOpen?: boolean;
  onOpenCellImage?: (anchor: { left: number; top: number; bottom: number; right: number }) => void;
  hasRowGroupInSelection?: boolean;
  hasColGroupInSelection?: boolean;
  onToggleGroupRows?: () => void;
  onToggleGroupCols?: () => void;
  onCollapseToolbar?: () => void;
}

type ToolbarMenuId = "file" | "insert" | "font" | "size" | "border" | "color" | "bg" | "numfmt" | "freeze";

interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  right: number;
  width: number;
}

interface OpenToolbarMenu {
  id: ToolbarMenuId;
  rect: AnchorRect;
}

const MENU_METRICS: Record<ToolbarMenuId, { width: number; estHeight: number }> = {
  file: { width: 184, estHeight: 212 },
  insert: { width: 164, estHeight: 224 },
  font: { width: 148, estHeight: 184 },
  size: { width: 84, estHeight: 212 },
  border: { width: 184, estHeight: 224 },
  color: { width: 176, estHeight: 52 },
  bg: { width: 176, estHeight: 52 },
  numfmt: { width: 176, estHeight: 244 },
  freeze: { width: 164, estHeight: 144 },
};

function computeClampedMenuPos(rect: AnchorRect, id: ToolbarMenuId): { left: number; top: number; width: number } {
  const { estHeight } = MENU_METRICS[id];
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const width = Math.min(MENU_METRICS[id].width, Math.max(120, vw - 16));
  const left = Math.max(8, Math.min(rect.left, vw - width - 8));
  const fitsBelow = rect.bottom + 4 + estHeight <= vh - 8;
  const top = fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - estHeight - 4);
  return { left, top, width };
}

export function SheetToolbar(props: SheetToolbarProps) {
  const {
    canEdit,
    canUndo,
    canRedo,
    formatBrushActive,
    activeStyle,
    isMerged,
    filterEnabled,
    frozenRows,
    frozenCols,
    importing,
    onTriggerImport,
    onExport,
    onOpenPrint,
    onDuplicate,
    onUndo,
    onRedo,
    onToggleFormatBrush,
    onClearFormat,
    onStylePatch,
    onToggleBorder,
    onApplyBorderPreset,
    onToggleMerge,
    onInsertRowAbove,
    onInsertRowBelow,
    onInsertColLeft,
    onInsertColRight,
    onDeleteRow,
    onDeleteCol,
    onFreezeRows,
    onToggleFilter,
    onSortCol,
    onOpenFind,
    activePanel,
    unresolvedCommentCount,
    onTogglePanel,
    sparklineOpen,
    onOpenSparkline,
    cellImageOpen,
    onOpenCellImage,
    hasRowGroupInSelection,
    hasColGroupInSelection,
    onToggleGroupRows,
    onToggleGroupCols,
    onCollapseToolbar,
  } = props;

  const [openMenu, setOpenMenu] = useState<OpenToolbarMenu | null>(null);
  const [borderColor, setBorderColor] = useState<string>("#8f959e");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerElRef = useRef<HTMLButtonElement | null>(null);

  const toggleMenu = (id: ToolbarMenuId, e: React.MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    setOpenMenu((cur) => {
      if (cur?.id === id) {
        triggerElRef.current = null;
        return null;
      }
      triggerElRef.current = el;
      return {
        id,
        rect: { left: r.left, top: r.top, bottom: r.bottom, right: r.right, width: r.width },
      };
    });
  };

  const closeMenu = () => {
    triggerElRef.current = null;
    setOpenMenu(null);
  };

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerElRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const trigger = triggerElRef.current;
        closeMenu();
        trigger?.focus();
      }
    };
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [openMenu]);

  const iconBtn = (
    label: string,
    active: boolean,
    disabled: boolean,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void,
    children: React.ReactNode,
    dataAttr?: string,
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      data-sheet-tool={dataAttr}
      className={`grid h-7 min-w-7 place-items-center rounded px-1 text-[#4b5058] transition-colors enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${active ? "bg-[#e1eaff] text-[#3370ff]" : ""}`}
    >
      {children}
    </button>
  );

  const labeledBtn = (
    label: string,
    active: boolean,
    disabled: boolean,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void,
    children: React.ReactNode,
    dataAttr?: string,
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-sheet-tool={dataAttr}
      className={`flex h-12 min-w-[34px] shrink-0 flex-col items-center justify-center gap-0.5 rounded px-1 text-[10.5px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${active ? "bg-[#e1eaff] text-[#3370ff]" : ""}`}
    >
      {children}
      <span>{label}</span>
    </button>
  );

  const activeFmtLabel = NUM_FORMATS.find((f) => f.id === (activeStyle.numFmt || "general"))?.label.split(" ")[0] ?? t("常规");
  const hasAnyBorders = !!(
    activeStyle.borders &&
    (activeStyle.borders.top || activeStyle.borders.right || activeStyle.borders.bottom || activeStyle.borders.left)
  );

  const renderPortaledMenu = () => {
    if (!openMenu || typeof document === "undefined") return null;
    const pos = computeClampedMenuPos(openMenu.rect, openMenu.id);
    const baseMenuCls =
      "fixed z-[120] rounded-lg border border-[#dee0e3] bg-white py-1 text-[#1f2329] shadow-[0_8px_28px_rgba(31,35,41,0.16)]";

    let body: React.ReactNode = null;
    if (openMenu.id === "file") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          data-sheet-toolbar-menu="file"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className={`${baseMenuCls} text-[13px]`}
        >
          {canEdit && (
            <button type="button" role="menuitem" disabled={importing} onClick={() => { closeMenu(); onTriggerImport(); }} className="flex h-9 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]">
              <FileUp size={14} />{t("导入 XLSX")}
            </button>
          )}
          {onExport && (
            <button type="button" role="menuitem" onClick={() => { closeMenu(); onExport(); }} className="flex h-9 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]">
              <Download size={14} />{t("导出 XLSX")}
            </button>
          )}
          {onOpenPrint && (
            <button
              type="button"
              role="menuitem"
              data-sheet-print-trigger
              onClick={() => {
                closeMenu();
                onOpenPrint();
              }}
              className="flex h-9 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"
            >
              <Printer size={14} />{t("打印 / 导出 PDF")}
            </button>
          )}
          {onDuplicate && (
            <button type="button" role="menuitem" onClick={() => { closeMenu(); onDuplicate(); }} className="flex h-9 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]">
              <MoreHorizontal size={14} />{t("创建副本")}
            </button>
          )}
          <div className="my-1 border-t border-[#eceef2]" />
          <button
            type="button"
            role="menuitem"
            data-sheet-versions-menu-item
            onClick={() => {
              closeMenu();
              onTogglePanel("versions");
            }}
            className="flex h-9 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"
          >
            <History size={14} />{t("历史版本")}
          </button>
        </div>
      );
    } else if (openMenu.id === "insert") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          data-sheet-toolbar-menu="insert"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className={`${baseMenuCls} text-[13px]`}
        >
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onInsertRowAbove(); }} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Rows3 size={14} />{t("上方插入行")}</button>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onInsertRowBelow(); }} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Rows3 size={14} />{t("下方插入行")}</button>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onInsertColLeft(); }} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Columns3 size={14} />{t("左侧插入列")}</button>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onInsertColRight(); }} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Columns3 size={14} />{t("右侧插入列")}</button>
          <div className="my-1 border-t border-[#eceef2]" />
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onDeleteRow(); }} className="flex h-8 w-full items-center gap-2 px-3 text-[#d83931] hover:bg-[#fff2f0]"><Trash2 size={14} />{t("删除当前行")}</button>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onDeleteCol(); }} className="flex h-8 w-full items-center gap-2 px-3 text-[#d83931] hover:bg-[#fff2f0]"><Trash2 size={14} />{t("删除当前列")}</button>
        </div>
      );
    } else if (openMenu.id === "font") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          data-sheet-toolbar-menu="font"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className={`${baseMenuCls} text-[12px]`}
        >
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onStylePatch({ fontFamily: "" }); }} className={`flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5] ${!activeStyle.fontFamily ? "font-medium text-[#3370ff]" : ""}`}>
            {t("默认字体")}
          </button>
          {FONT_FAMILIES.filter(Boolean).map((f) => (
            <button key={f} type="button" role="menuitem" onClick={() => { closeMenu(); onStylePatch({ fontFamily: f }); }} className={`flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5] ${activeStyle.fontFamily === f ? "font-medium text-[#3370ff]" : ""}`} style={{ fontFamily: f }}>
              {f}
            </button>
          ))}
        </div>
      );
    } else if (openMenu.id === "size") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          data-sheet-toolbar-menu="size"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className={`${baseMenuCls} text-[12px]`}
        >
          {FONT_SIZES.map((sz) => (
            <button key={sz} type="button" role="menuitem" onClick={() => { closeMenu(); onStylePatch({ fontSize: sz }); }} className={`flex h-7 w-full items-center px-3 text-left hover:bg-[#f2f3f5] ${(activeStyle.fontSize || 12) === sz ? "font-medium text-[#3370ff]" : ""}`}>
              {sz}
            </button>
          ))}
        </div>
      );
    } else if (openMenu.id === "border") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("边框样式")}
          data-sheet-toolbar-menu="border"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className={`${baseMenuCls} p-1.5 text-[12px]`}
        >
          <div className="space-y-0.5">
            {BORDER_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-sheet-border-preset={item.id}
                onClick={() => {
                  closeMenu();
                  if (onApplyBorderPreset) {
                    onApplyBorderPreset(item.id, borderColor);
                  } else if (onToggleBorder) {
                    onToggleBorder();
                  }
                }}
                className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[#1f2329] hover:bg-[#f2f3f5]"
              >
                <BorderPresetIcon preset={item.id} />
                <span>{t(item.label)}</span>
              </button>
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between border-t border-[#eff0f1] px-2 pt-2 pb-0.5">
            <span className="text-[11px] text-[#8f959e]">{t("边框颜色")}</span>
            <div className="flex items-center gap-1">
              {BORDER_COLORS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  aria-label={hex}
                  onClick={() => setBorderColor(hex)}
                  className={`size-4 rounded-full border transition-transform ${
                    borderColor === hex ? "scale-110 border-[#3370ff] ring-2 ring-[#3370ff]/30" : "border-[#dee0e3]"
                  }`}
                  style={{ backgroundColor: hex }}
                />
              ))}
            </div>
          </div>
        </div>
      );
    } else if (openMenu.id === "color") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          data-sheet-toolbar-menu="color"
          style={{ left: pos.left, top: pos.top }}
          className="fixed z-[120] flex gap-1.5 rounded-lg border border-[#dee0e3] bg-white p-2 shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
        >
          {TEXT_COLORS.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={hex}
              onClick={() => { closeMenu(); onStylePatch({ color: hex }); }}
              className="size-5 rounded-full border border-[#dee0e3] transition-transform hover:scale-110"
              style={{ backgroundColor: hex }}
            />
          ))}
        </div>
      );
    } else if (openMenu.id === "bg") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          data-sheet-toolbar-menu="bg"
          style={{ left: pos.left, top: pos.top }}
          className="fixed z-[120] flex gap-1.5 rounded-lg border border-[#dee0e3] bg-white p-2 shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
        >
          {BG_COLORS.map((hex) => (
            <button
              key={hex || "none"}
              type="button"
              aria-label={hex || t("无填充")}
              onClick={() => { closeMenu(); onStylePatch({ bg: hex }); }}
              className="size-5 rounded border border-[#dee0e3] text-[10px] transition-transform hover:scale-110"
              style={{ backgroundColor: hex || "#ffffff" }}
            >
              {hex ? "" : "×"}
            </button>
          ))}
        </div>
      );
    } else if (openMenu.id === "numfmt") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          data-sheet-toolbar-menu="numfmt"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className={`${baseMenuCls} text-[12px]`}
        >
          {NUM_FORMATS.map((fmt) => (
            <button
              key={fmt.id}
              type="button"
              role="menuitem"
              onClick={() => { closeMenu(); onStylePatch({ numFmt: fmt.id }); }}
              className={`flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5] ${activeStyle.numFmt === fmt.id ? "font-medium text-[#3370ff]" : ""}`}
            >
              {t(fmt.label)}
            </button>
          ))}
        </div>
      );
    } else if (openMenu.id === "freeze") {
      body = (
        <div
          ref={menuRef}
          role="menu"
          data-sheet-toolbar-menu="freeze"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className={`${baseMenuCls} text-[12px]`}
        >
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onFreezeRows(1, 0); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("冻结首行")}</button>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onFreezeRows(0, 1); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("冻结首列")}</button>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onFreezeRows(1, 1); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("同时冻结首行首列")}</button>
          <button type="button" role="menuitem" onClick={() => { closeMenu(); onFreezeRows(0, 0); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("取消冻结")}</button>
        </div>
      );
    }

    return body ? createPortal(body, document.body) : null;
  };

  return (
    <div ref={rootRef} className="mobile-scroll-x relative flex h-[54px] min-w-0 shrink-0 items-center gap-0.5 whitespace-nowrap border-b border-[#e5e6eb] bg-white px-2" data-sheet-toolbar>
      <div className="relative shrink-0">
        {labeledBtn(t("菜单"), openMenu?.id === "file", false, (e) => toggleMenu("file", e), <Menu size={15} />)}
      </div>

      {labeledBtn(t("撤销"), false, !canEdit || !canUndo, onUndo, <Undo2 size={15} />, "undo")}
      {labeledBtn(t("重做"), false, !canEdit || !canRedo, onRedo, <Redo2 size={15} />, "redo")}
      {labeledBtn(t("格式刷"), formatBrushActive, !canEdit, onToggleFormatBrush, <Brush size={15} />, "format-brush")}
      {labeledBtn(t("清除格式"), false, !canEdit, onClearFormat, <Eraser size={15} />, "clear-format")}

      <div className="relative shrink-0">
        {labeledBtn(t("插入"), openMenu?.id === "insert", !canEdit, (e) => toggleMenu("insert", e), <Plus size={15} />)}
      </div>

      <span className="mx-0.5 h-8 w-px shrink-0 bg-[#dee0e3]" />

      <div className="flex shrink-0 flex-col gap-0.5 px-0.5">
        <div className="flex h-6 items-center gap-1 text-[12px] text-[#4b5058]">
          <div className="relative">
            <button
              type="button"
              aria-label={t("字体")}
              aria-expanded={openMenu?.id === "font"}
              disabled={!canEdit}
              onClick={(e) => toggleMenu("font", e)}
              className={`flex h-6 w-[88px] items-center justify-between gap-1 rounded px-1.5 text-[12px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${openMenu?.id === "font" ? "bg-[#e1eaff] text-[#3370ff]" : ""}`}
            >
              <span className="truncate">{activeStyle.fontFamily || t("默认字体")}</span>
              <ChevronDown size={11} className="shrink-0 text-[#8f959e]" />
            </button>
          </div>
          <div className="relative">
            <button
              type="button"
              aria-label={t("字号")}
              aria-expanded={openMenu?.id === "size"}
              disabled={!canEdit}
              onClick={(e) => toggleMenu("size", e)}
              className={`flex h-6 w-11 items-center justify-between gap-1 rounded px-1.5 text-[12px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${openMenu?.id === "size" ? "bg-[#e1eaff] text-[#3370ff]" : ""}`}
            >
              <span>{activeStyle.fontSize || 12}</span>
              <ChevronDown size={11} className="shrink-0 text-[#8f959e]" />
            </button>
          </div>
          <button
            type="button"
            title={t("边框")}
            aria-label={t("边框")}
            aria-expanded={openMenu?.id === "border"}
            aria-haspopup="menu"
            disabled={!canEdit}
            data-sheet-tool="borders"
            onClick={(e) => toggleMenu("border", e)}
            className={`inline-flex h-7 items-center gap-0.5 rounded px-1.5 text-[#4b5058] transition-colors enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${
              hasAnyBorders || openMenu?.id === "border" ? "bg-[#e1eaff] text-[#3370ff]" : ""
            }`}
          >
            <Grid2X2 size={14} />
            <ChevronDown size={10} className="text-[#8f959e]" />
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          {iconBtn(t("粗体"), !!activeStyle.bold, !canEdit, () => onStylePatch({ bold: !activeStyle.bold }), <Bold size={14} />, "bold")}
          {iconBtn(t("删除线"), !!activeStyle.strike, !canEdit, () => onStylePatch({ strike: !activeStyle.strike }), <Strikethrough size={14} />, "strike")}
          {iconBtn(t("斜体"), !!activeStyle.italic, !canEdit, () => onStylePatch({ italic: !activeStyle.italic }), <Italic size={14} />, "italic")}
          {iconBtn(t("下划线"), !!activeStyle.underline, !canEdit, () => onStylePatch({ underline: !activeStyle.underline }), <Underline size={14} />, "underline")}
          <div className="relative">
            {iconBtn(
              t("字体颜色"),
              openMenu?.id === "color",
              !canEdit,
              (e) => toggleMenu("color", e),
              <span className="flex flex-col items-center leading-none">
                <Palette size={13} />
                <span className="mt-0.5 h-0.5 w-3.5" style={{ backgroundColor: activeStyle.color || "#1f2329" }} />
              </span>,
            )}
          </div>
          <div className="relative">
            {iconBtn(t("单元格填充"), openMenu?.id === "bg", !canEdit, (e) => toggleMenu("bg", e), <Highlighter size={14} />)}
          </div>
        </div>
      </div>

      <span className="mx-0.5 h-8 w-px shrink-0 bg-[#dee0e3]" />

      <div className="flex shrink-0 flex-col gap-0.5">
        <div className="flex items-center gap-0.5">
          {iconBtn(t("左对齐"), activeStyle.align === "left", !canEdit, () => onStylePatch({ align: activeStyle.align === "left" ? "" : "left" }), <AlignLeft size={14} />, "align-left")}
          {iconBtn(t("水平居中"), activeStyle.align === "center", !canEdit, () => onStylePatch({ align: activeStyle.align === "center" ? "" : "center" }), <AlignCenter size={14} />, "align-center")}
          {iconBtn(t("右对齐"), activeStyle.align === "right", !canEdit, () => onStylePatch({ align: activeStyle.align === "right" ? "" : "right" }), <AlignRight size={14} />, "align-right")}
          {iconBtn(t("自动换行"), !!activeStyle.wrap, !canEdit, () => onStylePatch({ wrap: !activeStyle.wrap }), <WrapText size={14} />, "wrap")}
        </div>
        <button
          type="button"
          disabled={!canEdit}
          onClick={onToggleMerge}
          data-sheet-tool="merge"
          className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] enabled:hover:bg-[#e9ecf1] disabled:opacity-45 ${isMerged ? "bg-[#e1eaff] text-[#3370ff]" : "text-[#4b5058]"}`}
        >
          <Merge size={12} />
          <span>{isMerged ? t("取消合并") : t("合并单元格")}</span>
        </button>
      </div>

      <span className="mx-0.5 h-8 w-px shrink-0 bg-[#dee0e3]" />

      <div className="relative flex shrink-0 flex-col gap-0.5">
        <button
          type="button"
          disabled={!canEdit}
          aria-expanded={openMenu?.id === "numfmt"}
          data-sheet-tool="numfmt"
          onClick={(e) => toggleMenu("numfmt", e)}
          className={`flex h-6 shrink-0 items-center justify-between gap-2 rounded px-1.5 text-[12px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:opacity-45 ${openMenu?.id === "numfmt" ? "bg-[#e1eaff] text-[#3370ff]" : ""}`}
        >
          <span>{t(activeFmtLabel)}</span>
          <ChevronDown size={11} className="text-[#8f959e]" />
        </button>
        <div className="flex items-center gap-0.5">
          {iconBtn(t("¥ 货币"), activeStyle.numFmt === "currency", !canEdit, () => onStylePatch({ numFmt: activeStyle.numFmt === "currency" ? "general" : "currency" }), <span className="text-[12px] font-medium leading-none">¥</span>, "fmt-currency")}
          {iconBtn(t("% 百分比"), activeStyle.numFmt === "percent", !canEdit, () => onStylePatch({ numFmt: activeStyle.numFmt === "percent" ? "general" : "percent" }), <span className="text-[12px] font-medium leading-none">%</span>, "fmt-percent")}
          {iconBtn(t("0.00 小数"), activeStyle.numFmt === "decimal2", !canEdit, () => onStylePatch({ numFmt: activeStyle.numFmt === "decimal2" ? "general" : "decimal2" }), <span className="text-[11px] font-medium leading-none">.00</span>, "fmt-decimal2")}
          {iconBtn(t("0.0 小数"), activeStyle.numFmt === "decimal1", !canEdit, () => onStylePatch({ numFmt: activeStyle.numFmt === "decimal1" ? "general" : "decimal1" }), <span className="text-[11px] font-medium leading-none">.0</span>, "fmt-decimal1")}
        </div>
      </div>

      <span className="mx-0.5 h-8 w-px shrink-0 bg-[#dee0e3]" />

      <div className="relative shrink-0">
        {labeledBtn(t("冻结"), frozenRows > 0 || frozenCols > 0 || openMenu?.id === "freeze", !canEdit, (e) => toggleMenu("freeze", e), <PanelTop size={15} />, "freeze")}
      </div>

      {labeledBtn(t("筛选"), filterEnabled, !canEdit, onToggleFilter, <Filter size={15} />, "filter")}
      {labeledBtn(t("升序"), false, !canEdit, () => onSortCol(true), <ArrowUpAZ size={15} />, "sort-asc")}
      {labeledBtn(t("降序"), false, !canEdit, () => onSortCol(false), <ArrowDownAZ size={15} />, "sort-desc")}
      {labeledBtn(t("查找替换"), false, false, onOpenFind, <Search size={15} />, "find-replace")}

      <span className="mx-0.5 h-8 w-px shrink-0 bg-[#dee0e3]" />

      {labeledBtn(t("图表"), activePanel === "charts", false, () => onTogglePanel("charts"), <BarChart3 size={15} />, "charts")}
      {labeledBtn(t("透视表"), activePanel === "pivot", false, () => onTogglePanel("pivot"), <TableProperties size={15} />, "pivot")}
      {onOpenSparkline && (
        <button
          type="button"
          title={t("插入迷你图")}
          aria-label={t("迷你图")}
          aria-expanded={!!sparklineOpen}
          disabled={!canEdit}
          data-sheet-sparkline-btn
          data-sheet-tool="sparkline"
          onClick={(e) => {
            closeMenu();
            const r = e.currentTarget.getBoundingClientRect();
            onOpenSparkline({ left: r.left, top: r.top, bottom: r.bottom, right: r.right });
          }}
          className={`flex h-12 min-w-[34px] shrink-0 flex-col items-center justify-center gap-0.5 rounded px-1 text-[10.5px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${sparklineOpen ? "bg-[#e1eaff] text-[#3370ff]" : ""}`}
        >
          <Activity size={15} />
          <span>{t("迷你图")}</span>
        </button>
      )}
      {onOpenCellImage && (
        <button
          type="button"
          title={t("插入单元格图片")}
          aria-label={t("插入单元格图片")}
          aria-expanded={!!cellImageOpen}
          disabled={!canEdit}
          data-sheet-cell-image-btn
          data-sheet-tool="cell-image"
          onClick={(e) => {
            closeMenu();
            const r = e.currentTarget.getBoundingClientRect();
            onOpenCellImage({ left: r.left, top: r.top, bottom: r.bottom, right: r.right });
          }}
          className={`flex h-12 min-w-[34px] shrink-0 flex-col items-center justify-center gap-0.5 rounded px-1 text-[10.5px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${cellImageOpen ? "bg-[#e1eaff] text-[#3370ff]" : ""}`}
        >
          <ImageIcon size={15} />
          <span>{t("单元格图片")}</span>
        </button>
      )}
      {(onToggleGroupRows || onToggleGroupCols) && (
        <div className="flex shrink-0 flex-col gap-0.5 px-0.5">
          {onToggleGroupRows && (
            <button
              type="button"
              title={hasRowGroupInSelection ? t("取消行分组") : t("行分组")}
              aria-label={hasRowGroupInSelection ? t("取消行分组") : t("行分组")}
              disabled={!canEdit}
              data-sheet-group-rows-btn
              data-sheet-tool="group-rows"
              onClick={onToggleGroupRows}
              className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${hasRowGroupInSelection ? "bg-[#e1eaff] text-[#3370ff]" : "text-[#4b5058]"}`}
            >
              <FoldVertical size={12} />
              <span>{hasRowGroupInSelection ? t("取消行分组") : t("行分组")}</span>
            </button>
          )}
          {onToggleGroupCols && (
            <button
              type="button"
              title={hasColGroupInSelection ? t("取消列分组") : t("列分组")}
              aria-label={hasColGroupInSelection ? t("取消列分组") : t("列分组")}
              disabled={!canEdit}
              data-sheet-group-cols-btn
              data-sheet-tool="group-cols"
              onClick={onToggleGroupCols}
              className={`flex h-5 items-center gap-1 rounded px-1.5 text-[11px] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45 ${hasColGroupInSelection ? "bg-[#e1eaff] text-[#3370ff]" : "text-[#4b5058]"}`}
            >
              <FoldHorizontal size={12} />
              <span>{hasColGroupInSelection ? t("取消列分组") : t("列分组")}</span>
            </button>
          )}
        </div>
      )}
      {labeledBtn(t("数据验证"), activePanel === "validation", false, () => onTogglePanel("validation"), <ListChecks size={15} />, "validation")}
      {labeledBtn(t("条件格式"), activePanel === "condfmt", false, () => onTogglePanel("condfmt"), <Sparkles size={15} />, "cond-fmt")}
      {labeledBtn(t("保护区域"), activePanel === "protect", false, () => onTogglePanel("protect"), <Lock size={15} />, "protect")}
      {labeledBtn(t("名称管理器"), activePanel === "names", false, () => onTogglePanel("names"), <Tag size={15} />, "names")}
      {labeledBtn(
        t("评论"),
        activePanel === "comments",
        false,
        () => onTogglePanel("comments"),
        <span className="relative inline-flex">
          <MessageSquare size={15} />
          {unresolvedCommentCount > 0 && (
            <span
              data-sheet-comment-count
              className="absolute -right-2.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[#ff8800] px-1 text-[9px] font-semibold leading-none text-white"
            >
              {unresolvedCommentCount > 99 ? "99+" : unresolvedCommentCount}
            </span>
          )}
        </span>,
        "comments",
      )}
      {onCollapseToolbar && (
        <button
          type="button"
          title={t("收起工具栏")}
          aria-label={t("收起工具栏")}
          onClick={onCollapseToolbar}
          className="sticky right-0 z-10 ml-auto grid size-7 shrink-0 place-items-center rounded border-l border-[#f0f1f5] bg-white/95 text-[#646a73] shadow-[-6px_0_10px_-4px_rgba(31,35,41,0.12)] backdrop-blur-xs hover:bg-[#f2f3f5]"
        >
          <ChevronUp size={15} />
        </button>
      )}
      {renderPortaledMenu()}
    </div>
  );
}
