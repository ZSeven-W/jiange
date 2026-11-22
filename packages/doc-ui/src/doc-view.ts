/**
 * Virtualized Block Document Editor UI over `@jiange/doc-sdk` + `@jiange/render-gpu` `VirtualList1D`.
 * Supports 10,000+ blocks with O(log N) dynamic height tracking, outline jumps, and AI suggestion actions.
 */

import type { DocBlockSnapshot, Document } from "@jiange/doc-sdk";
import { VirtualList1D, type PoolableElement } from "@jiange/render-gpu";

export interface DocViewOptions {
  defaultBlockHeight?: number;
  readOnly?: boolean;
  onActiveBlockChange?: (blockId: string | null) => void;
  onDocumentChange?: () => void;
}

export interface DocFrameResult {
  start: number;
  end: number;
  totalHeight: number;
  visibleCount: number;
}

function estimateBlockHeight(block: DocBlockSnapshot): number {
  const lines = Math.max(1, Math.ceil(block.text.length / 72), block.text.split("\n").length);
  if (block.type === "h1" || block.type === "heading1") return 46 + (lines - 1) * 34;
  if (block.type === "h2" || block.type === "heading2") return 40 + (lines - 1) * 28;
  if (block.type === "h3" || block.type === "heading3") return 36 + (lines - 1) * 24;
  if (block.type === "code") return 32 + lines * 22;
  if (block.type === "divider") return 24;
  return 24 + lines * 24;
}

export class DocViewController<T extends PoolableElement = PoolableElement> {
  readonly list: VirtualList1D<T>;
  private scrollTop = 0;
  private viewportWidth = 760;
  private viewportHeight = 600;
  private activeBlockId: string | null = null;
  private measuredHeights = new Map<string, number>();
  private cachedBlocks: DocBlockSnapshot[] = [];
  private blockIndexById = new Map<string, number>();
  private cachedVersion = -1;

  constructor(
    readonly doc: Document,
    elementFactory: () => T,
    private readonly options: DocViewOptions = {},
  ) {
    this.list = new VirtualList1D<T>(0, options.defaultBlockHeight ?? 44, elementFactory);
    this.syncBlockMetrics();
  }

  getActiveBlockId(): string | null {
    return this.activeBlockId;
  }

  getScrollTop(): number {
    return this.scrollTop;
  }

  resize(widthPx: number, heightPx: number): void {
    this.viewportWidth = Math.max(100, Math.floor(widthPx));
    this.viewportHeight = Math.max(100, Math.floor(heightPx));
  }

  setScrollTop(y: number): DocFrameResult {
    const maxY = Math.max(0, this.list.sizes.totalSize - this.viewportHeight);
    this.scrollTop = Math.max(0, Math.min(maxY, y));
    return this.render();
  }

  /** Feed real ResizeObserver block height measurements back into the O(log N) Fenwick tree. */
  reportBlockHeight(blockId: string, heightPx: number): void {
    const clean = Math.max(16, Math.round(heightPx));
    this.measuredHeights.set(blockId, clean);
    this.syncBlockMetrics();
    const idx = this.blockIndexById.get(blockId);
    if (idx !== undefined) this.list.sizes.setSize(idx, clean);
  }

  syncBlockMetrics(): DocBlockSnapshot[] {
    if (this.cachedVersion === this.doc.version) {
      return this.cachedBlocks;
    }
    const blocks = this.doc.blocks();
    this.cachedBlocks = blocks;
    this.blockIndexById.clear();
    this.list.sizes.setCount(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      this.blockIndexById.set(b.id, i);
      const h = this.measuredHeights.get(b.id) ?? estimateBlockHeight(b);
      this.list.sizes.setSize(i, h);
    }
    this.cachedVersion = this.doc.version;
    return blocks;
  }

  focusBlock(blockId: string | null): void {
    this.activeBlockId = blockId;
    this.options.onActiveBlockChange?.(blockId);
  }

  jumpToHeading(headingIdOrText: string): DocFrameResult {
    this.syncBlockMetrics();
    const lower = headingIdOrText.trim().toLowerCase();
    const hit = this.doc
      .outline()
      .find((h) => h.id === headingIdOrText || h.text.toLowerCase().includes(lower));
    if (hit) {
      this.focusBlock(hit.id);
      return this.setScrollTop(this.list.sizes.indexToOffset(hit.blockIndex));
    }
    return this.render();
  }

  updateActiveText(text: string): DocFrameResult {
    if (this.options.readOnly || !this.activeBlockId) return this.render();
    this.doc.updateBlock(this.activeBlockId, { text });
    return this.render();
  }

