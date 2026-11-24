/**
 * AI-Native Presentation Facade for `@jiange/slides-sdk`.
 *
 * Provides structured slide/shape authoring, atomic `apply()` with dry-run & undo/redo,
 * token-budgeted `inspect()`, `query()`, pure-TS SVG rendering, PPTX export/import,
 * and visual layout `verify()` diagnostics (overflow, overlap, out-of-bounds, WCAG contrast).
 */

import {
  DEFAULT_SLIDE_THEME,
  type SlideDeck,
  type SlideLayout,
  type SlideMediaAsset,
  type SlideShape,
  type SlideTheme,
  type SlidesPage,
} from "./model.js";
import { exportSlidesToPptx, exportSlidesToPptxAsync, parsePptxToSlides, type ExportPptxOptions } from "./pptx.js";
import { renderDeckToSvg, renderSlideToSvg, type SlideSvgOptions } from "./svg.js";

export type SlideDiagnosticSeverity = "error" | "warning" | "info";

export interface SlideDiagnostic {
  code:
    | "EMPTY_DECK"
    | "EMPTY_SLIDE"
    | "TEXT_OVERFLOW"
    | "SHAPE_OVERLAP"
    | "OUT_OF_BOUNDS"
    | "LOW_CONTRAST"
    | "MISSING_MEDIA"
    | "DUPLICATE_SHAPE_ID";
  severity: SlideDiagnosticSeverity;
  slideIndex: number;
  shapeId?: string;
  message: string;
  suggestion: string;
}

export type SlideOp =
  | { op: "addSlide"; index?: number; slide?: Partial<Omit<SlidesPage, "id" | "slidesId" | "pos">> }
  | { op: "updateSlide"; slideIndex: number; patch: Partial<Pick<SlidesPage, "title" | "body" | "background" | "layout" | "notes" | "hidden" | "transition">> }
  | { op: "deleteSlide"; slideIndex: number }
  | { op: "duplicateSlide"; slideIndex: number }
  | { op: "moveSlide"; fromIndex: number; toIndex: number }
  | { op: "addShape"; slideIndex: number; shape: Omit<SlideShape, "id"> & { id?: string } }
  | { op: "updateShape"; slideIndex: number; shapeId: string; patch: Partial<Omit<SlideShape, "id">> }
  | { op: "deleteShape"; slideIndex: number; shapeId: string }
  | { op: "setTheme"; theme: Partial<SlideTheme> };

export interface SlideApplyOptions {
  dryRun?: boolean;
  atomic?: boolean;
  actor?: string;
}

export interface SlideApplyDiff {
  slideIndex: number;
  op: SlideOp["op"];
  detail: string;
}

export interface SlideApplyResult {
  ok: boolean;
  applied: number;
  undoToken: string | null;
  diff: SlideApplyDiff[];
  warnings: string[];
  errors: string[];
}

export interface SlideInspectOptions {
  detail?: "summary" | "standard" | "full";
  maxTokens?: number;
  slideIndex?: number;
}

export interface SlideInspectResult {
  title: string;
  slideCount: number;
  theme: SlideTheme;
  mediaIds: string[];
  truncated: boolean;
  slides: Array<{
    index: number;
    title: string;
    layout: SlideLayout;
    hidden: boolean;
    background: string;
    shapeCount: number;
    bodyPreview?: string;
    notesPreview?: string;
    shapes?: SlideShape[];
  }>;
}

export interface SlideQueryOptions {
  text?: string;
  layout?: SlideLayout;
  hidden?: boolean;
  shapeKind?: SlideShape["kind"];
}

export interface SlideQueryMatch {
  slideIndex: number;
  title: string;
  matchedIn: string[];
  shapeIds: string[];
}

interface DeckSnapshot {
  title: string;
  theme: SlideTheme;
  pages: SlidesPage[];
}

function clonePages(pages: readonly SlidesPage[]): SlidesPage[] {
  return pages.map((p) => ({
    ...p,
    transition: p.transition ? { ...p.transition } : undefined,
    shapes: p.shapes.map((s) => ({
      ...s,
      paragraphs: s.paragraphs ? s.paragraphs.map((par) => ({ ...par, runs: par.runs.map((r) => ({ ...r })) })) : undefined,
      table: s.table ? { ...s.table, rows: s.table.rows.map((row) => [...row]) } : undefined,
      chart: s.chart
        ? { ...s.chart, categories: [...s.chart.categories], series: s.chart.series.map((ser) => ({ ...ser, values: [...ser.values] })) }
        : undefined,
      crop: s.crop ? { ...s.crop } : undefined,
    })),
  }));
}

