import { useEffect, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  BringToFront,
  ChevronDown,
  ChevronUp,
  Crop,
  Film,
  Group,
  RotateCcw,
  SendToBack,
  Trash2,
  Ungroup,
  Volume2,
} from "lucide-react";
import type { SlideShape } from "@/lib/api";
import { FeishuSelect } from "@/components/feishu-select";
import { useI18n } from "@/lib/i18n";
import { isSafeSlideMediaUrl } from "./slides-master";
import type { ShapeAlignment, ShapeOrderAction } from "./slides-shape-order";

type CropRect = NonNullable<SlideShape["crop"]>;

const round2 = (n: number) => Math.round(n * 100) / 100;
const clampRange = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export const SLIDE_CROP_PRESETS: ReadonlyArray<{ id: string; label: string; crop: CropRect | undefined }> = [
  { id: "free", label: "自由", crop: undefined },
  { id: "16:9", label: "16:9", crop: { x: 0, y: 0.22, w: 1, h: 0.56 } },
  { id: "4:3", label: "4:3", crop: { x: 0, y: 0.12, w: 1, h: 0.75 } },
  { id: "1:1", label: "1:1", crop: { x: 0.22, y: 0, w: 0.56, h: 1 } },
];

export function updateImageCropField(
  current: CropRect | undefined,
  field: "x" | "y" | "w" | "h",
  rawVal: number,
): CropRect {
  const base: CropRect = current ?? { x: 0, y: 0, w: 1, h: 1 };
  let { x, y, w, h } = base;
  if (field === "x") {
    x = round2(clampRange(rawVal, 0, 0.9));
    w = round2(clampRange(Math.min(w, 1 - x), 0.1, 1 - x));
  } else if (field === "y") {
    y = round2(clampRange(rawVal, 0, 0.9));
    h = round2(clampRange(Math.min(h, 1 - y), 0.1, 1 - y));
  } else if (field === "w") {
    w = round2(clampRange(rawVal, 0.1, 1));
    x = round2(clampRange(Math.min(x, 1 - w), 0, 1 - w));
  } else {
    h = round2(clampRange(rawVal, 0.1, 1));
    y = round2(clampRange(Math.min(y, 1 - h), 0, 1 - h));
  }
  return { x, y, w, h };
}

