# @jiange/doc-ui

Lightweight virtual-list block Document UI (`v0.2.0`) built on `@jiange/render-gpu` (`VirtualList1D` + `FenwickVirtualizer`) over `@jiange/doc-sdk`.

**Zero HTML5 Canvas 2D usage.** Renders 5,000+ block documents with a constant DOM pool (`< 120` nodes) and `O(log N)` dynamic block-height tracking.

## Install

```bash
npm install @jiange/doc-ui @jiange/doc-sdk
```

- **Runtime dependencies**: `@jiange/doc-sdk`, `@jiange/render-gpu`
- **Optional peer dependencies**: `react >= 18` (only needed when using `@jiange/doc-ui/react`)
- **Bundle size**: ~2.8 KB gzip

## Features

- **`VirtualList1D` + Dynamic Height Feedback**: `reportBlockHeight(blockId, heightPx)` feeds `ResizeObserver` measurements into the sparse Fenwick tree in `O(log N)`.
- **Outline Navigation & Keyboard Editing**: `jumpToHeading(headingIdOrText)`, block focus/insert/delete, and `Ctrl/Cmd+Z` / `Shift+Z` undo/redo wired directly to `Document`.
- **Framework-Agnostic Embedding**: Synchronous Vanilla `mountDocView`, React factory (`@jiange/doc-ui/react`), and SSR-safe `<jiange-doc>` Web Component (`defineDocElement`).

## Quickstart

### 1. Vanilla JS / TS (`mountDocView`)

```ts
import { Document } from "@jiange/doc-sdk";
import { mountDocView } from "@jiange/doc-ui";

const doc = Document.fromMarkdown("# Welcome\n\n## Architecture\n\nVirtualized block rendering.\n");
const view = mountDocView(document.getElementById("doc-root")!, doc, {
  onActiveBlockChange: (id) => console.log("Active block:", id),
});

view.controller.jumpToHeading("Architecture");
// view.dispose();
```

### 2. React Adapter (`@jiange/doc-ui/react`)

```tsx
import * as React from "react";
import { Document } from "@jiange/doc-sdk";
import { createDocViewComponent } from "@jiange/doc-ui/react";

const DocView = createDocViewComponent(React);

export function App({ doc }: { doc: Document }) {
  return <DocView document={doc} width={800} height={600} />;
}
```

### 3. Web Component (`<jiange-doc>`)

```ts
import { Document } from "@jiange/doc-sdk";
import { defineDocElement, type JiangeDocElement } from "@jiange/doc-ui";

defineDocElement(); // Registers <jiange-doc> (returns false safely in SSR/Node)
const el = document.createElement("jiange-doc") as JiangeDocElement;
el.style.cssText = "display:block;width:100%;height:600px;";
el.document = Document.fromMarkdown("# Hello Jiange Doc\n");
document.body.appendChild(el);
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@jiange/doc-ui` | `mountDocView`, `DocViewController`, `createDocViewComponent`, `defineDocElement` |
| `@jiange/doc-ui/doc-view` | `mountDocView`, `DocViewController`, `DocViewOptions`, `DocFrameResult`, `MountedDocView` |
| `@jiange/doc-ui/react` | `createDocViewComponent`, `DocViewProps`, `DocReactLike` |

## Documentation

Full UI embedding guide and interactive UI Playground instructions are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/gpu-ui-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