function parseRgb(hex: string | undefined): [number, number, number] | null {
  if (!hex) return null;
  const clean = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      Number.parseInt(clean.slice(0, 2), 16),
      Number.parseInt(clean.slice(2, 4), 16),
      Number.parseInt(clean.slice(4, 6), 16),
    ];
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return [
      Number.parseInt(clean[0] + clean[0], 16),
      Number.parseInt(clean[1] + clean[1], 16),
      Number.parseInt(clean[2] + clean[2], 16),
    ];
  }
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const chan = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrastRatio(c1: string, c2: string): number | null {
  const rgb1 = parseRgb(c1);
  const rgb2 = parseRgb(c2);
  if (!rgb1 || !rgb2) return null;
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function isLineShape(kind: SlideShape["kind"]): boolean {
  return (
    kind === "line" ||
    kind === "line-arrow" ||
    kind === "line-arrow-filled" ||
    kind === "line-dot" ||
    kind === "line-double-arrow"
  );
}

function estimateTextOverflow(text: string, boxWPct: number, boxHPct: number, fontSizePt: number): boolean {
  if (!text) return false;
  const widthPx = (boxWPct / 100) * 1280;
  const heightPx = (boxHPct / 100) * 720;
  const charsPerLine = Math.max(4, widthPx / (fontSizePt * 0.58));
  let lineCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) {
      lineCount += 1;
      continue;
    }
    let visualWidth = 0;
    for (const ch of Array.from(raw)) {
      visualWidth += ch.codePointAt(0)! > 0x2e80 ? 1.85 : 1;
    }
    lineCount += Math.max(1, Math.ceil(visualWidth / charsPerLine));
  }
  const neededH = lineCount * fontSizePt * 1.35;
  return neededH > heightPx * 1.15;
}

export class Presentation {
  private title: string;
  private theme: SlideTheme;
  private pages: SlidesPage[];
  private media: Map<string, SlideMediaAsset>;
  private nextSlideId = 1;
  private nextShapeSeq = 1;
  private undoStack: Array<{ token: string; snapshot: DeckSnapshot }> = [];
  private redoStack: DeckSnapshot[] = [];
  private undoSeq = 1;

  private constructor(options?: {
    title?: string;
    theme?: Partial<SlideTheme>;
    pages?: SlidesPage[];
    media?: Record<string, SlideMediaAsset>;
  }) {
    this.title = options?.title?.trim() || "Untitled Presentation";
    this.theme = { ...DEFAULT_SLIDE_THEME, ...options?.theme };
    this.pages = options?.pages ? clonePages(options.pages) : [];
    this.media = new Map<string, SlideMediaAsset>(Object.entries(options?.media ?? {}));
    for (const page of this.pages) {
      if (page.id >= this.nextSlideId) this.nextSlideId = page.id + 1;
    }
    this.reindexPositions();
  }

  static create(options?: { title?: string; theme?: Partial<SlideTheme>; initialSlide?: boolean }): Presentation {
    const deck = new Presentation({ title: options?.title, theme: options?.theme });
    if (options?.initialSlide !== false) {
      deck.pages.push(deck.makePage({ title: deck.title, body: "", layout: "title" }));
      deck.reindexPositions();
    }
    return deck;
  }

  static fromPages(pages: readonly SlidesPage[], options?: { title?: string; theme?: Partial<SlideTheme>; media?: Record<string, SlideMediaAsset> }): Presentation {
    return new Presentation({ ...options, pages: [...pages] });
  }

  static async fromPptx(bytes: Uint8Array, options?: { title?: string }): Promise<{ presentation: Presentation; warnings: string[] }> {
    const imported = await parsePptxToSlides(bytes);
    const now = new Date().toISOString();
    const pages: SlidesPage[] = imported.pages.map((p, idx) => ({
      id: idx + 1,
      slidesId: 1,
      pos: (idx + 1) * 1000,
      title: p.title,
      body: p.body,
      background: p.background,
      layout: p.layout,
      notes: p.notes,
      shapes: p.shapes,
      hidden: p.hidden,
      revision: 1,
      updatedAt: now,
    }));
    const deck = new Presentation({
      title: options?.title ?? (pages[0]?.title || "Imported Presentation"),
      pages,
      media: imported.media,
    });
    return { presentation: deck, warnings: imported.warnings };
  }

