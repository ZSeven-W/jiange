/**
 * SSR-safe Web Component registration helper for `@jiange/sheet-ui`.
 * Registers `<jiange-sheet>` when `customElements` and `HTMLElement` are available;
 * safely returns `false` in Node.js / SSR environments.
 */

import type { Workbook } from "@jiange/sheet-sdk";
import { mountSheetView, type MountedSheetView, type MountSheetViewOptions } from "./mount.js";

export interface JiangeSheetElement extends HTMLElement {
  workbook: Workbook | null;
  options: MountSheetViewOptions;
  readonly mounted: MountedSheetView | null;
}

export function defineSheetElement(tagName = "jiange-sheet"): boolean {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") {
    return false;
  }
  if (customElements.get(tagName)) {
    return true;
  }

  class SheetElement extends HTMLElement implements JiangeSheetElement {
    private _workbook: Workbook | null = null;
    private _options: MountSheetViewOptions = {};
    private _mounted: MountedSheetView | null = null;
    private _mountToken = 0;

    get workbook(): Workbook | null {
      return this._workbook;
    }

    set workbook(value: Workbook | null) {
      this._workbook = value;
      this._remount();
    }

    get options(): MountSheetViewOptions {
      return this._options;
    }

    set options(value: MountSheetViewOptions) {
      this._options = value;
      this._remount();
    }

    get mounted(): MountedSheetView | null {
      return this._mounted;
    }

    connectedCallback(): void {
      this._remount();
    }

    disconnectedCallback(): void {
      this._mountToken++;
      this._mounted?.dispose();
      this._mounted = null;
    }

    private _remount(): void {
      const token = ++this._mountToken;
      this._mounted?.dispose();
      this._mounted = null;
      if (!this.isConnected || !this._workbook) return;
      void mountSheetView(this, this._workbook, this._options).then((view) => {
        if (token !== this._mountToken) {
          view.dispose();
          return;
        }
        this._mounted = view;
      });
    }
  }

  customElements.define(tagName, SheetElement);
  return true;
}
