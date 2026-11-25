# @zseven-w/slides-ui

Standalone WebGPU / WebGL2 SDF Presentation stage + virtualized thumbnail rail (`v0.2.0`) over `@zseven-w/slides-sdk` and `@zseven-w/render-gpu`.

**Zero HTML5 Canvas 2D usage.**

## Install

```bash
npm install @zseven-w/slides-ui @zseven-w/slides-sdk
```

- **Runtime dependencies**: `@zseven-w/slides-sdk`, `@zseven-w/render-gpu`
- **Optional peer dependencies**: `react >= 18` (only needed when using `@zseven-w/slides-ui/react`)
- **Bundle size**: ~4.2 KB gzip

## Features

- **GPU SDF 16:9 Stage**: Centered 16:9 stage rendering slide backgrounds, vector shapes, lines, selection bounds, and 4-corner resize handles via `@zseven-w/render-gpu`.
- **Virtualized Thumbnail Rail & Presenter Mode**: Pooled `VirtualList1D` thumbnail rail, slide navigation (`goToSlide`, `nextSlide`, `prevSlide`), and `setPresenterMode(true)`.
- **Framework-Agnostic Embedding**: Vanilla `mountSlidesView`, React factory (`@zseven-w/slides-ui/react`), and SSR-safe `<jiange-slides>` Web Component (`defineSlidesElement`).

## Quickstart

### 1. Vanilla JS / TS (`mountSlidesView`)

```ts
import { Presentation } from "@zseven-w/slides-sdk";
import { mountSlidesView } from "@zseven-w/slides-ui";

const deck = Presentation.create({ title: "Q4 Keynote" });
const view = await mountSlidesView(document.getElementById("slides-root")!, deck, {
  initialSlide: 0,
  onSlideChange: (idx) => console.log("Slide:", idx),
});

view.controller.setPresenterMode(false);
// view.dispose();
```

### 2. React Adapter (`@zseven-w/slides-ui/react`)

```tsx
import * as React from "react";
import { Presentation } from "@zseven-w/slides-sdk";
import { createSlidesViewComponent } from "@zseven-w/slides-ui/react";

const SlidesView = createSlidesViewComponent(React);

export function App({ deck }: { deck: Presentation }) {
  return <SlidesView presentation={deck} width={960} height={540} />;
}
```

### 3. Web Component (`<jiange-slides>`)

```ts
import { Presentation } from "@zseven-w/slides-sdk";
import { defineSlidesElement, type JiangeSlidesElement } from "@zseven-w/slides-ui";

defineSlidesElement(); // Registers <jiange-slides> (returns false safely in SSR/Node)
const el = document.createElement("jiange-slides") as JiangeSlidesElement;
el.style.cssText = "display:block;width:100%;height:540px;";
el.presentation = Presentation.create({ title: "Q4 Keynote" });
document.body.appendChild(el);
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@zseven-w/slides-ui` | `mountSlidesView`, `SlidesViewController`, `createSlidesViewComponent`, `defineSlidesElement` |
| `@zseven-w/slides-ui/slides-view` | `mountSlidesView`, `SlidesViewController`, `SlidesViewOptions`, `SlidesFrameResult`, `MountedSlidesView` |
| `@zseven-w/slides-ui/react` | `createSlidesViewComponent`, `SlidesViewProps`, `SlidesReactLike` |

## Documentation

Full UI embedding guide and interactive UI Playground instructions are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/gpu-ui-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