  private makePage(input?: Partial<Omit<SlidesPage, "id" | "slidesId" | "pos">>): SlidesPage {
    const id = this.nextSlideId++;
    return {
      id,
      slidesId: 1,
      pos: id * 1000,
      title: input?.title ?? "",
      body: input?.body ?? "",
      background: input?.background ?? "",
      layout: input?.layout ?? "",
      notes: input?.notes ?? "",
      shapes: input?.shapes ? input.shapes.map((s) => ({ ...s })) : [],
      hidden: Boolean(input?.hidden),
      revision: input?.revision ?? 1,
      updatedAt: input?.updatedAt ?? new Date().toISOString(),
      transition: input?.transition ? { ...input.transition } : undefined,
    };
  }

  private reindexPositions(): void {
    this.pages.forEach((p, idx) => {
      p.pos = (idx + 1) * 1000;
    });
  }

  private captureSnapshot(): DeckSnapshot {
    return {
      title: this.title,
      theme: { ...this.theme },
      pages: clonePages(this.pages),
    };
  }

  private restoreSnapshot(snap: DeckSnapshot): void {
    this.title = snap.title;
    this.theme = { ...snap.theme };
    this.pages = clonePages(snap.pages);
    this.reindexPositions();
  }

  private pushUndo(): string {
    const token = `undo-${this.undoSeq++}`;
    this.undoStack.push({ token, snapshot: this.captureSnapshot() });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    return token;
  }

  getTitle(): string {
    return this.title;
  }

  setTitle(title: string): void {
    this.pushUndo();
    this.title = title.trim() || "Untitled Presentation";
  }

  getTheme(): SlideTheme {
    return { ...this.theme };
  }

  setTheme(patch: Partial<SlideTheme>): SlideTheme {
    this.pushUndo();
    this.theme = { ...this.theme, ...patch };
    return this.getTheme();
  }

  addMedia(asset: SlideMediaAsset): void {
    this.media.set(asset.id, asset);
  }

  getMedia(): Record<string, SlideMediaAsset> {
    return Object.fromEntries(this.media.entries());
  }

  getPages(): SlidesPage[] {
    return clonePages(this.pages);
  }

  getSlide(index: number): SlidesPage | undefined {
    const p = this.pages[index];
    return p ? clonePages([p])[0] : undefined;
  }

  get slideCount(): number {
    return this.pages.length;
  }

  addSlide(input?: Partial<Omit<SlidesPage, "id" | "slidesId" | "pos">>, index?: number): SlidesPage {
    this.pushUndo();
    const page = this.makePage(input);
    const target = index === undefined ? this.pages.length : Math.max(0, Math.min(this.pages.length, index));
    this.pages.splice(target, 0, page);
    this.reindexPositions();
    return clonePages([page])[0];
  }

  updateSlide(
    index: number,
    patch: Partial<Pick<SlidesPage, "title" | "body" | "background" | "layout" | "notes" | "hidden" | "transition">>,
  ): SlidesPage {
    const res = this.apply([{ op: "updateSlide", slideIndex: index, patch }]);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return this.getSlide(index)!;
  }

  deleteSlide(index: number): boolean {
    const res = this.apply([{ op: "deleteSlide", slideIndex: index }]);
    return res.ok;
  }

  duplicateSlide(index: number): SlidesPage {
    const res = this.apply([{ op: "duplicateSlide", slideIndex: index }]);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return this.getSlide(index + 1)!;
  }

  moveSlide(fromIndex: number, toIndex: number): boolean {
    const res = this.apply([{ op: "moveSlide", fromIndex, toIndex }]);
    return res.ok;
  }

  addShape(slideIndex: number, shape: Omit<SlideShape, "id"> & { id?: string }): SlideShape {
    const id = shape.id ?? `shp-${this.nextShapeSeq++}`;
    const res = this.apply([{ op: "addShape", slideIndex, shape: { ...shape, id } }]);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return this.pages[slideIndex].shapes.find((s) => s.id === id)!;
  }

