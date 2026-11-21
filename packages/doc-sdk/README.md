# @jiange/doc-sdk

Headless document editing operations over `@jiange/collab`: block selection, text editing, formatting, split/join, table properties & cell rich text, column width and move models, clipboard, Markdown, and bounded DOCX byte import/export (including headings H1–H9, tables, merges, images, comments, footnotes, headers/footers, and page numbers). No React, DOM, transport, storage or permission enforcement is included; parsing compressed Word files requires a host with `DecompressionStream("deflate-raw")`.

`@jiange/doc-sdk` is decoupled from `@jiange/whiteboard-sdk` (flowchart blocks export to Mermaid via a built-in zero-dep converter or an optional `renderFlowchart` hook). Build `@jiange/collab` and `@jiange/ooxml` first, then run `pnpm --filter @jiange/doc-sdk build`.

The `@jiange/doc-sdk/column-archive-experimental` subpath contains an unstable identity-preserving column archive model. Its plans do not perform network writes, verify receipts, enforce permissions or persist recovery handles; hosts must supply those guarantees and scope any stored data to the current account and document.

## License

Free for personal and commercial use. If an enterprise modifies or creates derivative works from this SDK, it must publicly attribute Jiange SDK (`https://github.com/ZSeven-W/jiange`) as the source. See `LICENSE` (bundled in the package archive; repository root `LICENSE`) for full terms.