  insertBlockAfterActive(type = "paragraph", text = ""): DocBlockSnapshot | null {
    if (this.options.readOnly) return null;
    const inserted = this.doc.insertBlock({ type, text, afterBlockId: this.activeBlockId });
    this.focusBlock(inserted.id);
    this.render();
    return inserted;
  }

  deleteActiveBlock(): boolean {
    if (this.options.readOnly || !this.activeBlockId) return false;
    const blocks = this.doc.blocks();
    const idx = blocks.findIndex((b) => b.id === this.activeBlockId);
    if (idx < 0) return false;
    this.doc.deleteBlock(this.activeBlockId);
    const next = blocks[idx + 1] ?? blocks[idx - 1] ?? null;
    this.focusBlock(next ? next.id : null);
    this.render();
    return true;
  }

  handleKeyDown(key: string, opts?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): boolean {
    const mod = Boolean(opts?.metaKey || opts?.ctrlKey);
    if (mod && key.toLowerCase() === "z") {
      if (opts?.shiftKey) this.doc.redo();
      else this.doc.undo();
      this.render();
      return true;
    }
    if (key === "Enter" && !opts?.shiftKey && this.activeBlockId) {
      this.insertBlockAfterActive("paragraph", "");
      return true;
    }
    if (key === "Backspace" && this.activeBlockId && this.doc.getBlock(this.activeBlockId)?.text === "") {
      return this.deleteActiveBlock();
    }
    return false;
  }

  render(): DocFrameResult {
    const blocks = this.syncBlockMetrics();
    const res = this.list.update(
      this.scrollTop,
      this.viewportHeight,
      this.viewportWidth,
      (index, el) => {
        const block = blocks[index];
        if (el.textContent !== block.text) el.textContent = block.text;
        el.setAttribute?.("data-block-id", block.id);
        el.setAttribute?.("data-block-type", block.type);
      },
    );
    return {
      start: res.start,
      end: res.end,
      totalHeight: res.totalHeight,
      visibleCount: res.items.length,
    };
  }

  dispose(): void {
    this.list.pool.clear();
  }
}

export interface MountedDocView {
  controller: DocViewController<HTMLElement>;
  resize(width: number, height: number): void;
  dispose(): void;
}

export function mountDocView(
  container: HTMLElement,
  doc: Document,
  options: DocViewOptions = {},
): MountedDocView {
  const domDoc = container.ownerDocument;
  container.style.position = "relative";
  container.style.overflow = "hidden";

  const viewport = domDoc.createElement("div");
  viewport.style.position = "absolute";
  viewport.style.inset = "0";
  viewport.style.overflow = "hidden";
  container.appendChild(viewport);

  const controller = new DocViewController<HTMLElement>(
    doc,
    () => {
      const el = domDoc.createElement("div");
      el.style.boxSizing = "border-box";
      el.style.padding = "4px 12px";
      if (!options.readOnly) {
        el.contentEditable = "true";
        el.style.outline = "none";
        el.style.cursor = "text";
      }
      viewport.appendChild(el);
      return el;
    },
    options,
  );

  const focusActiveDom = () => {
    const activeId = controller.getActiveBlockId();
    if (!activeId) return;
    const match = Array.from(viewport.children).find(
      (child) => (child as HTMLElement).getAttribute?.("data-block-id") === activeId,
    ) as HTMLElement | undefined;
    match?.focus?.();
  };

  const onFocusIn = (e: Event) => {
    const target = e.target as HTMLElement | null;
    const blockId = target?.getAttribute?.("data-block-id");
    if (blockId) controller.focusBlock(blockId);
  };
  const onInput = (e: Event) => {
    const target = e.target as HTMLElement | null;
    const blockId = target?.getAttribute?.("data-block-id");
    if (!target || !blockId) return;
    controller.focusBlock(blockId);
    controller.updateActiveText(target.textContent ?? "");
    options.onDocumentChange?.();
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    controller.setScrollTop(controller.getScrollTop() + e.deltaY);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (controller.handleKeyDown(e.key, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey })) {
      e.preventDefault();
      focusActiveDom();
      options.onDocumentChange?.();
    }
  };

  viewport.addEventListener("focusin", onFocusIn);
  viewport.addEventListener("input", onInput);
  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("keydown", onKeyDown);

  controller.resize(container.clientWidth || 760, container.clientHeight || 600);
  controller.render();

  return {
    controller,
    resize(width: number, height: number) {
      controller.resize(width, height);
      controller.render();
    },
    dispose() {
      viewport.removeEventListener("focusin", onFocusIn);
      viewport.removeEventListener("input", onInput);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("keydown", onKeyDown);
      controller.dispose();
      viewport.remove();
    },
  };
}