  updateShape(slideIndex: number, shapeId: string, patch: Partial<Omit<SlideShape, "id">>): SlideShape {
    const res = this.apply([{ op: "updateShape", slideIndex, shapeId, patch }]);
    if (!res.ok) throw new Error(res.errors.join("; "));
    return this.pages[slideIndex].shapes.find((s) => s.id === shapeId)!;
  }

  deleteShape(slideIndex: number, shapeId: string): boolean {
    const res = this.apply([{ op: "deleteShape", slideIndex, shapeId }]);
    return res.ok;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push(this.captureSnapshot());
    this.restoreSnapshot(entry.snapshot);
    return true;
  }

  redo(): boolean {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    this.undoStack.push({ token: `undo-${this.undoSeq++}`, snapshot: this.captureSnapshot() });
    this.restoreSnapshot(snap);
    return true;
  }

  /** AI-Native token-budgeted inspection of the deck structure. */
  inspect(options: SlideInspectOptions = {}): SlideInspectResult {
    const detail = options.detail ?? "standard";
    const maxTokens = options.maxTokens ?? 4000;
    const maxChars = Math.max(200, maxTokens * 4);
    const targetIndices =
      options.slideIndex !== undefined
        ? options.slideIndex >= 0 && options.slideIndex < this.pages.length
          ? [options.slideIndex]
          : []
        : this.pages.map((_, idx) => idx);

    const slides: SlideInspectResult["slides"] = [];
    let usedChars = 160;
    let truncated = false;

    for (const idx of targetIndices) {
      const p = this.pages[idx];
      const item: SlideInspectResult["slides"][number] = {
        index: idx,
        title: p.title,
        layout: p.layout ?? "",
        hidden: p.hidden,
        background: p.background || this.theme.background,
        shapeCount: p.shapes.length,
      };
      if (detail !== "summary") {
        item.bodyPreview = p.body.slice(0, detail === "full" ? 4000 : 200);
        if (p.notes) item.notesPreview = p.notes.slice(0, detail === "full" ? 2000 : 120);
      }
      if (detail === "full") {
        item.shapes = clonePages([p])[0].shapes;
      }
      const itemSize = JSON.stringify(item).length;
      if (usedChars + itemSize > maxChars && slides.length > 0) {
        truncated = true;
        break;
      }
      usedChars += itemSize;
      slides.push(item);
    }

    return {
      title: this.title,
      slideCount: this.pages.length,
      theme: { ...this.theme },
      mediaIds: [...this.media.keys()],
      truncated,
      slides,
    };
  }

  /** Search slides by keyword, layout, hidden flag, or shape kind. */
  query(options: SlideQueryOptions = {}): SlideQueryMatch[] {
    const needle = options.text?.trim().toLowerCase();
    const matches: SlideQueryMatch[] = [];

    this.pages.forEach((p, idx) => {
      if (options.layout !== undefined && (p.layout ?? "") !== options.layout) return;
      if (options.hidden !== undefined && p.hidden !== options.hidden) return;
      if (options.shapeKind && !p.shapes.some((s) => s.kind === options.shapeKind)) return;

      const matchedIn: string[] = [];
      const shapeIds: string[] = [];

      if (needle) {
        if (p.title.toLowerCase().includes(needle)) matchedIn.push("title");
        if (p.body.toLowerCase().includes(needle)) matchedIn.push("body");
        if (p.notes.toLowerCase().includes(needle)) matchedIn.push("notes");
        for (const s of p.shapes) {
          const shapeText = [
            s.text ?? "",
            ...(s.paragraphs?.flatMap((par) => par.runs.map((r) => r.text)) ?? []),
            ...(s.table?.rows.flat() ?? []),
            s.chart?.title ?? "",
          ]
            .join(" ")
            .toLowerCase();
          if (shapeText.includes(needle)) {
            shapeIds.push(s.id);
          }
        }
        if (shapeIds.length > 0) matchedIn.push("shapes");
        if (matchedIn.length === 0) return;
      } else if (options.shapeKind) {
        for (const s of p.shapes) {
          if (s.kind === options.shapeKind) shapeIds.push(s.id);
        }
        matchedIn.push("shapes");
      }

      matches.push({ slideIndex: idx, title: p.title, matchedIn, shapeIds });
    });

    return matches;
  }

