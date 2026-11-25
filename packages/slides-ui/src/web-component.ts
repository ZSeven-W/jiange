/**
 * SSR-safe Web Component registration helper for `@zseven-w/slides-ui`.
 * Registers `<jiange-slides>` when `customElements` and `HTMLElement` are available;
 * safely returns `false` in Node.js / SSR environments.
 */

import type { Presentation } from "@zseven-w/slides-sdk";
import { mountSlidesView, type MountedSlidesView, type SlidesViewOptions } from "./slides-view.js";

export interface JiangeSlidesElement extends HTMLElement {
  presentation: Presentation | null;
  options: SlidesViewOptions;
  readonly mounted: MountedSlidesView | null;
}

export function defineSlidesElement(tagName = "jiange-slides"): boolean {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") {
    return false;
  }
  if (customElements.get(tagName)) {
    return true;
  }

  class SlidesElement extends HTMLElement implements JiangeSlidesElement {
    private _presentation: Presentation | null = null;
    private _options: SlidesViewOptions = {};
    private _mounted: MountedSlidesView | null = null;
    private _mountToken = 0;

    get presentation(): Presentation | null {
      return this._presentation;
    }

    set presentation(value: Presentation | null) {
      this._presentation = value;
      this._remount();
    }

    get options(): SlidesViewOptions {
      return this._options;
    }

    set options(value: SlidesViewOptions) {
      this._options = value;
      this._remount();
    }

    get mounted(): MountedSlidesView | null {
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
      if (!this.isConnected || !this._presentation) return;
      void mountSlidesView(this, this._presentation, this._options).then((view) => {
        if (token !== this._mountToken) {
          view.dispose();
          return;
        }
        this._mounted = view;
      });
    }
  }

  customElements.define(tagName, SlidesElement);
  return true;
}
