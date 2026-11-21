/**
 * Zero-GC pre-allocated Float32Array GPU instance buffers & 2D Camera matrix utilities.
 *
 * Packed layouts match WGSL (`@location(...)`) and GLSL 300 es (`layout(location=...)`):
 * - RectInstance:  16 floats (64 bytes): x, y, w, h, r, g, b, a, radius, borderW, br, bg, bb, ba, rotRad, flags
 * - LineInstance:  12 floats (48 bytes): x1, y1, x2, y2, thickness, r, g, b, a, dashLen, gapLen, flags
 * - ArcInstance:   12 floats (48 bytes): cx, cy, rx, ry, startAngle, endAngle, innerRatio, r, g, b, a, borderW
 * - GlyphInstance: 12 floats (48 bytes): x, y, w, h, u0, v0, u1, v1, r, g, b, a
 */

import type { GlyphAtlas } from "./glyph-atlas.js";

export const RECT_STRIDE = 16;
export const LINE_STRIDE = 12;
export const ARC_STRIDE = 12;
export const GLYPH_STRIDE = 12;

export type RgbaTuple = [number, number, number, number];

export interface RectInput {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: RgbaTuple;
  radius?: number;
  borderWidth?: number;
  borderColor?: RgbaTuple;
  rotationRad?: number;
  flags?: number;
}

export interface LineInput {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness?: number;
  color: RgbaTuple;
  dashLen?: number;
  gapLen?: number;
  flags?: number;
}

export interface ArcInput {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  startAngle?: number;
  endAngle?: number;
  innerRatio?: number;
  color: RgbaTuple;
  borderWidth?: number;
}

export interface GlyphInput {
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  color: RgbaTuple;
}

export interface ScissorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Parse CSS `#RGB`, `#RRGGBB`, `#RRGGBBAA`, or `rgba(...)` string into normalized 0..1 RGBA floats. */
export function packColorRGBA(css: string, alphaOverride?: number): RgbaTuple {
  const s = css.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0] + hex[0], 16) / 255;
      const g = Number.parseInt(hex[1] + hex[1], 16) / 255;
      const b = Number.parseInt(hex[2] + hex[2], 16) / 255;
      return [r, g, b, alphaOverride ?? 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
      const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
      const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, alphaOverride ?? a];
    }
  }
  const rgbaMatch = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgbaMatch) {
    return [
      Number(rgbaMatch[1]) / 255,
      Number(rgbaMatch[2]) / 255,
      Number(rgbaMatch[3]) / 255,
      alphaOverride ?? (rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : 1),
    ];
  }
  return [0.2, 0.44, 1, alphaOverride ?? 1];
}

export class Camera2D {
  x = 0;
  y = 0;
  zoom = 1;

  constructor(x = 0, y = 0, zoom = 1) {
    this.x = x;
    this.y = y;
    this.zoom = Math.max(0.05, zoom);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx / this.zoom + this.x, y: sy / this.zoom + this.y };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom, y: (wy - this.y) * this.zoom };
  }

  /**
   * Build 4-float uniform `[viewportW, viewportH, camX, camY]` + `[zoom, dpr, 0, 0]`
   * (8 floats = 32 bytes aligned for WebGPU UBO and WebGL2 uniforms).
   */
  writeUniform(out: Float32Array, viewportW: number, viewportH: number, dpr = 1): void {
    out[0] = Math.max(1, viewportW);
    out[1] = Math.max(1, viewportH);
    out[2] = this.x;
    out[3] = this.y;
    out[4] = this.zoom;
    out[5] = dpr;
    out[6] = 0;
    out[7] = 0;
  }
}

export class InstanceBatch {
  private rectData: Float32Array;
  private rectCount = 0;
  private lineData: Float32Array;
  private lineCount = 0;
  private arcData: Float32Array;
  private arcCount = 0;
  private glyphData: Float32Array;
  private glyphCount = 0;

  scissor: ScissorRect | null = null;
  camera: Camera2D = new Camera2D();

  constructor(initialRects = 1024, initialLines = 1024, initialArcs = 256, initialGlyphs = 1024) {
    this.rectData = new Float32Array(Math.max(16, initialRects) * RECT_STRIDE);
    this.lineData = new Float32Array(Math.max(16, initialLines) * LINE_STRIDE);
    this.arcData = new Float32Array(Math.max(16, initialArcs) * ARC_STRIDE);
    this.glyphData = new Float32Array(Math.max(16, initialGlyphs) * GLYPH_STRIDE);
  }

  get rects(): number {
    return this.rectCount;
  }

  get lines(): number {
    return this.lineCount;
  }

  get arcs(): number {
    return this.arcCount;
  }

  get glyphs(): number {
    return this.glyphCount;
  }

  get totalInstances(): number {
    return this.rectCount + this.lineCount + this.arcCount + this.glyphCount;
  }

  /** Reset cursors to 0 without freeing or reallocating typed arrays (zero per-frame GC). */
  reset(): void {
    this.rectCount = 0;
    this.lineCount = 0;
    this.arcCount = 0;
    this.glyphCount = 0;
    this.scissor = null;
  }

  private ensureRectCapacity(needed: number): void {
    if (needed * RECT_STRIDE <= this.rectData.length) return;
    const grown = new Float32Array(Math.max(needed * RECT_STRIDE, this.rectData.length * 2));
    grown.set(this.rectData);
    this.rectData = grown;
  }