  /** Atomically apply structured slide/shape mutations with optional dry-run and automatic rollback. */
  apply(ops: readonly SlideOp[], options: SlideApplyOptions = {}): SlideApplyResult {
    const atomic = options.atomic !== false;
    const dryRun = Boolean(options.dryRun);
    const before = this.captureSnapshot();
    const diff: SlideApplyDiff[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let applied = 0;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      try {
        switch (op.op) {
          case "addSlide": {
            const page = this.makePage(op.slide);
            const target = op.index === undefined ? this.pages.length : Math.max(0, Math.min(this.pages.length, op.index));
            this.pages.splice(target, 0, page);
            this.reindexPositions();
            diff.push({ slideIndex: target, op: op.op, detail: `added slide "${page.title}"` });
            applied++;
            break;
          }
          case "updateSlide": {
            const page = this.pages[op.slideIndex];
            if (!page) throw new Error(`slideIndex ${op.slideIndex} out of range`);
            Object.assign(page, op.patch, { revision: page.revision + 1, updatedAt: new Date().toISOString() });
            diff.push({ slideIndex: op.slideIndex, op: op.op, detail: `updated fields: ${Object.keys(op.patch).join(", ")}` });
            applied++;
            break;
          }
          case "deleteSlide": {
            if (op.slideIndex < 0 || op.slideIndex >= this.pages.length) {
              throw new Error(`slideIndex ${op.slideIndex} out of range`);
            }
            const [removed] = this.pages.splice(op.slideIndex, 1);
            this.reindexPositions();
            diff.push({ slideIndex: op.slideIndex, op: op.op, detail: `deleted slide "${removed.title}"` });
            applied++;
            break;
          }
          case "duplicateSlide": {
            const source = this.pages[op.slideIndex];
            if (!source) throw new Error(`slideIndex ${op.slideIndex} out of range`);
            const cloned = clonePages([source])[0];
            cloned.id = this.nextSlideId++;
            cloned.updatedAt = new Date().toISOString();
            this.pages.splice(op.slideIndex + 1, 0, cloned);
            this.reindexPositions();
            diff.push({ slideIndex: op.slideIndex + 1, op: op.op, detail: `duplicated slide ${op.slideIndex}` });
            applied++;
            break;
          }
          case "moveSlide": {
            if (op.fromIndex < 0 || op.fromIndex >= this.pages.length || op.toIndex < 0 || op.toIndex >= this.pages.length) {
              throw new Error(`moveSlide indices (${op.fromIndex} -> ${op.toIndex}) out of range`);
            }
            const [moved] = this.pages.splice(op.fromIndex, 1);
            this.pages.splice(op.toIndex, 0, moved);
            this.reindexPositions();
            diff.push({ slideIndex: op.toIndex, op: op.op, detail: `moved slide ${op.fromIndex} -> ${op.toIndex}` });
            applied++;
            break;
          }
          case "addShape": {
            const page = this.pages[op.slideIndex];
            if (!page) throw new Error(`slideIndex ${op.slideIndex} out of range`);
            const id = op.shape.id ?? `shp-${this.nextShapeSeq++}`;
            if (page.shapes.some((s) => s.id === id)) {
              throw new Error(`duplicate shape id "${id}" on slide ${op.slideIndex}`);
            }
            page.shapes.push({ ...op.shape, id });
            page.revision++;
            diff.push({ slideIndex: op.slideIndex, op: op.op, detail: `added ${op.shape.kind} "${id}"` });
            applied++;
            break;
          }
          case "updateShape": {
            const page = this.pages[op.slideIndex];
            if (!page) throw new Error(`slideIndex ${op.slideIndex} out of range`);
            const target = page.shapes.find((s) => s.id === op.shapeId);
            if (!target) throw new Error(`shape "${op.shapeId}" not found on slide ${op.slideIndex}`);
            Object.assign(target, op.patch);
            page.revision++;
            diff.push({ slideIndex: op.slideIndex, op: op.op, detail: `updated shape "${op.shapeId}"` });
            applied++;
            break;
          }
          case "deleteShape": {
            const page = this.pages[op.slideIndex];
            if (!page) throw new Error(`slideIndex ${op.slideIndex} out of range`);
            const idx = page.shapes.findIndex((s) => s.id === op.shapeId);
            if (idx < 0) throw new Error(`shape "${op.shapeId}" not found on slide ${op.slideIndex}`);
            page.shapes.splice(idx, 1);
            page.revision++;
            diff.push({ slideIndex: op.slideIndex, op: op.op, detail: `deleted shape "${op.shapeId}"` });
            applied++;
            break;
          }
          case "setTheme": {
            this.theme = { ...this.theme, ...op.theme };
            diff.push({ slideIndex: -1, op: op.op, detail: `updated theme (${Object.keys(op.theme).join(", ")})` });
            applied++;
            break;
          }
        }
      } catch (err) {
        errors.push(`op[${i}] (${op.op}): ${err instanceof Error ? err.message : String(err)}`);
        if (atomic) break;
      }
    }

    if (dryRun || (errors.length > 0 && atomic)) {
      this.restoreSnapshot(before);
      return {
        ok: errors.length === 0,
        applied: errors.length > 0 && atomic ? 0 : applied,
        undoToken: null,
        diff: errors.length > 0 && atomic ? [] : diff,
        warnings,
        errors,
      };
    }

    let undoToken: string | null = null;
    if (applied > 0) {
      undoToken = `undo-${this.undoSeq++}`;
      this.undoStack.push({ token: undoToken, snapshot: before });
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }

    return { ok: errors.length === 0, applied, undoToken, diff, warnings, errors };
  }

