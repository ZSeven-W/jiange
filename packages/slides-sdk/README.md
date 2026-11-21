# @jiange/slides-sdk

Headless types, geometry, and OOXML PresentationML (`.pptx`) utilities used by Jiange slides: page ordering, visibility, layout, zoom, shape geometry, ordering, line endpoints, and bounded `.pptx` export/import (`exportSlidesToPptx`, `parsePptxToSlides` over `@jiange/ooxml`). It does not contain UI, transport, realtime collaboration, animations, or embedded media/chart PPTX fidelity.

Build `@jiange/ooxml` first, then `pnpm --filter @jiange/slides-sdk build`; `pnpm pack` emits ESM and TypeScript declarations. The package remains private.

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See `LICENSE` (bundled in the package archive; repository root `LICENSE`) for full terms.
