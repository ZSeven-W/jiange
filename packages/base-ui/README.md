# @jiange/base-ui

Standalone WebGPU / WebGL2 + pooled virtual **Grid / Kanban / Gantt / Dashboard** UI (`v0.2.0`) over `@jiange/base-sdk` and `@jiange/render-gpu`.

**Zero HTML5 Canvas 2D usage.** Scrolls `100,000+` multidimensional Base records at `< 0.1 ms/frame` JS cost.

## Install

```bash
npm install @jiange/base-ui @jiange/base-sdk
```

- **Runtime dependencies**: `@jiange/base-sdk`, `@jiange/render-gpu`
- **Optional peer dependencies**: `react >= 18` (only needed when using `@jiange/base-ui/react`)
- **Bundle size**: ~4.3 KB gzip

## Features

- **4 GPU-Accelerated View Modes (`BaseRenderMode`)**:
  - `grid`: Pooled 2D virtual grid with conditional row fills (`setFills`) and inline cell updates (`updateCell`).
  - `kanban`: Grouped column cards rendered via GPU SDF batches.
  - `gantt`: Timeline bars driven by GPU instanced rectangles.
  - `dashboard`: Metric cards, bar/line/pie charts using GPU Rect/Line/Arc pipelines.
- **Framework-Agnostic Embedding**: Vanilla `mountBaseView`, React factory (`@jiange/base-ui/react`), and SSR-safe `<jiange-base>` Web Component (`defineBaseElement`).

## Quickstart

### 1. Vanilla JS / TS (`mountBaseView`)

```ts
import { Base } from "@jiange/base-sdk";
import { mountBaseView } from "@jiange/base-ui";

const base = Base.create({ name: "CRM" });
base.addRecord(undefined, { Name: "Acme Corp" });

const view = await mountBaseView(document.getElementById("base-root")!, base, {
  mode: "grid",
});

view.controller.setMode("kanban");
// view.dispose();
```

### 2. React Adapter (`@jiange/base-ui/react`)

```tsx
import * as React from "react";
import { Base } from "@jiange/base-sdk";
import { createBaseViewComponent } from "@jiange/base-ui/react";

const BaseView = createBaseViewComponent(React);

export function App({ base }: { base: Base }) {
  return <BaseView base={base} mode="grid" width={1024} height={640} />;
}
```

### 3. Web Component (`<jiange-base>`)

```ts
import { Base } from "@jiange/base-sdk";
import { defineBaseElement, type JiangeBaseElement } from "@jiange/base-ui";

defineBaseElement(); // Registers <jiange-base> (returns false safely in SSR/Node)
const el = document.createElement("jiange-base") as JiangeBaseElement;
el.style.cssText = "display:block;width:100%;height:640px;";
el.base = Base.create({ name: "CRM" });
el.options = { mode: "grid" };
document.body.appendChild(el);
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@jiange/base-ui` | `mountBaseView`, `BaseViewController`, `createBaseViewComponent`, `defineBaseElement` |
| `@jiange/base-ui/base-view` | `mountBaseView`, `BaseViewController`, `BaseRenderMode`, `BaseViewOptions`, `BaseFrameResult`, `MountedBaseView` |
| `@jiange/base-ui/react` | `createBaseViewComponent`, `BaseViewProps`, `BaseReactLike` |

## Documentation

Full UI embedding guide and interactive UI Playground instructions are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/gpu-ui-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
