import {
  COND_FMT_OPS,
  COND_FMT_PRESETS,
  evaluateSheetConditionalFormat as sdkEvaluateSheetConditionalFormat,
  evaluateSheetValidation,
  findSheetDropdown,
  formatSheetRectA1,
  isSheetCellProtected,
  makeRuleId,
  pointInSheetRect,
  type CondFormatPreset,
  type CondFormatStyle,
  type ValidationEvalResult,
} from "@jiange/sheet-sdk/rules";
import type {
  EvalValue,
  SheetCell,
  SheetConditionalFormat,
  SheetRect,
} from "@jiange/sheet-sdk/types";

export {
  COND_FMT_OPS,
  COND_FMT_PRESETS,
  evaluateSheetValidation,
  findSheetDropdown,
  formatSheetRectA1,
  isSheetCellProtected,
  makeRuleId,
  pointInSheetRect,
};
export type { CondFormatPreset, CondFormatStyle, SheetRect, ValidationEvalResult };

export type DataBarPresetId = "blue" | "green" | "orange" | "purple";
export type ColorScalePresetId = "gyr" | "ryg" | "blue";

export interface DataBarPreset {
  id: DataBarPresetId;
  label: string;
  barColor: string;
  fillColor: string;
}

export interface ColorScalePreset {
  id: ColorScalePresetId;
  label: string;
  low: string;
  mid: string;
  high: string;
}

export const DATA_BAR_PRESETS: readonly DataBarPreset[] = [
  { id: "blue", label: "蓝色数据条", barColor: "#3370ff", fillColor: "rgba(51, 112, 255, 0.22)" },
  { id: "green", label: "绿色数据条", barColor: "#00b42a", fillColor: "rgba(0, 180, 42, 0.22)" },
  { id: "orange", label: "橙色数据条", barColor: "#ff8800", fillColor: "rgba(255, 136, 0, 0.24)" },
  { id: "purple", label: "紫色数据条", barColor: "#7b56d9", fillColor: "rgba(123, 86, 217, 0.22)" },
];

export const COLOR_SCALE_PRESETS: readonly ColorScalePreset[] = [
  { id: "gyr", label: "绿-黄-红色阶", low: "#fecaca", mid: "#fef08a", high: "#bbf7d0" },
  { id: "ryg", label: "红-黄-绿色阶", low: "#bbf7d0", mid: "#fef08a", high: "#fecaca" },
  { id: "blue", label: "白-蓝色阶", low: "#f5f8ff", mid: "#c7dbff", high: "#85b2ff" },
];

const VISUAL_CF_PREFIX = "__cf_visual__:";

export type ParsedVisualCondFormat =
  | { kind: "dataBar"; preset: DataBarPreset }
  | { kind: "colorScale"; preset: ColorScalePreset };

export interface VisualCondFormatRangeBounds {
  min: number;
  max: number;
  count: number;
}

export interface VisualCondFormatResult {
  dataBar?: {
    percent: number;
    barColor: string;
    fillColor: string;
    presetId: DataBarPresetId;
  };
  colorScaleBg?: string;
  colorScalePresetId?: ColorScalePresetId;
}

export function buildDataBarRule(rect: SheetRect, presetId: DataBarPresetId = "blue"): SheetConditionalFormat {
  return {
    id: makeRuleId("cf"),
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
    op: "not_empty",
    value1: `${VISUAL_CF_PREFIX}dataBar:${presetId}`,
  };
}

export function buildColorScaleRule(rect: SheetRect, presetId: ColorScalePresetId = "gyr"): SheetConditionalFormat {
  return {
    id: makeRuleId("cf"),
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
    op: "not_empty",
    value1: `${VISUAL_CF_PREFIX}colorScale:${presetId}`,
  };
}

export function parseVisualCondFormat(rule: SheetConditionalFormat): ParsedVisualCondFormat | null {
  const v1 = (rule.value1 ?? "").trim();
  if (v1.startsWith(VISUAL_CF_PREFIX)) {
    const rest = v1.slice(VISUAL_CF_PREFIX.length);
    const [kind, presetId] = rest.split(":");
    if (kind === "dataBar") {
      const preset = DATA_BAR_PRESETS.find((p) => p.id === presetId) ?? DATA_BAR_PRESETS[0];
      return { kind: "dataBar", preset };
    }
    if (kind === "colorScale") {
      const preset = COLOR_SCALE_PRESETS.find((p) => p.id === presetId) ?? COLOR_SCALE_PRESETS[0];
      return { kind: "colorScale", preset };
    }
  }
  const opStr = rule.op as string;
  if (opStr === "dataBar") {
    const preset = DATA_BAR_PRESETS.find((p) => p.id === v1) ?? DATA_BAR_PRESETS[0];
    return { kind: "dataBar", preset };
  }
  if (opStr === "colorScale") {
    const preset = COLOR_SCALE_PRESETS.find((p) => p.id === v1) ?? COLOR_SCALE_PRESETS[0];
    return { kind: "colorScale", preset };
  }
  return null;
}