  /**
   * Visual & structural layout verification for AI self-correction:
   * checks empty deck/slides, text overflow, shape overlap, out-of-bounds,
   * WCAG contrast ratio, missing media assets, and duplicate shape IDs.
   */
  verify(): SlideDiagnostic[] {
    const diagnostics: SlideDiagnostic[] = [];
    if (this.pages.length === 0) {
      diagnostics.push({
        code: "EMPTY_DECK",
        severity: "error",
        slideIndex: -1,
        message: "Presentation contains 0 slides.",
        suggestion: "Call addSlide to add at least one title or content slide.",
      });
      return diagnostics;
    }

    this.pages.forEach((page, slideIndex) => {
      const bg = page.background || this.theme.background;
      if (!page.title.trim() && !page.body.trim() && page.shapes.length === 0) {
        diagnostics.push({
          code: "EMPTY_SLIDE",
          severity: "warning",
          slideIndex,
          message: `Slide ${slideIndex + 1} has no title, body, or shapes.`,
          suggestion: "Populate title/body content or delete the blank slide.",
        });
      }

      if (page.title && estimateTextOverflow(page.title, 88, page.layout === "title" ? 22 : 14, page.layout === "title" ? 48 : 36)) {
        diagnostics.push({
          code: "TEXT_OVERFLOW",
          severity: "warning",
          slideIndex,
          message: `Slide ${slideIndex + 1} title may overflow its placeholder box.`,
          suggestion: "Shorten the slide title to <= 2 concise lines.",
        });
      }
      if (page.body && estimateTextOverflow(page.body, 88, page.layout === "title" ? 24 : 66, 22)) {
        diagnostics.push({
          code: "TEXT_OVERFLOW",
          severity: "warning",
          slideIndex,
          message: `Slide ${slideIndex + 1} body text may overflow the slide canvas.`,
          suggestion: "Summarize bullet points or split across two slides.",
        });
      }

      const seenIds = new Set<string>();
      const boxes: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }> = [];

      for (const s of page.shapes) {
        if (seenIds.has(s.id)) {
          diagnostics.push({
            code: "DUPLICATE_SHAPE_ID",
            severity: "error",
            slideIndex,
            shapeId: s.id,
            message: `Duplicate shape id "${s.id}" on slide ${slideIndex + 1}.`,
            suggestion: "Ensure each shape on a slide has a unique id.",
          });
        }
        seenIds.add(s.id);

        const w = s.width ?? 16;
        const h = s.height ?? 20;
        if (s.x < 0 || s.y < 0 || s.x + w > 100.01 || s.y + h > 100.01) {
          diagnostics.push({
            code: "OUT_OF_BOUNDS",
            severity: "error",
            slideIndex,
            shapeId: s.id,
            message: `Shape "${s.id}" (${s.x}%, ${s.y}%, ${w}%x${h}%) extends beyond the 0..100% slide bounds.`,
            suggestion: `Clamp x to [0, ${Math.max(0, 100 - w).toFixed(1)}] and y to [0, ${Math.max(0, 100 - h).toFixed(1)}].`,
          });
        }

        if (s.kind === "text") {
          const ratio = contrastRatio(s.color, bg);
          if (ratio !== null && ratio < 3.0) {
            diagnostics.push({
              code: "LOW_CONTRAST",
              severity: "warning",
              slideIndex,
              shapeId: s.id,
              message: `Text shape "${s.id}" color (${s.color}) has low contrast (${ratio.toFixed(2)}:1) against background (${bg}).`,
              suggestion: "Use a darker/lighter text color to reach at least 4.5:1 WCAG contrast.",
            });
          }
          const txt = s.paragraphs
            ? s.paragraphs.map((par) => par.runs.map((r) => r.text).join("")).join("\n")
            : (s.text ?? "");
          if (estimateTextOverflow(txt, w, h, s.fontSize ?? 24)) {
            diagnostics.push({
              code: "TEXT_OVERFLOW",
              severity: "warning",
              slideIndex,
              shapeId: s.id,
              message: `Text shape "${s.id}" content may overflow its bounding box (${w}%x${h}%).`,
              suggestion: "Increase height/width or reduce fontSize.",
            });
          }
        }

        if (s.kind === "image" && s.mediaId && !this.media.has(s.mediaId)) {
          diagnostics.push({
            code: "MISSING_MEDIA",
            severity: "error",
            slideIndex,
            shapeId: s.id,
            message: `Image shape "${s.id}" references missing mediaId "${s.mediaId}".`,
            suggestion: "Register the asset via addMedia() or update mediaId.",
          });
        }

        if (!isLineShape(s.kind)) {
          boxes.push({ id: s.id, x1: s.x, y1: s.y, x2: s.x + w, y2: s.y + h });
        }
      }

      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const ba = boxes[a];
          const bb = boxes[b];
          const ix = Math.max(0, Math.min(ba.x2, bb.x2) - Math.max(ba.x1, bb.x1));
          const iy = Math.max(0, Math.min(ba.y2, bb.y2) - Math.max(ba.y1, bb.y1));
          const interArea = ix * iy;
          if (interArea <= 0) continue;
          const minArea = Math.min((ba.x2 - ba.x1) * (ba.y2 - ba.y1), (bb.x2 - bb.x1) * (bb.y2 - bb.y1));
          if (minArea > 0 && interArea / minArea > 0.25) {
            diagnostics.push({
              code: "SHAPE_OVERLAP",
              severity: "warning",
              slideIndex,
              shapeId: bb.id,
              message: `Shapes "${ba.id}" and "${bb.id}" overlap by ${Math.round((interArea / minArea) * 100)}% on slide ${slideIndex + 1}.`,
              suggestion: `Reposition "${bb.id}" to avoid overlapping "${ba.id}".`,
            });
          }
        }
      }
    });

    return diagnostics;
  }

  renderSvg(slideIndex: number, options?: SlideSvgOptions): string {
    const page = this.pages[slideIndex];
    if (!page) throw new RangeError(`slideIndex ${slideIndex} out of range`);
    return renderSlideToSvg(page, {
      ...options,
      theme: { ...this.theme, ...options?.theme },
      media: options?.media ?? this.getMedia(),
    });
  }

  renderAllSvg(options?: SlideSvgOptions): string[] {
    return renderDeckToSvg(this.pages, {
      ...options,
      theme: { ...this.theme, ...options?.theme },
      media: options?.media ?? this.getMedia(),
    });
  }

  toPptx(options?: ExportPptxOptions): Uint8Array {
    return exportSlidesToPptx(this.pages, {
      title: this.title,
      theme: this.theme,
      media: this.getMedia(),
      ...options,
    });
  }

  async toPptxAsync(options?: ExportPptxOptions): Promise<Uint8Array> {
    return exportSlidesToPptxAsync(this.pages, {
      title: this.title,
      theme: this.theme,
      media: this.getMedia(),
      ...options,
    });
  }

  toJSON(): SlideDeck {
    return {
      title: this.title,
      theme: { ...this.theme },
      pages: this.getPages(),
      media: this.media.size > 0 ? this.getMedia() : undefined,
    };
  }
}
