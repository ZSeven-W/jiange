/**
 * SSR-safe Web Component registration helper for `@jiange/base-ui`.
 * Registers `<jiange-base>` when `customElements` and `HTMLElement` are available;
 * safely returns `false` in Node.js / SSR environments.
 */

import type { Base } from "@jiange/base-sdk";
import { mountBaseView, type BaseViewOptions, type MountedBaseView } from "./base-view.js";

export interface JiangeBaseElement extends HTMLElement {
  base: Base | null;
  options: BaseViewOptions;
  readonly mounted: MountedBaseView | null;
}

export function defineBaseElement(tagName = "jiange-base"): boolean {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") {
    return false;
  }
  if (customElements.get(tagName)) {
    return true;
  }

  class BaseElement extends HTMLElement implements JiangeBaseElement {
    private _base: Base | null = null;
    private _options: BaseViewOptions = {};
    private _mounted: MountedBaseView | null = null;
    private _mountToken = 0;

    get base(): Base | null {
      return this._base;
    }

    set base(value: Base | null) {
      this._base = value;
      this._remount();
    }

    get options(): BaseViewOptions {
      return this._options;
    }

    set options(value: BaseViewOptions) {
      this._options = value;
      this._remount();
    }

    get mounted(): MountedBaseView | null {
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
      if (!this.isConnected || !this._base) return;
      void mountBaseView(this, this._base, this._options).then((view) => {
        if (token !== this._mountToken) {
          view.dispose();
          return;
        }
        this._mounted = view;
      });
    }
  }

  customElements.define(tagName, BaseElement);
  return true;
}
