import { useEffect, useRef, useState } from "react";
import type { SheetCellStyle, SheetNumFmt, SheetWorksheet } from "@/lib/api";
import { t } from "@/lib/i18n";
import {
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
  Grid2X2,
  Highlighter,
  Italic,
  List,
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
  Redo2,
  Rows3,
  Search,
  Sparkles,
  Strikethrough,
  TableProperties,
  Trash2,
  Underline,
  Undo2,
  WrapText,
} from "lucide-react";
import type { SheetPanelMode } from "./sheet-panels";

const TEXT_COLORS = ["#1f2329", "#d83931", "#ff8800", "#00b42a", "#3370ff", "#7b56d9"];
const BG_COLORS = ["", "#fff7e6", "#eef3ff", "#e8ffea", "#ffece8", "#f2f3f5"];
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
    <div ref={containerRef} className="relative flex h-[40px] min-w-0 shrink-0 items-end gap-1 border-b border-[#e5e6eb] bg-[#f7f8fa] px-2 sm:px-3" data-sheet-tabs>
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
          className="grid size-7 place-items-center rounded text-[#646a73] hover:bg-[#e9ecf1]"
        >
          <List size={15} />
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

      <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto no-scrollbar">
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
                  className={`group/tab flex h-[34px] max-w-44 items-center gap-1 rounded-t-md border px-3 text-[13px] transition-colors ${
                    active
                      ? "border-[#e5e6eb] border-b-white bg-white font-medium text-[#3370ff]"
                      : "border-transparent bg-transparent text-[#646a73] hover:bg-[#ebedf0]"
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
  onDuplicate?: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleFormatBrush: () => void;
  onClearFormat: () => void;
  onStylePatch: (patch: Partial<SheetCellStyle>) => void;
  onToggleBorder: () => void;
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
  onCollapseToolbar?: () => void;
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
    onDuplicate,
    onUndo,
    onRedo,
    onToggleFormatBrush,
    onClearFormat,
    onStylePatch,
    onToggleBorder,
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
    onCollapseToolbar,
  } = props;

  const [openMenu, setOpenMenu] = useState<"file" | "insert" | "font" | "size" | "color" | "bg" | "numfmt" | "freeze" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [openMenu]);

  const iconBtn = (label: string, active: boolean, disabled: boolean, onClick: () => void, children: React.ReactNode, dataAttr?: string) => (
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

  const labeledBtn = (label: string, active: boolean, disabled: boolean, onClick: () => void, children: React.ReactNode, dataAttr?: string) => (
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

  return (
    <div ref={rootRef} className="relative flex h-14 min-w-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[#e5e6eb] bg-[#f7f8fa] px-2" data-sheet-toolbar>
      <div className="relative shrink-0">
        {labeledBtn(t("菜单"), openMenu === "file", false, () => setOpenMenu((m) => (m === "file" ? null : "file")), <Menu size={15} />)}
        {openMenu === "file" && (
          <div role="menu" className="fixed left-3 top-[148px] z-50 w-44 rounded-md border border-[#dee0e3] bg-white py-1 text-[13px] shadow-lg">
            {canEdit && <button type="button" role="menuitem" disabled={importing} onClick={() => { setOpenMenu(null); onTriggerImport(); }} className="flex h-9 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><FileUp size={14} />{t("导入 XLSX")}</button>}
            {onExport && <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onExport(); }} className="flex h-9 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Download size={14} />{t("导出 XLSX")}</button>}
            {onDuplicate && <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onDuplicate(); }} className="flex h-9 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><MoreHorizontal size={14} />{t("创建副本")}</button>}
          </div>
        )}
      </div>

      {labeledBtn(t("撤销"), false, !canEdit || !canUndo, onUndo, <Undo2 size={15} />, "undo")}
      {labeledBtn(t("重做"), false, !canEdit || !canRedo, onRedo, <Redo2 size={15} />, "redo")}
      {labeledBtn(t("格式刷"), formatBrushActive, !canEdit, onToggleFormatBrush, <Brush size={15} />, "format-brush")}
      {labeledBtn(t("清除格式"), false, !canEdit, onClearFormat, <Eraser size={15} />, "clear-format")}

      <div className="relative shrink-0">
        {labeledBtn(t("插入"), openMenu === "insert", !canEdit, () => setOpenMenu((m) => (m === "insert" ? null : "insert")), <Plus size={15} />)}
        {openMenu === "insert" && (
          <div role="menu" className="fixed z-50 mt-1 w-40 rounded-md border border-[#dee0e3] bg-white py-1 text-[13px] shadow-lg" style={{ left: 180, top: 148 }}>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onInsertRowAbove(); }} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Rows3 size={14} />{t("上方插入行")}</button>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onInsertRowBelow(); }} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Rows3 size={14} />{t("下方插入行")}</button>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onInsertColLeft(); }} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Columns3 size={14} />{t("左侧插入列")}</button>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onInsertColRight(); }} className="flex h-8 w-full items-center gap-2 px-3 hover:bg-[#f2f3f5]"><Columns3 size={14} />{t("右侧插入列")}</button>
            <div className="my-1 border-t border-[#eceef2]" />
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onDeleteRow(); }} className="flex h-8 w-full items-center gap-2 px-3 text-[#d83931] hover:bg-[#fff2f0]"><Trash2 size={14} />{t("删除当前行")}</button>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onDeleteCol(); }} className="flex h-8 w-full items-center gap-2 px-3 text-[#d83931] hover:bg-[#fff2f0]"><Trash2 size={14} />{t("删除当前列")}</button>
          </div>
        )}
      </div>

      <span className="mx-0.5 h-8 w-px shrink-0 bg-[#dee0e3]" />

      <div className="flex shrink-0 flex-col gap-0.5 px-0.5">
        <div className="flex h-6 items-center gap-1 text-[12px] text-[#4b5058]">
          <div className="relative">
            <button
              type="button"
              aria-label={t("字体")}
              disabled={!canEdit}
              onClick={() => setOpenMenu((m) => (m === "font" ? null : "font"))}
              className="flex h-6 w-[88px] items-center justify-between gap-1 rounded px-1.5 text-[12px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span className="truncate">{activeStyle.fontFamily || t("默认字体")}</span>
              <ChevronDown size={11} className="shrink-0 text-[#8f959e]" />
            </button>
            {openMenu === "font" && (
              <div role="menu" className="fixed z-50 w-36 rounded-md border border-[#dee0e3] bg-white py-1 text-[12px] shadow-lg" style={{ top: 148 }}>
                <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onStylePatch({ fontFamily: "" }); }} className={`flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5] ${!activeStyle.fontFamily ? "font-medium text-[#3370ff]" : ""}`}>{t("默认字体")}</button>
                {FONT_FAMILIES.filter(Boolean).map((f) => (
                  <button key={f} type="button" role="menuitem" onClick={() => { setOpenMenu(null); onStylePatch({ fontFamily: f }); }} className={`flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5] ${activeStyle.fontFamily === f ? "font-medium text-[#3370ff]" : ""}`} style={{ fontFamily: f }}>{f}</button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              aria-label={t("字号")}
              disabled={!canEdit}
              onClick={() => setOpenMenu((m) => (m === "size" ? null : "size"))}
              className="flex h-6 w-11 items-center justify-between gap-1 rounded px-1.5 text-[12px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span>{activeStyle.fontSize || 12}</span>
              <ChevronDown size={11} className="shrink-0 text-[#8f959e]" />
            </button>
            {openMenu === "size" && (
              <div role="menu" className="fixed z-50 w-20 rounded-md border border-[#dee0e3] bg-white py-1 text-[12px] shadow-lg" style={{ top: 148 }}>
                {FONT_SIZES.map((sz) => (
                  <button key={sz} type="button" role="menuitem" onClick={() => { setOpenMenu(null); onStylePatch({ fontSize: sz }); }} className={`flex h-7 w-full items-center px-3 text-left hover:bg-[#f2f3f5] ${(activeStyle.fontSize || 12) === sz ? "font-medium text-[#3370ff]" : ""}`}>{sz}</button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {iconBtn(t("粗体"), !!activeStyle.bold, !canEdit, () => onStylePatch({ bold: !activeStyle.bold }), <Bold size={14} />, "bold")}
          {iconBtn(t("删除线"), !!activeStyle.strike, !canEdit, () => onStylePatch({ strike: !activeStyle.strike }), <Strikethrough size={14} />, "strike")}
          {iconBtn(t("斜体"), !!activeStyle.italic, !canEdit, () => onStylePatch({ italic: !activeStyle.italic }), <Italic size={14} />, "italic")}
          {iconBtn(t("下划线"), !!activeStyle.underline, !canEdit, () => onStylePatch({ underline: !activeStyle.underline }), <Underline size={14} />, "underline")}
          <div className="relative">
            {iconBtn(t("字体颜色"), openMenu === "color", !canEdit, () => setOpenMenu((m) => (m === "color" ? null : "color")), <span className="flex flex-col items-center leading-none"><Palette size={13} /><span className="mt-0.5 h-0.5 w-3.5" style={{ backgroundColor: activeStyle.color || "#1f2329" }} /></span>)}
            {openMenu === "color" && (
              <div className="fixed z-50 flex gap-1.5 rounded-md border border-[#dee0e3] bg-white p-2 shadow-lg" style={{ top: 148 }}>
                {TEXT_COLORS.map((hex) => <button key={hex} type="button" aria-label={hex} onClick={() => { setOpenMenu(null); onStylePatch({ color: hex }); }} className="size-5 rounded-full border border-[#dee0e3]" style={{ backgroundColor: hex }} />)}
              </div>
            )}
          </div>
          <div className="relative">
            {iconBtn(t("单元格填充"), openMenu === "bg", !canEdit, () => setOpenMenu((m) => (m === "bg" ? null : "bg")), <Highlighter size={14} />)}
            {openMenu === "bg" && (
              <div className="fixed z-50 flex gap-1.5 rounded-md border border-[#dee0e3] bg-white p-2 shadow-lg" style={{ top: 148 }}>
                {BG_COLORS.map((hex) => <button key={hex || "none"} type="button" aria-label={hex || t("无填充")} onClick={() => { setOpenMenu(null); onStylePatch({ bg: hex }); }} className="size-5 rounded border border-[#dee0e3] text-[10px]" style={{ backgroundColor: hex || "#ffffff" }}>{hex ? "" : "×"}</button>)}
              </div>
            )}
          </div>
          {iconBtn(t("边框"), !!activeStyle.borders, !canEdit, onToggleBorder, <Grid2X2 size={14} />, "borders")}
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
          data-sheet-tool="numfmt"
          onClick={() => setOpenMenu((m) => (m === "numfmt" ? null : "numfmt"))}
          className="flex h-6 shrink-0 items-center justify-between gap-2 rounded px-1.5 text-[12px] text-[#4b5058] enabled:hover:bg-[#e9ecf1] disabled:opacity-45"
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
        {openMenu === "numfmt" && (
          <div role="menu" className="fixed z-50 w-44 rounded-md border border-[#dee0e3] bg-white py-1 text-[12px] shadow-lg" style={{ top: 148 }}>
            {NUM_FORMATS.map((fmt) => (
              <button key={fmt.id} type="button" role="menuitem" onClick={() => { setOpenMenu(null); onStylePatch({ numFmt: fmt.id }); }} className={`flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5] ${activeStyle.numFmt === fmt.id ? "font-medium text-[#3370ff]" : ""}`}>
                {t(fmt.label)}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="mx-0.5 h-8 w-px shrink-0 bg-[#dee0e3]" />

      <div className="relative shrink-0">
        {labeledBtn(t("冻结"), frozenRows > 0 || frozenCols > 0 || openMenu === "freeze", !canEdit, () => setOpenMenu((m) => (m === "freeze" ? null : "freeze")), <PanelTop size={15} />, "freeze")}
        {openMenu === "freeze" && (
          <div role="menu" className="fixed right-24 z-50 w-40 rounded-md border border-[#dee0e3] bg-white py-1 text-[12px] shadow-lg" style={{ top: 148 }}>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onFreezeRows(1, 0); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("冻结首行")}</button>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onFreezeRows(0, 1); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("冻结首列")}</button>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onFreezeRows(1, 1); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("同时冻结首行首列")}</button>
            <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onFreezeRows(0, 0); }} className="flex h-8 w-full items-center px-3 text-left hover:bg-[#f2f3f5]">{t("取消冻结")}</button>
          </div>
        )}
      </div>

      {labeledBtn(t("筛选"), filterEnabled, !canEdit, onToggleFilter, <Filter size={15} />, "filter")}
      {labeledBtn(t("升序"), false, !canEdit, () => onSortCol(true), <ArrowUpAZ size={15} />, "sort-asc")}
      {labeledBtn(t("降序"), false, !canEdit, () => onSortCol(false), <ArrowDownAZ size={15} />, "sort-desc")}
      {labeledBtn(t("查找替换"), false, false, onOpenFind, <Search size={15} />, "find-replace")}

      <span className="mx-0.5 h-8 w-px shrink-0 bg-[#dee0e3]" />

      {labeledBtn(t("图表"), activePanel === "charts", false, () => onTogglePanel("charts"), <BarChart3 size={15} />, "charts")}
      {labeledBtn(t("透视表"), activePanel === "pivot", false, () => onTogglePanel("pivot"), <TableProperties size={15} />, "pivot")}
      {labeledBtn(t("数据验证"), activePanel === "validation", false, () => onTogglePanel("validation"), <ListChecks size={15} />, "validation")}
      {labeledBtn(t("条件格式"), activePanel === "condfmt", false, () => onTogglePanel("condfmt"), <Sparkles size={15} />, "cond-fmt")}
      {labeledBtn(t("保护区域"), activePanel === "protect", false, () => onTogglePanel("protect"), <Lock size={15} />, "protect")}
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
          className="sticky right-0 ml-auto grid size-7 shrink-0 place-items-center rounded bg-[#f7f8fa] text-[#646a73] hover:bg-[#e9ecf1]"
        >
          <ChevronUp size={15} />
        </button>
      )}
    </div>
  );
}
