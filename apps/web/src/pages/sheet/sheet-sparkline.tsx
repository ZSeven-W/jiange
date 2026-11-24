import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";
import { FeishuSelect } from "@/components/feishu-select";
import type { SheetCell, SheetSparkline, SheetSparklineType, SheetWorksheet } from "@/lib/api";
import { t } from "@/lib/i18n";
import { selectionBounds, sheetAddress, type SheetSelection } from "./grid-model";
import { formatSelectionAddress, parseRangeInput, type EvaluatedSheetMap } from "./workbook-engine";

const SPARKLINE_COLORS = ["#3370ff", "#00b42a", "#ff8800", "#f54a45", "#7b56d9", "#1f2329"] as const;
const SPARKLINE_NEG_COLORS = ["#f54a45", "#ff8800", "#8f959e", "#7b56d9"] as const;

function makeSparklineId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `sp-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `sp-${Math.random().toString(36).slice(2, 10)}`;
}

/** Extract live evaluated numeric series for a sparkline's source range (row-major). */
export function extractSparklineValues(
  evalMap: EvaluatedSheetMap,
  cellByKey: ReadonlyMap<string, SheetCell>,
  sp: Pick<SheetSparkline, "sourceTop" | "sourceLeft" | "sourceBottom" | "sourceRight">,
): number[] {
  const out: number[] = [];
  const top = Math.min(sp.sourceTop, sp.sourceBottom);
  const bottom = Math.max(sp.sourceTop, sp.sourceBottom);
  const left = Math.min(sp.sourceLeft, sp.sourceRight);
  const right = Math.max(sp.sourceLeft, sp.sourceRight);
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) {
      const key = `${r}:${c}`;
      const ev = evalMap[key];
      if (ev) {
        if (ev.kind === "number" && Number.isFinite(ev.value)) {
          out.push(ev.value);
          continue;
        }
        if (ev.kind === "string") {
          const parsed = Number(ev.value.trim().replace(/,/g, ""));
          if (ev.value.trim() !== "" && Number.isFinite(parsed)) out.push(parsed);
        }
        continue;
      }
      const raw = cellByKey.get(key)?.raw?.trim() ?? "";
      if (raw && !raw.startsWith("=")) {
        const parsed = Number(raw.replace(/,/g, ""));
        if (Number.isFinite(parsed)) out.push(parsed);
      }
    }
  }
  return out;
}

export interface SheetSparklineSvgProps {
  values: readonly number[];
  type: SheetSparklineType;
  color?: string;
  negativeColor?: string;
  showMarkers?: boolean;
  sparklineId?: string;
  className?: string;
}

/** Pure crisp inline SVG renderer for `line`, `bar`, and `winloss` sparklines. */
export function SheetSparklineSvg({
  values,
  type,
  color,
  negativeColor,
  showMarkers,
  sparklineId,
  className,
}: SheetSparklineSvgProps) {
  const w = 100;
  const h = 24;
  const padX = 3;
  const padY = 3;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const posColor = color || (type === "winloss" ? "#00b42a" : "#3370ff");
  const negColor = negativeColor || "#f54a45";

  if (values.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        data-sheet-sparkline-id={sparklineId}
        data-sheet-sparkline-type={type}
        aria-label={t("迷你图")}
        className={className ?? "block h-full w-full"}
      >
        <line
          x1={padX}
          y1={h / 2}
          x2={w - padX}
          y2={h / 2}
          stroke="#d0d3d6"
          strokeWidth="1"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  if (type === "line") {
    let minVal = Math.min(...values);
    let maxVal = Math.max(...values);
    if (minVal === maxVal) {
      minVal -= 1;
      maxVal += 1;
    }
    const span = maxVal - minVal;
    const pts = values.map((v, i) => {
      const x = values.length === 1 ? w / 2 : padX + (i / (values.length - 1)) * innerW;
      const y = padY + (1 - (v - minVal) / span) * innerH;
      return { x, y, v };
    });
    const polyline = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    const hasZeroCrossing = minVal < 0 && maxVal > 0;
    const zeroY = padY + (1 - (0 - minVal) / span) * innerH;
    const areaPath =
      pts.length > 1
        ? `M ${pts[0].x.toFixed(2)} ${(hasZeroCrossing ? zeroY : h - padY).toFixed(2)} ` +
          pts.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ") +
          ` L ${pts[pts.length - 1].x.toFixed(2)} ${(hasZeroCrossing ? zeroY : h - padY).toFixed(2)} Z`
        : "";

    return (
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        data-sheet-sparkline-id={sparklineId}
        data-sheet-sparkline-type={type}
        aria-label={t("折线图")}
        className={className ?? "block h-full w-full"}
      >
        {hasZeroCrossing && (
          <line
            x1={padX}
            y1={zeroY}
            x2={w - padX}
            y2={zeroY}
            stroke="#dee0e3"
            strokeWidth="0.8"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {areaPath && <path d={areaPath} fill={posColor} fillOpacity="0.1" />}
        {pts.length > 1 && (
          <polyline
            points={polyline}
            fill="none"
            stroke={posColor}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {(showMarkers || pts.length === 1) &&
          pts.map((p, idx) => (
            <circle
              key={idx}
              cx={p.x}
              cy={p.y}
              r={pts.length === 1 ? 2.4 : 1.7}
              fill={p.v < 0 ? negColor : posColor}
            />
          ))}
      </svg>
    );
  }

  if (type === "bar") {
    const minVal = Math.min(0, ...values);
    const maxVal = Math.max(0, ...values);
    const span = maxVal - minVal || 1;
    const zeroY = padY + (maxVal / span) * innerH;
    const gap = Math.min(2, innerW / Math.max(values.length * 4, 1));
    const barW = Math.max(1.2, (innerW - gap * Math.max(0, values.length - 1)) / values.length);

    return (
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        data-sheet-sparkline-id={sparklineId}
        data-sheet-sparkline-type={type}
        aria-label={t("柱状图")}
        className={className ?? "block h-full w-full"}
      >
        {minVal < 0 && (
          <line
            x1={padX}
            y1={zeroY}
            x2={w - padX}
            y2={zeroY}
            stroke="#d0d3d6"
            strokeWidth="0.8"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {values.map((v, i) => {
          const x = padX + i * (barW + gap);
          const valH = Math.max(1.2, (Math.abs(v) / span) * innerH);
          const y = v >= 0 ? zeroY - valH : zeroY;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barW}
              height={valH}
              rx="0.8"
              fill={v < 0 ? negColor : posColor}
            />
          );
        })}
      </svg>
    );
  }

  // winloss
  const midY = h / 2;
  const halfH = innerH / 2 - 1;
  const gap = Math.min(2, innerW / Math.max(values.length * 4, 1));
  const barW = Math.max(1.2, (innerW - gap * Math.max(0, values.length - 1)) / values.length);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      data-sheet-sparkline-id={sparklineId}
      data-sheet-sparkline-type={type}
      aria-label={t("盈亏图")}
      className={className ?? "block h-full w-full"}
    >
      <line
        x1={padX}
        y1={midY}
        x2={w - padX}
        y2={midY}
        stroke="#dee0e3"
        strokeWidth="0.8"
        vectorEffect="non-scaling-stroke"
      />
      {values.map((v, i) => {
        const x = padX + i * (barW + gap);
        if (v === 0) {
          return <rect key={i} x={x} y={midY - 0.6} width={barW} height={1.2} fill="#8f959e" />;
        }
        const y = v > 0 ? midY - halfH : midY + 0.5;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={halfH}
            rx="0.8"
            fill={v > 0 ? posColor : negColor}
          />
        );
      })}
    </svg>
  );
}

export interface SheetSparklinePopoverProps {
  sheet: SheetWorksheet;
  selection: SheetSelection;
  evalMap: EvaluatedSheetMap;
  cellByKey: ReadonlyMap<string, SheetCell>;
  anchorRect: { left: number; bottom: number; top: number; right: number };
  onSaveSparklines: (next: SheetSparkline[]) => Promise<boolean> | void;
  onClose: () => void;
}

export function SheetSparklinePopover({
  sheet,
  selection,
  evalMap,
  cellByKey,
  anchorRect,
  onSaveSparklines,
  onClose,
}: SheetSparklinePopoverProps) {
  const bounds = selectionBounds(selection);
  const existingAtFocus = useMemo(
    () => (sheet.sparklines ?? []).find((sp) => sp.row === selection.focus.row && sp.col === selection.focus.col),
    [sheet.sparklines, selection.focus.row, selection.focus.col],
  );

  const defaultSource = useMemo(() => {
    if (existingAtFocus) {
      return formatSelectionAddress({
        anchor: { row: existingAtFocus.sourceTop, col: existingAtFocus.sourceLeft },
        focus: { row: existingAtFocus.sourceBottom, col: existingAtFocus.sourceRight },
      });
    }
    return formatSelectionAddress(selection);
  }, [existingAtFocus, selection]);

  const defaultTarget = useMemo(() => {
    if (existingAtFocus) {
      return sheetAddress({ row: existingAtFocus.row, col: existingAtFocus.col });
    }
    const isRange = bounds.bottom > bounds.top || bounds.right > bounds.left;
    const nextCol = isRange && bounds.right + 1 < sheet.columns.length ? bounds.right + 1 : bounds.left;
    return sheetAddress({ row: bounds.top, col: nextCol });
  }, [existingAtFocus, bounds.top, bounds.left, bounds.bottom, bounds.right, sheet.columns.length]);

  const [sparkType, setSparkType] = useState<SheetSparklineType>(existingAtFocus?.type ?? "line");
  const [sourceInput, setSourceInput] = useState(defaultSource);
  const [targetInput, setTargetInput] = useState(defaultTarget);
  const [color, setColor] = useState(existingAtFocus?.color || "#3370ff");
  const [negColor, setNegColor] = useState(existingAtFocus?.negativeColor || "#f54a45");
  const [showMarkers, setShowMarkers] = useState(existingAtFocus?.showMarkers ?? false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

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

  const parsedSource = useMemo(() => parseRangeInput(sourceInput), [sourceInput]);
  const previewValues = useMemo(() => {
    if (!parsedSource) return [];
    const sb = selectionBounds(parsedSource);
    return extractSparklineValues(evalMap, cellByKey, {
      sourceTop: sb.top,
      sourceLeft: sb.left,
      sourceBottom: sb.bottom,
      sourceRight: sb.right,
    });
  }, [parsedSource, evalMap, cellByKey]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const popW = Math.min(312, vw - 16);
  const left = Math.max(8, Math.min(anchorRect.left, vw - popW - 8));
  const top = anchorRect.bottom + 6 + 380 <= vh ? anchorRect.bottom + 6 : Math.max(8, vh - 390);

  const handleApply = async () => {
    const src = parseRangeInput(sourceInput);
    const tgt = parseRangeInput(targetInput);
    if (!src) {
      setError(t("数据区域格式无效，请使用如 A1:D6 的格式"));
      return;
    }
    if (!tgt || tgt.anchor.row !== tgt.focus.row || tgt.anchor.col !== tgt.focus.col) {
      setError(t("目标单元格格式无效，请使用如 E1 的格式"));
      return;
    }
    const sb = selectionBounds(src);
    const maxRow = sheet.rows.length - 1;
    const maxCol = sheet.columns.length - 1;
    if (
      sb.top < 0 || sb.left < 0 || sb.bottom > maxRow || sb.right > maxCol ||
      tgt.anchor.row < 0 || tgt.anchor.row > maxRow || tgt.anchor.col < 0 || tgt.anchor.col > maxCol
    ) {
      setError(t("所选区域超出当前工作表范围"));
      return;
    }
    setError("");
    setSaving(true);
    try {
      const existing = sheet.sparklines ?? [];
      const replaced = existing.filter((sp) => !(sp.row === tgt.anchor.row && sp.col === tgt.anchor.col));
      const nextItem: SheetSparkline = {
        id: existingAtFocus && existingAtFocus.row === tgt.anchor.row && existingAtFocus.col === tgt.anchor.col
          ? existingAtFocus.id
          : makeSparklineId(),
        row: tgt.anchor.row,
        col: tgt.anchor.col,
        sourceTop: sb.top,
        sourceLeft: sb.left,
        sourceBottom: sb.bottom,
        sourceRight: sb.right,
        type: sparkType,
        color,
        ...(sparkType !== "line" ? { negativeColor: negColor } : {}),
        ...(sparkType === "line" && showMarkers ? { showMarkers: true } : {}),
      };
      const ok = await onSaveSparklines([...replaced, nextItem]);
      if (ok !== false) onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setSaving(true);
    try {
      const next = (sheet.sparklines ?? []).filter((sp) => sp.id !== id);
      await onSaveSparklines(next);
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("插入迷你图")}
      data-sheet-sparkline-popover
      style={{ left, top, width: popW }}
      className="fixed z-[125] rounded-lg border border-[#dee0e3] bg-white p-3 text-[12px] text-[#1f2329] shadow-[0_8px_28px_rgba(31,35,41,0.16)]"
    >
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[13px] font-semibold">{t("插入迷你图")}</span>
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
        <div className="flex items-center justify-between gap-2">
          <label className="shrink-0 text-[#646a73]">{t("迷你图类型")}</label>
          <FeishuSelect
            value={sparkType}
            onChange={(v) => setSparkType(v as SheetSparklineType)}
            ariaLabel={t("迷你图类型")}
            className="h-7 w-[170px] border border-[#dee0e3] bg-white text-[12px]"
            options={[
              { value: "line", label: t("折线图") },
              { value: "bar", label: t("柱状图") },
              { value: "winloss", label: t("盈亏图") },
            ]}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <label className="shrink-0 text-[#646a73]">{t("数据区域")}</label>
          <input
            type="text"
            value={sourceInput}
            onChange={(e) => setSourceInput(e.target.value)}
            placeholder="A1:D1"
            data-sheet-sparkline-source
            className="h-7 w-[170px] rounded border border-[#dee0e3] px-2 text-[12px] outline-none focus:border-[#3370ff]"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <label className="shrink-0 text-[#646a73]">{t("目标单元格")}</label>
          <input
            type="text"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
            placeholder="E1"
            data-sheet-sparkline-target
            className="h-7 w-[170px] rounded border border-[#dee0e3] px-2 text-[12px] outline-none focus:border-[#3370ff]"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[#646a73]">{t("主色")}</span>
          <div className="flex items-center gap-1.5">
            {SPARKLINE_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={hex}
                onClick={() => setColor(hex)}
                className={`size-4 rounded-full border transition-transform ${
                  color === hex ? "scale-110 border-[#3370ff] ring-2 ring-[#3370ff]/30" : "border-[#dee0e3]"
                }`}
                style={{ backgroundColor: hex }}
              />
            ))}
          </div>
        </div>

        {sparkType !== "line" && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#646a73]">{t("负值颜色")}</span>
            <div className="flex items-center gap-1.5">
              {SPARKLINE_NEG_COLORS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  aria-label={hex}
                  onClick={() => setNegColor(hex)}
                  className={`size-4 rounded-full border transition-transform ${
                    negColor === hex ? "scale-110 border-[#3370ff] ring-2 ring-[#3370ff]/30" : "border-[#dee0e3]"
                  }`}
                  style={{ backgroundColor: hex }}
                />
              ))}
            </div>
          </div>
        )}

        {sparkType === "line" && (
          <label className="flex cursor-pointer items-center gap-2 text-[#4b5058]">
            <input
              type="checkbox"
              checked={showMarkers}
              onChange={(e) => setShowMarkers(e.target.checked)}
              className="rounded border-[#c9cdd4] accent-[#3370ff]"
            />
            <span>{t("显示数据点标记")}</span>
          </label>
        )}

        <div className="rounded border border-[#eff0f1] bg-[#fafbfc] px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between text-[11px] text-[#8f959e]">
            <span>{t("实时预览")}</span>
            <span>{t("{count} 个数值", { count: previewValues.length })}</span>
          </div>
          <div className="h-7 w-full">
            <SheetSparklineSvg
              values={previewValues.length > 0 ? previewValues : [12, 28, 19, 36, 24, 42]}
              type={sparkType}
              color={color}
              negativeColor={negColor}
              showMarkers={showMarkers}
            />
          </div>
        </div>

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
            disabled={saving}
            data-sheet-sparkline-save
            onClick={() => void handleApply()}
            className="h-7 rounded bg-[#3370ff] px-3 text-[12px] font-medium text-white hover:bg-[#245bdb] disabled:opacity-50"
          >
            {t("保存迷你图")}
          </button>
        </div>

        {(sheet.sparklines?.length ?? 0) > 0 && (
          <div className="mt-2 border-t border-[#eff0f1] pt-2">
            <div className="mb-1 text-[11px] font-medium text-[#646a73]">
              {t("当前工作表迷你图 ({count})", { count: sheet.sparklines?.length ?? 0 })}
            </div>
            <div className="max-h-28 space-y-1 overflow-y-auto">
              {(sheet.sparklines ?? []).map((sp) => (
                <div
                  key={sp.id}
                  className="flex items-center justify-between rounded bg-[#f5f6f7] px-2 py-1 text-[11px]"
                >
                  <span className="truncate text-[#1f2329]">
                    {sheetAddress({ row: sp.row, col: sp.col })} ←{" "}
                    {formatSelectionAddress({
                      anchor: { row: sp.sourceTop, col: sp.sourceLeft },
                      focus: { row: sp.sourceBottom, col: sp.sourceRight },
                    })}
                  </span>
                  <button
                    type="button"
                    aria-label={t("删除迷你图")}
                    disabled={saving}
                    onClick={() => void handleDelete(sp.id)}
                    className="ml-2 grid size-5 shrink-0 place-items-center rounded text-[#8f959e] hover:bg-[#ffece8] hover:text-[#d83931]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
