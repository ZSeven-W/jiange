/**
 * SSR-safe Web Component registration helper for `@jiange/whiteboard-ui`.
 * Registers `<jiange-whiteboard>` when `customElements` and `HTMLElement` are available;
 * safely returns `false` in Node.js / SSR environments.
 */

import type { Board } from "@jiange/whiteboard-sdk";
import { mountWhiteboardView, type MountedWhiteboardView, type WhiteboardViewOptions } from "./whiteboard-view.js";

export interface JiangeWhiteboardElement extends HTMLElement {
  board: Board | null;
  options: WhiteboardViewOptions;
  readonly mounted: MountedWhiteboardView | null;
}

export function defineWhiteboardElement(tagName = "jiange-whiteboard"): boolean {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") {
    return false;
  }
  if (customElements.get(tagName)) {
    return true;
  }

  class WhiteboardElement extends HTMLElement implements JiangeWhiteboardElement {
    private _board: Board | null = null;
    private _options: WhiteboardViewOptions = {};
    private _mounted: MountedWhiteboardView | null = null;
    private _mountToken = 0;

    get board(): Board | null {
      return this._board;
    }

    set board(value: Board | null) {
      this._board = value;
      this._remount();
    }

    get options(): WhiteboardViewOptions {
      return this._options;
    }

    set options(value: WhiteboardViewOptions) {
      this._options = value;
      this._remount();
    }

    get mounted(): MountedWhiteboardView | null {
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
      if (!this.isConnected || !this._board) return;
      void mountWhiteboardView(this, this._board, this._options).then((view) => {
        if (token !== this._mountToken) {
          view.dispose();
          return;
        }
        this._mounted = view;
      });
    }
  }

  customElements.define(tagName, WhiteboardElement);
  return true;
}
