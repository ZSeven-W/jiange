/**
 * Framework-agnostic Spreadsheet UI Controller managing selection, scrolling,
 * keyboard navigation, resize, and the singleton IME cell editor.
 */

import { sheetAddress, type Workbook } from "@zseven-w/sheet-sdk";
import type { PoolableElement } from "@zseven-w/render-gpu";
import {
  SheetGpuRenderer,
  type SheetCollaboratorCursor,
  type SheetFrameResult,
  type SheetSelectionRange,
} from "./sheet-renderer.js";

export interface EditorState {
  active: boolean;
  row: number;
  col: number;
  value: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface SheetViewControllerOptions {
  sheet?: number | string;
  readOnly?: boolean;
  onSelectionChange?: (selection: SheetSelectionRange) => void;
  onEditCommit?: (a1: string, raw: string) => void;
}

export class SheetViewController<T extends PoolableElement = PoolableElement> {
  private activeSheet: number | string;
  private selection: SheetSelectionRange = { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 };
  private collaborators: SheetCollaboratorCursor[] = [];
  private editor: EditorState = { active: false, row: 0, col: 0, value: "", rect: { x: 0, y: 0, width: 0, height: 0 } };
  private readonly readOnly: boolean;

  constructor(
    readonly workbook: Workbook,
    readonly renderer: SheetGpuRenderer<T>,
    private readonly options: SheetViewControllerOptions = {},
  ) {
    this.activeSheet = options.sheet ?? 0;
    this.readOnly = Boolean(options.readOnly);
  }

  getActiveSheet(): number | string {
    return this.activeSheet;
  }

  setActiveSheet(sheet: number | string): SheetFrameResult {
    this.cancelEdit();
    this.activeSheet = sheet;
    this.selection = { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 };
    this.renderer.setScroll(0, 0);
    return this.render();
  }

  getSelection(): SheetSelectionRange {
    return { ...this.selection };
  }

  getEditorState(): EditorState {
    return { ...this.editor, rect: { ...this.editor.rect } };
  }

  setCollaborators(cursors: readonly SheetCollaboratorCursor[]): void {
    this.collaborators = [...cursors];
  }

  selectCell(row: number, col: number, extend = false): SheetSelectionRange {
    const proxy = this.workbook.sheet(this.activeSheet);
    const r = Math.max(0, Math.min(proxy.rowCount - 1, row));
    const c = Math.max(0, Math.min(proxy.colCount - 1, col));
    if (extend) {
      this.selection = { ...this.selection, focusRow: r, focusCol: c };
    } else {
      this.selection = { anchorRow: r, anchorCol: c, focusRow: r, focusCol: c };
    }
    this.options.onSelectionChange?.(this.getSelection());
    return this.getSelection();
  }

  moveSelection(dRow: number, dCol: number, extend = false): SheetSelectionRange {
    return this.selectCell(this.selection.focusRow + dRow, this.selection.focusCol + dCol, extend);
  }

  beginEdit(initialOverride?: string): EditorState {
    if (this.readOnly) return this.getEditorState();
    const proxy = this.workbook.sheet(this.activeSheet);
    const ws = this.workbook._getWorksheetById(proxy.id)!;
    const { anchorRow: row, anchorCol: col } = this.selection;
    const a1 = sheetAddress({ row, col });
    const raw = initialOverride !== undefined ? initialOverride : proxy.getCell(a1).raw;
    this.editor = {
      active: true,
      row,
      col,
      value: raw,
      rect: this.renderer.getCellRect(row, col, ws),
    };
    return this.getEditorState();
  }

  updateEditValue(value: string): void {
    if (this.editor.active) this.editor.value = value;
  }

  commitEdit(): boolean {
    if (!this.editor.active) return false;
    const { row, col, value } = this.editor;
    const a1 = sheetAddress({ row, col });
    this.editor.active = false;
    this.workbook.sheet(this.activeSheet).setCell(a1, value);
    this.options.onEditCommit?.(a1, value);
    return true;
  }

  cancelEdit(): void {
    this.editor.active = false;
  }

  resizeRow(row: number, heightPx: number): void {
    this.workbook.sheet(this.activeSheet).setRowHeight(row, heightPx);
  }

  resizeCol(col: number, widthPx: number): void {
    this.workbook.sheet(this.activeSheet).setColWidth(col, widthPx);
  }

  scrollBy(dx: number, dy: number): SheetFrameResult {
    const cur = this.renderer.getScroll();
    this.renderer.setScroll(cur.scrollLeft + dx, cur.scrollTop + dy);
    return this.render();
  }

  handlePointerDown(x: number, y: number, shiftKey = false): SheetSelectionRange | null {
    if (this.editor.active) this.commitEdit();
    const proxy = this.workbook.sheet(this.activeSheet);
    const ws = this.workbook._getWorksheetById(proxy.id)!;
    const hit = this.renderer.pointToCell(x, y, ws);
    if (!hit) return null;
    const sel = this.selectCell(hit.row, hit.col, shiftKey);
    this.render();
    return sel;
  }

  handleKeyDown(key: string, opts?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): boolean {
    const shift = Boolean(opts?.shiftKey);
    const mod = Boolean(opts?.metaKey || opts?.ctrlKey);

    if (mod && key.toLowerCase() === "z") {
      if (shift) this.workbook.redo();
      else this.workbook.undo();
      this.render();
      return true;
    }

    if (this.editor.active) {
      if (key === "Escape") {
        this.cancelEdit();
        return true;
      }
      if (key === "Enter") {
        this.commitEdit();
        this.moveSelection(1, 0);
        this.render();
        return true;
      }
      if (key === "Tab") {
        this.commitEdit();
        this.moveSelection(0, shift ? -1 : 1);
        this.render();
        return true;
      }
      return false;
    }

    switch (key) {
      case "ArrowUp":
        this.moveSelection(-1, 0, shift);
        this.render();
        return true;
      case "ArrowDown":
        this.moveSelection(1, 0, shift);
        this.render();
        return true;
      case "ArrowLeft":
        this.moveSelection(0, -1, shift);
        this.render();
        return true;
      case "ArrowRight":
        this.moveSelection(0, 1, shift);
        this.render();
        return true;
      case "Tab":
        this.moveSelection(0, shift ? -1 : 1, false);
        this.render();
        return true;
      case "Enter":
      case "F2":
        this.beginEdit();
        return true;
      case "Backspace":
      case "Delete":
        if (!this.readOnly) {
          const r1 = Math.min(this.selection.anchorRow, this.selection.focusRow);
          const r2 = Math.max(this.selection.anchorRow, this.selection.focusRow);
          const c1 = Math.min(this.selection.anchorCol, this.selection.focusCol);
          const c2 = Math.max(this.selection.anchorCol, this.selection.focusCol);
          const range = `${sheetAddress({ row: r1, col: c1 })}:${sheetAddress({ row: r2, col: c2 })}`;
          this.workbook.sheet(this.activeSheet).clearRange(range);
          this.render();
        }
        return true;
      default:
        return false;
    }
  }

  render(): SheetFrameResult {
    return this.renderer.render(this.workbook, this.activeSheet, this.selection, this.collaborators);
  }

  dispose(): void {
    this.cancelEdit();
    this.renderer.dispose();
  }
}