  private ensureLineCapacity(needed: number): void {
    if (needed * LINE_STRIDE <= this.lineData.length) return;
    const grown = new Float32Array(Math.max(needed * LINE_STRIDE, this.lineData.length * 2));
    grown.set(this.lineData);
    this.lineData = grown;
  }

  private ensureArcCapacity(needed: number): void {
    if (needed * ARC_STRIDE <= this.arcData.length) return;
    const grown = new Float32Array(Math.max(needed * ARC_STRIDE, this.arcData.length * 2));
    grown.set(this.arcData);
    this.arcData = grown;
  }

  private ensureGlyphCapacity(needed: number): void {
    if (needed * GLYPH_STRIDE <= this.glyphData.length) return;
    const grown = new Float32Array(Math.max(needed * GLYPH_STRIDE, this.glyphData.length * 2));
    grown.set(this.glyphData);
    this.glyphData = grown;
  }

  pushRect(r: RectInput): void {
    const idx = this.rectCount++;
    this.ensureRectCapacity(this.rectCount);
    const o = idx * RECT_STRIDE;
    const d = this.rectData;
    const bc = r.borderColor ?? r.fill;
    d[o] = r.x;
    d[o + 1] = r.y;
    d[o + 2] = r.w;
    d[o + 3] = r.h;
    d[o + 4] = r.fill[0];
    d[o + 5] = r.fill[1];
    d[o + 6] = r.fill[2];
    d[o + 7] = r.fill[3];
    d[o + 8] = r.radius ?? 0;
    d[o + 9] = r.borderWidth ?? 0;
    d[o + 10] = bc[0];
    d[o + 11] = bc[1];
    d[o + 12] = bc[2];
    d[o + 13] = bc[3];
    d[o + 14] = r.rotationRad ?? 0;
    d[o + 15] = r.flags ?? 0;
  }

  pushLine(l: LineInput): void {
    const idx = this.lineCount++;
    this.ensureLineCapacity(this.lineCount);
    const o = idx * LINE_STRIDE;
    const d = this.lineData;
    d[o] = l.x1;
    d[o + 1] = l.y1;
    d[o + 2] = l.x2;
    d[o + 3] = l.y2;
    d[o + 4] = l.thickness ?? 1;
    d[o + 5] = l.color[0];
    d[o + 6] = l.color[1];
    d[o + 7] = l.color[2];
    d[o + 8] = l.color[3];
    d[o + 9] = l.dashLen ?? 0;
    d[o + 10] = l.gapLen ?? 0;
    d[o + 11] = l.flags ?? 0;
  }

  pushArc(a: ArcInput): void {
    const idx = this.arcCount++;
    this.ensureArcCapacity(this.arcCount);
    const o = idx * ARC_STRIDE;
    const d = this.arcData;
    d[o] = a.cx;
    d[o + 1] = a.cy;
    d[o + 2] = a.rx;
    d[o + 3] = a.ry;
    d[o + 4] = a.startAngle ?? 0;
    d[o + 5] = a.endAngle ?? Math.PI * 2;
    d[o + 6] = a.innerRatio ?? 0;
    d[o + 7] = a.color[0];
    d[o + 8] = a.color[1];
    d[o + 9] = a.color[2];
    d[o + 10] = a.color[3];
    d[o + 11] = a.borderWidth ?? 0;
  }

  pushGlyph(g: GlyphInput): void {
    const idx = this.glyphCount++;
    this.ensureGlyphCapacity(this.glyphCount);
    const o = idx * GLYPH_STRIDE;
    const d = this.glyphData;
    d[o] = g.x;
    d[o + 1] = g.y;
    d[o + 2] = g.w;
    d[o + 3] = g.h;
    d[o + 4] = g.u0;
    d[o + 5] = g.v0;
    d[o + 6] = g.u1;
    d[o + 7] = g.v1;
    d[o + 8] = g.color[0];
    d[o + 9] = g.color[1];
    d[o + 10] = g.color[2];
    d[o + 11] = g.color[3];
  }

  /** Layout and pack a string into instanced glyph quads using a `GlyphAtlas`. */
  pushText(
    atlas: GlyphAtlas,
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: RgbaTuple,
  ): void {
    let cx = x;
    let cy = y;
    const lineHeight = fontSize * 1.25;
    for (const ch of text) {
      if (ch === "\n") {
        cx = x;
        cy += lineHeight;
        continue;
      }
      const g = atlas.getGlyph(ch);
      const scale = fontSize / g.height;
      if (ch !== " ") {
        this.pushGlyph({
          x: cx,
          y: cy,
          w: g.width * scale,
          h: g.height * scale,
          u0: g.u0,
          v0: g.v0,
          u1: g.u1,
          v1: g.v1,
          color,
        });
      }
      cx += g.advance * scale;
    }
  }

  rectView(): Float32Array {
    return this.rectData.subarray(0, this.rectCount * RECT_STRIDE);
  }

  lineView(): Float32Array {
    return this.lineData.subarray(0, this.lineCount * LINE_STRIDE);
  }

  arcView(): Float32Array {
    return this.arcData.subarray(0, this.arcCount * ARC_STRIDE);
  }

  glyphView(): Float32Array {
    return this.glyphData.subarray(0, this.glyphCount * GLYPH_STRIDE);
  }
}
