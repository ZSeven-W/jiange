/**
 * SSR-safe Web Component registration helper for `@zseven-w/doc-ui`.
 * Registers `<jiange-doc>` when `customElements` and `HTMLElement` are available;
 * safely returns `false` in Node.js / SSR environments.
 */

import type { Document } from "@zseven-w/doc-sdk";
import { mountDocView, type DocViewOptions, type MountedDocView } from "./doc-view.js";

export interface JiangeDocElement extends HTMLElement {
  document: Document | null;
  options: DocViewOptions;
  readonly mounted: MountedDocView | null;
}

export function defineDocElement(tagName = "jiange-doc"): boolean {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") {
    return false;
  }
  if (customElements.get(tagName)) {
    return true;
  }

  class DocElement extends HTMLElement implements JiangeDocElement {
    private _document: Document | null = null;
    private _options: DocViewOptions = {};
    private _mounted: MountedDocView | null = null;

    get document(): Document | null {
      return this._document;
    }

    set document(value: Document | null) {
      this._document = value;
      this._remount();
    }

    get options(): DocViewOptions {
      return this._options;
    }

    set options(value: DocViewOptions) {
      this._options = value;
      this._remount();
    }

    get mounted(): MountedDocView | null {
      return this._mounted;
    }

    connectedCallback(): void {
      this._remount();
    }

    disconnectedCallback(): void {
      this._mounted?.dispose();
      this._mounted = null;
    }

    private _remount(): void {
      this._mounted?.dispose();
      this._mounted = null;
      if (!this.isConnected || !this._document) return;
      this._mounted = mountDocView(this, this._document, this._options);
    }
  }

  customElements.define(tagName, DocElement);
  return true;
}
