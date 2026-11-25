# @zseven-w/sheet-ui

Standalone high-performance Spreadsheet UI (`v0.2.0`) powered by **WebGPU / WebGL2** (`@zseven-w/render-gpu`) and a **4-quadrant pooled 2D virtual grid** over `@zseven-w/sheet-sdk`.

**Zero HTML5 Canvas 2D usage.** Independently installable without Doc, Slides, Whiteboard, or Base.

## Install

```bash
npm install @zseven-w/sheet-ui @zseven-w/sheet-sdk
```

- **Runtime dependencies**: `@zseven-w/sheet-sdk`, `@zseven-w/render-gpu`
- **Optional peer dependencies**: `react >= 18` (only needed when using `@zseven-w/sheet-ui/react`)
- **Bundle size**: ~7.4 KB gzip

## Features

- **4-Quadrant Frozen-Pane GPU Rendering**: Scissor-clipped WebGPU/WebGL2 passes for cell fills, borders, headers, selection marquee, collaborator cursors, and GPU-rendered embedded charts.
- **Pooled Virtual Text Layer + Singleton IME Editor**: Fixed DOM node pool recycled via `translate3d(...)` with a single floating `<input>` editor for crisp CJK/IME input and accessibility.
- **Framework-Agnostic Embedding**: Vanilla `mountSheetView`, zero-bundle-cost React factory (`@zseven-w/sheet-ui/react`), and SSR-safe `<jiange-sheet>` Web Component (`defineSheetElement`).

## Quickstart

### 1. Vanilla JS / TS (`mountSheetView`)

```ts
import { Workbook } from "@zseven-w/sheet-sdk";
import { mountSheetView } from "@zseven-w/sheet-ui";

const wb = Workbook.fromCsv("Region,Q1,Q2\nNorth,120,150\nSouth,90,130\n", "Sales");
const view = await mountSheetView(document.getElementById("sheet-root")!, wb, {
  sheet: "Sales",
});

// Resize or unmount cleanly
view.resize(1024, 600);
// view.dispose();
```

### 2. React Adapter (`@zseven-w/sheet-ui/react`)

```tsx
import * as React from "react";
import { Workbook } from "@zseven-w/sheet-sdk";
import { createSheetViewComponent } from "@zseven-w/sheet-ui/react";

const SheetView = createSheetViewComponent(React);

export function App({ workbook }: { workbook: Workbook }) {
  return <SheetView workbook={workbook} sheet="Sales" width={1024} height={600} />;
}
```

### 3. Web Component (`<jiange-sheet>`)

```ts
import { Workbook } from "@zseven-w/sheet-sdk";
import { defineSheetElement, type JiangeSheetElement } from "@zseven-w/sheet-ui";

defineSheetElement(); // Registers <jiange-sheet> (returns false safely in SSR/Node)
const el = document.createElement("jiange-sheet") as JiangeSheetElement;
el.style.cssText = "display:block;width:100%;height:600px;";
el.workbook = Workbook.create({ sheets: [{ name: "Sheet1" }] });
document.body.appendChild(el);
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@zseven-w/sheet-ui` | `mountSheetView`, `SheetViewController`, `SheetGpuRenderer`, `createSheetViewComponent`, `defineSheetElement` |
| `@zseven-w/sheet-ui/mount` | `mountSheetView`, `MountSheetViewOptions`, `MountedSheetView` |
| `@zseven-w/sheet-ui/controller` | `SheetViewController`, `SheetViewControllerOptions`, `EditorState` |
| `@zseven-w/sheet-ui/renderer` | `SheetGpuRenderer`, `SheetRenderTheme`, `SheetSelectionRange`, `SheetFrameResult` |
| `@zseven-w/sheet-ui/react` | `createSheetViewComponent`, `SheetViewProps`, `ReactLike` |

## Documentation

Full UI embedding guide and interactive UI Playground instructions are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/gpu-ui-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