function extractNumericValue(raw: string, ev: EvalValue | undefined): number | null {
  if (ev) {
    if (ev.kind === "number") return Number.isFinite(ev.value) ? ev.value : null;
    if (ev.kind === "array") return extractNumericValue(raw, ev.value[0]?.[0]);
    if (ev.kind === "string") {
      const trimmed = ev.value.trim();
      if (!trimmed) return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return [Number.isFinite(r) ? r : 255, Number.isFinite(g) ? g : 255, Number.isFinite(b) ? b : 255];
}

function toHexRgb(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

export function interpolateColorScaleHex(ratio: number, preset: ColorScalePreset): string {
  const t = Math.max(0, Math.min(1, ratio));
  const [r1, g1, b1] = parseHexRgb(t <= 0.5 ? preset.low : preset.mid);
  const [r2, g2, b2] = parseHexRgb(t <= 0.5 ? preset.mid : preset.high);
  const localT = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
  return toHexRgb(r1 + (r2 - r1) * localT, g1 + (g2 - g1) * localT, b1 + (b2 - b1) * localT);
}

export function computeVisualCondFormatBounds(
  rules: readonly SheetConditionalFormat[] | undefined,
  cellByKey: ReadonlyMap<string, Pick<SheetCell, "raw">>,
  evalMap: Readonly<Record<string, EvalValue | undefined>>,
): Map<string, VisualCondFormatRangeBounds> {
  const result = new Map<string, VisualCondFormatRangeBounds>();
  if (!rules || rules.length === 0) return result;
  for (const rule of rules) {
    if (!parseVisualCondFormat(rule)) continue;
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (let r = rule.top; r <= rule.bottom; r++) {
      for (let c = rule.left; c <= rule.right; c++) {
        const key = `${r}:${c}`;
        const raw = cellByKey.get(key)?.raw ?? "";
        const num = extractNumericValue(raw, evalMap[key]);
        if (num === null) continue;
        if (num < min) min = num;
        if (num > max) max = num;
        count++;
      }
    }
    if (count > 0) {
      result.set(rule.id, { min, max, count });
    }
  }
  return result;
}

export function evaluateSheetConditionalFormat(
  raw: string,
  ev: EvalValue | undefined,
  rules: readonly SheetConditionalFormat[] | undefined,
  row: number,
  col: number,
): CondFormatStyle | null {
  if (!rules || rules.length === 0) return null;
  const standardRules = rules.filter((r) => !parseVisualCondFormat(r));
  if (standardRules.length === 0) return null;
  return sdkEvaluateSheetConditionalFormat(raw, ev, standardRules, row, col);
}

export function evaluateSheetVisualCondFormat(
  raw: string,
  ev: EvalValue | undefined,
  rules: readonly SheetConditionalFormat[] | undefined,
  row: number,
  col: number,
  boundsByRuleId: ReadonlyMap<string, VisualCondFormatRangeBounds>,
): VisualCondFormatResult | null {
  if (!rules || rules.length === 0) return null;
  let numCached: number | null | undefined;
  let dataBar: VisualCondFormatResult["dataBar"];
  let colorScaleBg: string | undefined;
  let colorScalePresetId: ColorScalePresetId | undefined;

  for (const rule of rules) {
    const parsed = parseVisualCondFormat(rule);
    if (!parsed || !pointInSheetRect(row, col, rule)) continue;
    const bounds = boundsByRuleId.get(rule.id);
    if (!bounds || bounds.count === 0) continue;
    if (numCached === undefined) numCached = extractNumericValue(raw, ev);
    if (numCached === null) continue;

    if (parsed.kind === "dataBar") {
      let ratio: number;
      if (bounds.min >= 0 && bounds.max > 0) {
        ratio = Math.max(0, Math.min(1, numCached / bounds.max));
      } else if (bounds.max > bounds.min) {
        ratio = Math.max(0, Math.min(1, (numCached - bounds.min) / (bounds.max - bounds.min)));
      } else {
        ratio = numCached === 0 ? 0 : 1;
      }
      dataBar = {
        percent: Math.round(ratio * 1000) / 10,
        barColor: parsed.preset.barColor,
        fillColor: parsed.preset.fillColor,
        presetId: parsed.preset.id,
      };
    } else if (parsed.kind === "colorScale") {
      const ratio = bounds.max > bounds.min ? (numCached - bounds.min) / (bounds.max - bounds.min) : 0.5;
      colorScaleBg = interpolateColorScaleHex(ratio, parsed.preset);
      colorScalePresetId = parsed.preset.id;
    }
  }

  if (!dataBar && !colorScaleBg) return null;
  return {
    ...(dataBar ? { dataBar } : {}),
    ...(colorScaleBg ? { colorScaleBg, colorScalePresetId } : {}),
  };
}
