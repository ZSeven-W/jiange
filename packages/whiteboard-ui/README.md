# @jiange/whiteboard-ui

Standalone WebGPU / WebGL2 infinite canvas (`v0.2.0`) with `SpatialIndex` frustum culling for flowcharts, mind maps, and freehand ink over `@jiange/whiteboard-sdk` and `@jiange/render-gpu`.

**Zero HTML5 Canvas 2D usage.**

## Install

```bash
npm install @jiange/whiteboard-ui @jiange/whiteboard-sdk
```

- **Runtime dependencies**: `@jiange/whiteboard-sdk`, `@jiange/render-gpu`
- **Optional peer dependencies**: `react >= 18` (only needed when using `@jiange/whiteboard-ui/react`)
- **Bundle size**: ~4.5 KB gzip

## Features

- **Infinite Canvas Camera + `SpatialIndex` Frustum Culling**: Smooth pan/zoom (`Camera2D`) with `O(1)` spatial hash culling capable of handling `10,000+` nodes and edges at 60–120 fps.
- **GPU SDF Primitives + Pooled Label Overlay**: Hardware-accelerated SDF nodes, edges, mind-map branches, and ink strokes paired with recycled DOM text labels.
- **Framework-Agnostic Embedding**: Vanilla `mountWhiteboardView`, React factory (`@jiange/whiteboard-ui/react`), and SSR-safe `<jiange-whiteboard>` Web Component (`defineWhiteboardElement`).

## Quickstart

### 1. Vanilla JS / TS (`mountWhiteboardView`)

```ts
import { Board } from "@jiange/whiteboard-sdk";
import { mountWhiteboardView } from "@jiange/whiteboard-ui";

const board = Board.fromMermaid("flowchart LR\n  A[Client] --> B[Gateway] --> C[Engine]\n");
board.autoLayout({ direction: "LR" });

const view = await mountWhiteboardView(document.getElementById("board-root")!, board);
view.resize(1024, 640);
// view.dispose();
```

### 2. React Adapter (`@jiange/whiteboard-ui/react`)

```tsx
import * as React from "react";
import { Board } from "@jiange/whiteboard-sdk";
import { createWhiteboardViewComponent } from "@jiange/whiteboard-ui/react";

const WhiteboardView = createWhiteboardViewComponent(React);

export function App({ board }: { board: Board }) {
  return <WhiteboardView board={board} width={1024} height={640} />;
}
```

### 3. Web Component (`<jiange-whiteboard>`)

```ts
import { Board } from "@jiange/whiteboard-sdk";
import { defineWhiteboardElement, type JiangeWhiteboardElement } from "@jiange/whiteboard-ui";

defineWhiteboardElement(); // Registers <jiange-whiteboard> (returns false safely in SSR/Node)
const el = document.createElement("jiange-whiteboard") as JiangeWhiteboardElement;
el.style.cssText = "display:block;width:100%;height:640px;";
el.board = Board.fromMermaid("flowchart TD\n  Start --> End\n");
document.body.appendChild(el);
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@jiange/whiteboard-ui` | `mountWhiteboardView`, `WhiteboardViewController`, `createWhiteboardViewComponent`, `defineWhiteboardElement` |
| `@jiange/whiteboard-ui/whiteboard-view` | `mountWhiteboardView`, `WhiteboardViewController`, `WhiteboardViewOptions`, `WhiteboardFrameResult`, `MountedWhiteboardView` |
| `@jiange/whiteboard-ui/react` | `createWhiteboardViewComponent`, `WhiteboardViewProps`, `WhiteboardReactLike` |

## Documentation

Full UI embedding guide and interactive UI Playground instructions are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/gpu-ui-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
