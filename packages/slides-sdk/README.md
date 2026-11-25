# @zseven-w/slides-sdk

AI-native headless Presentation & PPTX SDK (`v0.2.0`) over `@zseven-w/ooxml`: structured `Presentation` Facade, themes, rich text paragraphs, native tables, charts, embedded media, DEFLATE `.pptx` import/export, deterministic pure-TS 16:9 SVG rendering, visual layout auditing (`verify()`), and self-describing AI tools.

## Install

```bash
npm install @zseven-w/slides-sdk
```

- **Runtime dependencies**: `@zseven-w/ooxml` (0 third-party dependencies)
- **Bundle size**: ~25.8 KB gzip

## Features

- **`Presentation` Facade**: `Presentation.create`, `fromPages`, `fromPptx`, slide CRUD/duplicate/move, shape CRUD, `setTheme`, `addMedia`, `undo()`/`redo()`, token-budgeted `inspect()`, `query()`, and atomic `apply(ops, { dryRun })`.
- **Rich Deck Model**: 21 shape kinds (primitives, arrows, lines, text, `image`, native `table`, `chart`), multi-paragraph rich runs (`SlideTextParagraph`), transitions (`fade`, `push`, `wipe`), speaker notes, hidden slides, and media assets (`SlideMediaAsset`).
- **OOXML `.pptx` Round-Trip**: Sync `toPptx` / `exportSlidesToPptx` and async DEFLATE `toPptxAsync` / `exportSlidesToPptxAsync`, plus `parsePptxToSlides` supporting tables, embedded media, rich paragraphs, and theme colors.
- **Zero-DOM 16:9 SVG Renderer**: `renderSvg(slideIndex)` / `renderAllSvg()` (`renderSlideToSvg` / `renderDeckToSvg`) produce deterministic SVGs suitable for server-side thumbnails or multimodal AI visual checks.
- **Visual Layout Diagnostics (`verify()`)**: Detects `EMPTY_DECK`, `EMPTY_SLIDE`, `TEXT_OVERFLOW`, `SHAPE_OVERLAP`, `OUT_OF_BOUNDS`, `LOW_CONTRAST` (WCAG), `MISSING_MEDIA`, and `DUPLICATE_SHAPE_ID` with actionable repair suggestions.
- **Self-Describing AI Toolkit (`createSlidesTools`)**: 7 JSON-Schema tools (`slides_inspect`, `slides_query`, `slides_apply`, `slides_verify`, `slides_render_svg`, `slides_undo`, `slides_redo`).

## Quickstart

```ts
import { Presentation, createSlidesTools } from "@zseven-w/slides-sdk";

const deck = Presentation.create({ title: "Q4 Product Review" });
const tools = createSlidesTools(deck);

tools.execute("slides_apply", {
  ops: [
    {
      op: "addSlide",
      slide: {
        title: "Revenue Highlights",
        body: "ARR grew 142% YoY with zero downtime.",
        layout: "title",
        notes: "Highlight enterprise expansion.",
      },
    },
  ],
});

const diagnostics = deck.verify();
const svg = deck.renderSvg(0);
const pptxBytes = await deck.toPptxAsync();
void [diagnostics, svg, pptxBytes];
```

## Subpath Exports

| Subpath | Contents |
| --- | --- |
| `@zseven-w/slides-sdk` | Full barrel export (`Presentation`, `createSlidesTools`, PPTX, SVG, geometry & ordering helpers) |
| `@zseven-w/slides-sdk/deck` | `Presentation`, `SlideOp`, `SlideDiagnostic`, `SlideInspectResult`, `SlideApplyResult` |
| `@zseven-w/slides-sdk/ai-tools` | `createSlidesTools` |
| `@zseven-w/slides-sdk/pptx` | `exportSlidesToPptx`, `exportSlidesToPptxAsync`, `parsePptxToSlides`, `PptxError` |
| `@zseven-w/slides-sdk/svg` | `renderSlideToSvg`, `renderDeckToSvg` |
| `@zseven-w/slides-sdk/shape-state` / `./shape-order` / `./shape-resize` / `./line-endpoints` | Shape state, z-order (`moveShapeOrder`), resize math, line endpoints (`slideLineEndpoints`) |
| `@zseven-w/slides-sdk/order` / `./layout` / `./visibility` / `./zoom` | Slide ordering, layout presets, visibility toggles, zoom utilities |

## Documentation

Full SDK documentation and AI workflows are available at [`https://github.com/ZSeven-W/jiange`](https://github.com/ZSeven-W/jiange) (see `sdk-docs/headless-sdks.md`).

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See the bundled `LICENSE` file (repository root `LICENSE`) for full terms.