/** Percentages are measured against the slide, not the browser viewport. */
export function SlideShapeControls({ shape, onChange, onDelete, onOrder, onAlign, defaultCropOpen = false }: { shape: SlideShape; onChange: (patch: Partial<SlideShape>) => void; onDelete: () => void; onOrder: (action: ShapeOrderAction) => void; onAlign: (alignment: ShapeAlignment) => void; defaultCropOpen?: boolean; }) {
  const { t } = useI18n();
  const text = shape.kind === "text";
  const image = shape.kind === "image";
  const video = shape.kind === "video";
  const audio = shape.kind === "audio";
  const media = video || audio;

  const [cropOpen, setCropOpen] = useState(image && defaultCropOpen);
  const [mediaOpen, setMediaOpen] = useState(media && !shape.mediaUrl);
  const [mediaUrlInput, setMediaUrlInput] = useState(shape.mediaUrl ?? "");
  const [posterUrlInput, setPosterUrlInput] = useState(shape.posterUrl ?? "");

  useEffect(() => {
    setCropOpen(false);
    setMediaOpen((shape.kind === "video" || shape.kind === "audio") && !shape.mediaUrl);
    setMediaUrlInput(shape.mediaUrl ?? "");
    setPosterUrlInput(shape.posterUrl ?? "");
  }, [shape.id, shape.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if ((shape.mediaUrl ?? "") !== mediaUrlInput && isSafeSlideMediaUrl(mediaUrlInput.trim())) {
      setMediaUrlInput(shape.mediaUrl ?? "");
    }
  }, [shape.mediaUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if ((shape.posterUrl ?? "") !== posterUrlInput && isSafeSlideMediaUrl(posterUrlInput.trim())) {
      setPosterUrlInput(shape.posterUrl ?? "");
    }
  }, [shape.posterUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeCrop: CropRect = shape.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const hasActiveCrop = Boolean(
    shape.crop && (shape.crop.x > 0 || shape.crop.y > 0 || shape.crop.w < 0.999 || shape.crop.h < 0.999),
  );
  const mediaUrlSafe = isSafeSlideMediaUrl(mediaUrlInput.trim());
  const posterUrlSafe = isSafeSlideMediaUrl(posterUrlInput.trim());

  const controls = [
    { name: "宽度", label: "图形宽度", value: shape.width ?? 16, min: 5, max: 100, unit: "%", set: (n: number) => ({ width: n }) },
    { name: "高度", label: "图形高度", value: shape.height ?? 20, min: 5, max: 100, unit: "%", set: (n: number) => ({ height: n }) },
    { name: "旋转", label: "图形旋转角度", value: shape.rotation ?? 0, min: 0, max: 359, unit: "°", set: (n: number) => ({ rotation: n }) },
  ];
  const orders: [ShapeOrderAction, string, typeof BringToFront][] = [["front", "置于顶层", BringToFront], ["forward", "上移一层", ChevronUp], ["backward", "下移一层", ChevronDown], ["back", "置于底层", SendToBack]];
  const alignments: [ShapeAlignment, string, typeof BringToFront][] = [["left", "左对齐到页面", AlignStartHorizontal], ["hcenter", "水平居中到页面", AlignCenterHorizontal], ["right", "右对齐到页面", AlignEndHorizontal], ["top", "顶对齐到页面", AlignStartVertical], ["vcenter", "垂直居中到页面", AlignCenterVertical], ["bottom", "底对齐到页面", AlignEndVertical]];
  const groupAriaLabel = text
    ? "文本框格式"
    : image
      ? "图片格式"
      : video
        ? t("视频格式")
        : audio
          ? t("音频格式")
          : "图形格式";
  const deleteLabel = text
    ? "删除文本框"
    : image
      ? "删除图片"
      : video
        ? t("删除视频")
        : audio
          ? t("删除音频")
          : "删除图形";

  return (
    <div
      className="pointer-events-none absolute left-1/2 top-2.5 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-col items-center gap-1.5"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="pointer-events-auto flex max-w-full items-center gap-1.5 overflow-x-auto whitespace-nowrap rounded-lg border border-[#dee0e3] bg-white/95 px-2.5 py-1 text-[12px] text-[#4e5969] shadow-[0_4px_16px_rgba(31,35,41,0.12)] backdrop-blur-xs [&>*]:shrink-0"
        role="group"
        aria-label={groupAriaLabel}
      >
        {!image && !media && (
          <label className="relative flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-[#f2f3f5]" title={text ? "文字颜色" : "图形颜色"}>
            <span>颜色</span>
            <span className="size-4 rounded border border-[#d0d3d6] shadow-2xs" style={{ backgroundColor: shape.color }} />
            <input type="color" aria-label={text ? "文字颜色" : "图形颜色"} value={shape.color} onChange={(event) => onChange({ color: event.target.value })} className="sr-only" />
          </label>
        )}
        {image && (
          <button
            type="button"
            data-slides-crop-toggle
            aria-label={t("裁剪图片")}
            aria-pressed={cropOpen}
            title={t("裁剪图片")}
            onClick={() => setCropOpen((prev) => !prev)}
            className={`inline-flex h-6 items-center gap-1 rounded px-1.5 transition-colors ${
              cropOpen || hasActiveCrop
                ? "bg-[#e8efff] font-medium text-[#3370ff]"
                : "text-[#4e5969] hover:bg-[#f2f3f5]"
            }`}
          >
            <Crop size={13} />
            <span>{t("裁剪图片")}</span>
          </button>
        )}
        {media && (
          <>
            <button
              type="button"
              data-slides-media-toggle
              aria-label={video ? t("视频设置") : t("音频设置")}
              aria-pressed={mediaOpen}
              onClick={() => setMediaOpen((prev) => !prev)}
              className={`inline-flex h-6 items-center gap-1 rounded px-1.5 transition-colors ${
                mediaOpen ? "bg-[#e8efff] font-medium text-[#3370ff]" : "text-[#4e5969] hover:bg-[#f2f3f5]"
              }`}
            >
              {video ? <Film size={13} /> : <Volume2 size={13} />}
              <span>{t("媒体链接")}</span>
            </button>
            <button
              type="button"
              data-slides-media-autoplay
              aria-pressed={!!shape.autoplay}
              onClick={() => onChange({ autoplay: !shape.autoplay })}
              className={`h-6 rounded px-1.5 text-[12px] transition-colors ${
                shape.autoplay ? "bg-[#e8efff] font-medium text-[#3370ff]" : "text-[#4e5969] hover:bg-[#f2f3f5]"
              }`}
            >
              {t("自动播放")}
            </button>
            <button
              type="button"
              data-slides-media-loop
              aria-pressed={!!shape.loop}
              onClick={() => onChange({ loop: !shape.loop })}
              className={`h-6 rounded px-1.5 text-[12px] transition-colors ${
                shape.loop ? "bg-[#e8efff] font-medium text-[#3370ff]" : "text-[#4e5969] hover:bg-[#f2f3f5]"
              }`}
            >
              {t("循环播放")}
            </button>
          </>
        )}
        {text && (
          <>
            <label className="flex items-center gap-1">
              字号
              <input type="number" aria-label="文字字号" min={12} max={96} value={shape.fontSize ?? 24} onChange={(event) => { const n = event.target.valueAsNumber; if (Number.isFinite(n)) onChange({ fontSize: Math.max(12, Math.min(96, n)) }); }} className="h-6 w-11 rounded border border-[#d0d3d6] px-1 text-[12px] outline-none focus:border-[#3370ff]" />
            </label>
            <button type="button" aria-label="加粗文字" aria-pressed={!!shape.bold} onClick={() => onChange({ bold: !shape.bold })} className={`grid size-6 place-items-center rounded font-bold ${shape.bold ? "bg-[#e8efff] text-[#3370ff]" : "hover:bg-[#f2f3f5]"}`}>B</button>
            <FeishuSelect
              ariaLabel="文字对齐"
              title="文字对齐"
              value={shape.align ?? "left"}
              options={[{ value: "left", label: "左对齐" }, { value: "center", label: "居中" }, { value: "right", label: "右对齐" }]}
              onChange={(val) => onChange({ align: val as "left" | "center" | "right" })}
              className="h-6 border border-[#d0d3d6] px-1.5 text-[12px]"
              chevronSize={11}
              menuMinWidth={80}
            />
          </>
        )}
        <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
        {controls.map((control) => (
          <label key={control.label} className="flex items-center gap-1">
            <span className="text-[#646a73]">{control.name}</span>
            <input type="range" aria-label={control.label} min={control.min} max={control.max} step="1" value={control.value} onChange={(event) => onChange(control.set(Number(event.target.value)))} className="h-1 w-10 cursor-pointer accent-[#3370ff]" />
            <span className="w-7 text-right text-[11px] tabular-nums text-[#4e5969]">{control.value}{control.unit}</span>
          </label>
        ))}
        <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
        <div className="flex items-center gap-0.5" role="group" aria-label="对象层级">{orders.map(([action, label, Icon]) => <button key={action} type="button" aria-label={label} title={label} onClick={() => onOrder(action)} className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Icon size={13} /></button>)}</div>
        <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
        <div className="flex items-center gap-0.5" role="group" aria-label="对象对齐到页面">{alignments.map(([alignment, label, Icon]) => <button key={alignment} type="button" aria-label={label} title={label} onClick={() => onAlign(alignment)} className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"><Icon size={13} /></button>)}</div>
        <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
        <button type="button" onClick={onDelete} title={deleteLabel} aria-label={deleteLabel} className="flex h-6 items-center gap-1 rounded px-1.5 text-[#d83931] hover:bg-[#fff2f0]"><Trash2 size={13} /><span>删除</span></button>
      </div>

      {image && cropOpen && (
        <div
          data-slides-crop-panel
          role="group"
          aria-label={t("图片裁剪参数")}
          className="pointer-events-auto w-[340px] max-w-full rounded-xl border border-[#dee0e3] bg-white/98 p-3 text-[12px] text-[#1f2329] shadow-[0_8px_24px_rgba(31,35,41,0.16)] backdrop-blur-xs"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-medium text-[#1f2329]">{t("裁剪比例")}</span>
            <div className="flex items-center gap-1">
              {SLIDE_CROP_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  data-slides-crop-preset={preset.id}
                  onClick={() => onChange({ crop: preset.crop })}
                  className="h-6 rounded border border-[#dee0e3] px-2 text-[11px] text-[#4e5969] hover:border-[#3370ff] hover:bg-[#edf2ff] hover:text-[#3370ff]"
                >
                  {preset.id === "free" ? t(preset.label) : preset.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {(
              [
                { field: "x", label: t("左偏移"), value: activeCrop.x, min: 0, max: 0.9 },
                { field: "y", label: t("上偏移"), value: activeCrop.y, min: 0, max: 0.9 },
                { field: "w", label: t("裁剪宽度"), value: activeCrop.w, min: 0.1, max: 1 },
                { field: "h", label: t("裁剪高度"), value: activeCrop.h, min: 0.1, max: 1 },
              ] as const
            ).map((item) => (
              <label key={item.field} className="flex flex-col gap-0.5">
                <span className="flex items-center justify-between text-[11px] text-[#646a73]">
                  <span>{item.label}</span>
                  <span className="tabular-nums text-[#1f2329]">{Math.round(item.value * 100)}%</span>
                </span>
                <input
                  type="range"
                  aria-label={item.label}
                  data-slides-crop-slider={item.field}
                  min={item.min}
                  max={item.max}
                  step={0.01}
                  value={item.value}
                  onChange={(event) => {
                    const next = updateImageCropField(shape.crop, item.field, Number(event.target.value));
                    onChange({ crop: next });
                  }}
                  className="h-1.5 w-full cursor-pointer accent-[#3370ff]"
                />
              </label>
            ))}
          </div>
          <div className="mt-2.5 flex justify-end border-t border-[#e5e6eb] pt-2">
            <button
              type="button"
              data-slides-crop-reset
              disabled={!hasActiveCrop}
              onClick={() => onChange({ crop: undefined })}
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] text-[#4e5969] hover:bg-[#f2f3f5] disabled:opacity-40"
            >
              <RotateCcw size={11} />
              <span>{t("重置裁剪")}</span>
            </button>
          </div>
        </div>
      )}

      {media && mediaOpen && (
        <div
          data-slides-media-panel
          role="group"
          aria-label={video ? t("视频媒体设置") : t("音频媒体设置")}
          className="pointer-events-auto w-[360px] max-w-full space-y-2 rounded-xl border border-[#dee0e3] bg-white/98 p-3 text-[12px] text-[#1f2329] shadow-[0_8px_24px_rgba(31,35,41,0.16)] backdrop-blur-xs"
        >
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[#4e5969]">
              {video ? t("视频链接") : t("音频链接")}
            </span>
            <input
              type="text"
              maxLength={2048}
              data-slides-media-url-input
              aria-label={video ? t("视频链接") : t("音频链接")}
              value={mediaUrlInput}
              placeholder="https://... /api/files/..."
              onChange={(event) => {
                const next = event.target.value;
                setMediaUrlInput(next);
                const trimmed = next.trim();
                if (isSafeSlideMediaUrl(trimmed)) {
                  onChange({ mediaUrl: trimmed });
                }
              }}
              className={`h-7 w-full rounded-md border bg-white px-2 text-[12px] outline-none ${
                mediaUrlSafe ? "border-[#dee0e3] focus:border-[#3370ff]" : "border-[#f54a45]"
              }`}
            />
            {!mediaUrlSafe && (
              <p role="alert" className="mt-0.5 text-[11px] text-[#d83931]">
                {t("仅支持 https://、http:// 或 /api/files/ 链接")}
              </p>
            )}
          </label>
          {video && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-[#4e5969]">
                {t("封面图链接（可选）")}
              </span>
              <input
                type="text"
                maxLength={2048}
                data-slides-poster-url-input
                aria-label={t("封面图链接（可选）")}
                value={posterUrlInput}
                placeholder="https://... /api/files/..."
                onChange={(event) => {
                  const next = event.target.value;
                  setPosterUrlInput(next);
                  const trimmed = next.trim();
                  if (isSafeSlideMediaUrl(trimmed)) {
                    onChange({ posterUrl: trimmed || undefined });
                  }
                }}
                className={`h-7 w-full rounded-md border bg-white px-2 text-[12px] outline-none ${
                  posterUrlSafe ? "border-[#dee0e3] focus:border-[#3370ff]" : "border-[#f54a45]"
                }`}
              />
              {!posterUrlSafe && (
                <p role="alert" className="mt-0.5 text-[11px] text-[#d83931]">
                  {t("仅支持 https://、http:// 或 /api/files/ 链接")}
                </p>
              )}
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/** Floating Feishu pill for multi-selected / grouped slide objects (zero canvas zoom jump). */
export function SlideMultiShapeControls({
  count,
  grouped,
  onGroup,
  onUngroup,
  onAlign,
  onDistributeHorizontal,
  onDistributeVertical,
  onDelete,
}: {
  count: number;
  grouped: boolean;
  onGroup: () => void;
  onUngroup: () => void;
  onAlign: (alignment: ShapeAlignment) => void;
  onDistributeHorizontal: () => void;
  onDistributeVertical: () => void;
  onDelete: () => void;
}) {
  const alignments: [ShapeAlignment, string, typeof AlignStartHorizontal][] = [
    ["left", "左对齐", AlignStartHorizontal],
    ["hcenter", "水平居中", AlignCenterHorizontal],
    ["right", "右对齐", AlignEndHorizontal],
    ["top", "顶对齐", AlignStartVertical],
    ["vcenter", "垂直居中", AlignCenterVertical],
    ["bottom", "底对齐", AlignEndVertical],
  ];
  const canDistribute = count >= 3;
  return (
    <div
      data-slides-multi-controls
      role="group"
      aria-label="多选对象操作"
      onPointerDown={(e) => e.stopPropagation()}
      className="pointer-events-auto absolute left-1/2 top-2.5 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1.5 overflow-x-auto whitespace-nowrap rounded-lg border border-[#dee0e3] bg-white/95 px-2.5 py-1 text-[12px] text-[#4e5969] shadow-[0_4px_16px_rgba(31,35,41,0.12)] backdrop-blur-xs [&>*]:shrink-0"
    >
      <span className="rounded bg-[#e8efff] px-1.5 py-0.5 text-[11px] font-medium text-[#3370ff]">
        已选 {count} 项
      </span>
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      {grouped ? (
        <button
          type="button"
          aria-label="取消编组"
          title="取消编组"
          onClick={onUngroup}
          className="inline-flex h-6 items-center gap-1 rounded bg-[#e8efff] px-1.5 font-medium text-[#3370ff] hover:bg-[#d8e5ff]"
        >
          <Ungroup size={13} />
          <span>取消编组</span>
        </button>
      ) : (
        <button
          type="button"
          aria-label="编组"
          title="编组"
          onClick={onGroup}
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[#4e5969] hover:bg-[#f2f3f5]"
        >
          <Group size={13} />
          <span>编组</span>
        </button>
      )}
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <div className="flex items-center gap-0.5" role="group" aria-label="多选对齐">
        {alignments.map(([alignment, label, Icon]) => (
          <button
            key={alignment}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => onAlign(alignment)}
            className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5]"
          >
            <Icon size={13} />
          </button>
        ))}
      </div>
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <div className="flex items-center gap-0.5" role="group" aria-label="等距分布">
        <button
          type="button"
          aria-label="水平等距分布"
          title={canDistribute ? "水平等距分布" : "水平等距分布（需选中至少 3 项）"}
          disabled={!canDistribute}
          onClick={onDistributeHorizontal}
          className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-35"
        >
          <AlignHorizontalSpaceAround size={13} />
        </button>
        <button
          type="button"
          aria-label="垂直等距分布"
          title={canDistribute ? "垂直等距分布" : "垂直等距分布（需选中至少 3 项）"}
          disabled={!canDistribute}
          onClick={onDistributeVertical}
          className="grid size-6 place-items-center rounded text-[#646a73] hover:bg-[#f2f3f5] disabled:opacity-35"
        >
          <AlignVerticalSpaceAround size={13} />
        </button>
      </div>
      <span className="h-4 w-px bg-[#e5e6eb]" aria-hidden="true" />
      <button
        type="button"
        onClick={onDelete}
        title="批量删除"
        aria-label="批量删除"
        className="flex h-6 items-center gap-1 rounded px-1.5 text-[#d83931] hover:bg-[#fff2f0]"
      >
        <Trash2 size={13} />
        <span>批量删除</span>
      </button>
    </div>
  );
}
